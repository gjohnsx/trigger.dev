import {
  ErrorWithMessage,
  ErrorWithStackSchema,
  GetEndpointDataResponse,
  HandleTriggerSource,
  HttpSourceRequest,
  HttpSourceRequestHeadersSchema,
  InitializeTriggerBodySchema,
  LogLevel,
  Logger,
  NormalizedRequest,
  NormalizedResponse,
  PreprocessRunBody,
  PreprocessRunBodySchema,
  REGISTER_SOURCE_EVENT,
  RegisterSourceEvent,
  RegisterSourceEventSchema,
  RegisterTriggerBody,
  RunJobBody,
  RunJobBodySchema,
  ScheduleMetadata,
  SendEvent,
  SendEventOptions,
  SourceMetadata,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import { IO, ResumeWithTask } from "./io";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { Job } from "./job";
import { EventTrigger } from "./triggers/eventTrigger";
import { ExternalSource, HttpSourceEvent } from "./triggers/externalSource";
import type {
  EventSpecification,
  Trigger,
  TriggerContext,
  TriggerPreprocessContext,
} from "./types";
import { DynamicTrigger } from "./triggers/dynamic";

const registerSourceEvent: EventSpecification<RegisterSourceEvent> = {
  name: REGISTER_SOURCE_EVENT,
  title: "Register Source",
  source: "internal",
  icon: "register-source",
  parsePayload: RegisterSourceEventSchema.parse,
};

export type TriggerClientOptions = {
  apiKey?: string;
  apiUrl?: string;
  endpoint?: string;
  path?: string;
  logLevel?: LogLevel;
};

export type ListenOptions = {
  url: string;
};

export class TriggerClient {
  #options: TriggerClientOptions;
  #registeredJobs: Record<string, Job<Trigger<EventSpecification<any>>, any>> =
    {};
  #registeredSources: Record<string, SourceMetadata> = {};
  #registeredHttpSourceHandlers: Record<
    string,
    (
      source: HandleTriggerSource,
      request: HttpSourceEvent
    ) => Promise<{
      events: Array<SendEvent>;
      response?: NormalizedResponse;
    } | void>
  > = {};
  #registeredDynamicTriggers: Record<
    string,
    DynamicTrigger<EventSpecification<any>, ExternalSource<any, any, any>>
  > = {};
  #jobMetadataByDynamicTriggers: Record<
    string,
    Array<{ id: string; version: string }>
  > = {};
  #registeredSchedules: Record<string, Array<{ id: string; version: string }>> =
    {};

  #client: ApiClient;
  #logger: Logger;
  name: string;
  endpoint: string;

  constructor(name: string, options: TriggerClientOptions) {
    this.name = name;
    this.endpoint = options.endpoint ?? buildEndpointUrl(options.path);
    this.#options = options;
    this.#client = new ApiClient(this.#options);
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  async handleRequest(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.#logger.debug("handling request", { request });

    const apiKey = request.headers["x-trigger-api-key"];

    if (!this.authorized(apiKey)) {
      return {
        status: 401,
        body: {
          message: "Unauthorized",
        },
      };
    }

    if (request.method === "GET") {
      const action = request.headers["x-trigger-action"];

      if (action === "PING") {
        return {
          status: 200,
          body: {
            message: "PONG",
          },
        };
      }

      // if the x-trigger-job-id header is set, we return the job with that id
      if (request.headers["x-trigger-job-id"]) {
        const job = this.#registeredJobs[request.headers["x-trigger-job-id"]];

        if (!job) {
          return {
            status: 404,
            body: {
              message: "Job not found",
            },
          };
        }

        return {
          status: 200,
          body: job.toJSON(),
        };
      }

      const body: GetEndpointDataResponse = {
        jobs: Object.values(this.#registeredJobs).map((job) => job.toJSON()),
        sources: Object.values(this.#registeredSources),
        dynamicTriggers: Object.values(this.#registeredDynamicTriggers).map(
          (trigger) => ({
            id: trigger.id,
            jobs: this.#jobMetadataByDynamicTriggers[trigger.id] ?? [],
          })
        ),
        dynamicSchedules: Object.entries(this.#registeredSchedules).map(
          ([id, jobs]) => ({
            id,
            jobs,
          })
        ),
      };

      // if the x-trigger-job-id header is not set, we return all jobs
      return {
        status: 200,
        body,
      };
    }

    if (request.method === "POST") {
      // Get the action from the headers
      const action = request.headers["x-trigger-action"];

      switch (action) {
        case "INITIALIZE": {
          await this.listen();

          return {
            status: 200,
            body: {
              message: "Initialized",
            },
          };
        }
        case "INITIALIZE_TRIGGER": {
          const body = InitializeTriggerBodySchema.safeParse(request.body);

          if (!body.success) {
            return {
              status: 400,
              body: {
                message: "Invalid trigger body",
              },
            };
          }

          const dynamicTrigger = this.#registeredDynamicTriggers[body.data.id];

          if (!dynamicTrigger) {
            return {
              status: 404,
              body: {
                message: "Dynamic trigger not found",
              },
            };
          }

          return {
            status: 200,
            body: dynamicTrigger.registeredTriggerForParams(body.data.params),
          };
        }
        case "EXECUTE_JOB": {
          const execution = RunJobBodySchema.safeParse(request.body);

          if (!execution.success) {
            return {
              status: 400,
              body: {
                message: "Invalid execution",
              },
            };
          }

          const job = this.#registeredJobs[execution.data.job.id];

          if (!job) {
            return {
              status: 404,
              body: {
                message: "Job not found",
              },
            };
          }

          const results = await this.#executeJob(execution.data, job);

          if (results.error) {
            return {
              status: 500,
              body: results.error,
            };
          }

          return {
            status: 200,
            body: {
              completed: results.completed,
              output: results.output,
              executionId: execution.data.run.id,
              task: results.task,
            },
          };
        }
        case "PREPROCESS_RUN": {
          const body = PreprocessRunBodySchema.safeParse(request.body);

          if (!body.success) {
            return {
              status: 400,
              body: {
                message: "Invalid body",
              },
            };
          }

          const job = this.#registeredJobs[body.data.job.id];

          if (!job) {
            return {
              status: 404,
              body: {
                message: "Job not found",
              },
            };
          }

          const results = await this.#preprocessRun(body.data, job);

          return {
            status: 200,
            body: {
              abort: results.abort,
              elements: results.elements,
            },
          };
        }
        case "DELIVER_HTTP_SOURCE_REQUEST": {
          const headers = HttpSourceRequestHeadersSchema.safeParse(
            request.headers
          );

          if (!headers.success) {
            return {
              status: 400,
              body: {
                message: "Invalid headers",
              },
            };
          }

          const sourceRequest = {
            url: headers.data["x-ts-http-url"],
            method: headers.data["x-ts-http-method"],
            headers: headers.data["x-ts-http-headers"],
            rawBody: request.body,
          };

          const key = headers.data["x-ts-key"];
          const dynamicId = headers.data["x-ts-dynamic-id"];
          const secret = headers.data["x-ts-secret"];
          const params = headers.data["x-ts-params"];
          const data = headers.data["x-ts-data"];

          const source = {
            key,
            dynamicId,
            secret,
            params,
            data,
          };

          const { response, events } = await this.#handleHttpSourceRequest(
            source,
            sourceRequest
          );

          return {
            status: 200,
            body: {
              events,
              response,
            },
          };
        }
      }
    }

    return {
      status: 405,
      body: {
        message: "Method not allowed",
      },
    };
  }

  attach(job: Job<Trigger<any>, any>): void {
    if (!job.enabled) {
      return;
    }

    this.#registeredJobs[job.id] = job;

    job.trigger.attachToJob(this, job);
  }

  attachDynamicTrigger(trigger: DynamicTrigger<any, any>): void {
    this.#registeredDynamicTriggers[trigger.id] = trigger;

    new Job(this, {
      id: `register-dynamic-trigger-${trigger.id}`,
      name: `Register dynamic trigger ${trigger.id}`,
      version: trigger.source.version,
      trigger: new EventTrigger({
        event: registerSourceEvent,
        filter: { dynamicTriggerId: [trigger.id] },
      }),
      integrations: {
        integration: trigger.source.integration,
      },
      run: async (event, io, ctx) => {
        const updates = await trigger.source.register(
          event.source.params,
          event,
          io,
          ctx
        );

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: event.source.key,
          ...updates,
        });
      },
      // @ts-ignore
      __internal: true,
    });
  }

  attachJobToDynamicTrigger(
    job: Job<Trigger<any>, any>,
    trigger: DynamicTrigger<any, any>
  ): void {
    const jobs = this.#jobMetadataByDynamicTriggers[trigger.id] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#jobMetadataByDynamicTriggers[trigger.id] = jobs;
  }

  attachSource(options: {
    key: string;
    source: ExternalSource<any, any>;
    event: EventSpecification<any>;
    params: any;
  }): void {
    this.#registeredHttpSourceHandlers[options.key] = async (s, r) => {
      return await options.source.handle(s, r, this.#logger);
    };

    let registeredSource = this.#registeredSources[options.key];

    if (!registeredSource) {
      registeredSource = {
        channel: options.source.channel,
        key: options.key,
        params: options.params,
        events: [],
        clientId: !options.source.integration.usesLocalAuth
          ? options.source.integration.id
          : undefined,
      };
    }

    registeredSource.events = Array.from(
      new Set([...registeredSource.events, options.event.name])
    );

    this.#registeredSources[options.key] = registeredSource;

    new Job(this, {
      id: options.key,
      name: options.key,
      version: options.source.version,
      trigger: new EventTrigger({
        event: registerSourceEvent,
        filter: { source: { key: [options.key] } },
      }),
      integrations: {
        integration: options.source.integration,
      },
      queue: {
        name: options.key,
        maxConcurrent: 1,
      },
      startPosition: "initial",
      run: async (event, io, ctx) => {
        const updates = await options.source.register(
          options.params,
          event,
          io,
          ctx
        );

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: options.key,
          ...updates,
        });
      },
      // @ts-ignore
      __internal: true,
    });
  }

  attachDynamicSchedule(key: string, job: Job<Trigger<any>, any>): void {
    const jobs = this.#registeredSchedules[key] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#registeredSchedules[key] = jobs;
  }

  async registerTrigger(id: string, key: string, options: RegisterTriggerBody) {
    return this.#client.registerTrigger(this.name, id, key, options);
  }

  async getAuth(id: string) {
    return this.#client.getAuth(this.name, id);
  }

  async sendEvent(event: SendEvent, options?: SendEventOptions) {
    return this.#client.sendEvent(event, options);
  }

  async registerSchedule(id: string, key: string, schedule: ScheduleMetadata) {
    return this.#client.registerSchedule(this.name, id, key, schedule);
  }

  async unregisterSchedule(id: string, key: string) {
    return this.#client.unregisterSchedule(this.name, id, key);
  }

  authorized(apiKey: string) {
    const localApiKey = this.#options.apiKey ?? process.env.TRIGGER_API_KEY;

    if (!localApiKey) {
      return false;
    }

    return apiKey === localApiKey;
  }

  apiKey() {
    return this.#options.apiKey ?? process.env.TRIGGER_API_KEY;
  }

  async listen() {
    // Register the endpoint
    await this.#client.registerEndpoint({
      url: this.endpoint,
      name: this.name,
    });
  }

  async #preprocessRun(
    body: PreprocessRunBody,
    job: Job<Trigger<EventSpecification<any>>, any>
  ) {
    const context = this.#createPreprocessRunContext(body);

    const parsedPayload = job.trigger.event.parsePayload(
      body.event.payload ?? {}
    );

    const elements = job.trigger.event.runElements?.(parsedPayload) ?? [];

    return {
      abort: false,
      elements,
    };
  }

  async #executeJob(body: RunJobBody, job: Job<Trigger<any>, any>) {
    this.#logger.debug("executing job", { execution: body, job: job.toJSON() });

    const context = this.#createRunContext(body);

    const io = new IO({
      id: body.run.id,
      cachedTasks: body.tasks,
      apiClient: this.#client,
      logger: this.#logger,
      client: this,
      context,
    });

    const ioWithConnections = createIOWithIntegrations(
      io,
      body.connections,
      job.options.integrations
    );

    try {
      const output = await job.options.run(
        job.trigger.event.parsePayload(body.event.payload ?? {}),
        ioWithConnections,
        context
      );

      return { completed: true, output };
    } catch (error) {
      if (error instanceof ResumeWithTask) {
        return { completed: false, task: error.task };
      }

      const errorWithStack = ErrorWithStackSchema.safeParse(error);

      if (errorWithStack.success) {
        return { completed: true, error: errorWithStack.data };
      }

      const errorWithMessage = ErrorWithMessage.safeParse(error);

      if (errorWithMessage.success) {
        return { completed: true, error: errorWithMessage.data };
      }

      return {
        completed: true,
        error: { message: "Unknown error" },
      };
    }
  }

  #createRunContext(execution: RunJobBody): TriggerContext {
    const { event, organization, environment, job, run } = execution;

    return {
      event: {
        id: event.id,
        name: event.name,
        context: event.context,
        timestamp: event.timestamp,
      },
      organization,
      environment,
      job,
      run,
      account: execution.account,
    };
  }

  #createPreprocessRunContext(
    body: PreprocessRunBody
  ): TriggerPreprocessContext {
    const { event, organization, environment, job, run, account } = body;

    return {
      event: {
        id: event.id,
        name: event.name,
        context: event.context,
        timestamp: event.timestamp,
      },
      organization,
      environment,
      job,
      run,
      account,
    };
  }

  async #handleHttpSourceRequest(
    source: {
      key: string;
      dynamicId?: string;
      secret: string;
      data: any;
      params: any;
    },
    sourceRequest: HttpSourceRequest
  ): Promise<{ response: NormalizedResponse; events: SendEvent[] }> {
    this.#logger.debug("Handling HTTP source request", {
      source,
    });

    if (source.dynamicId) {
      const dynamicTrigger = this.#registeredDynamicTriggers[source.dynamicId];

      if (!dynamicTrigger) {
        this.#logger.debug("No dynamic trigger registered for HTTP source", {
          source,
        });

        return {
          response: {
            status: 200,
            body: {
              ok: true,
            },
          },
          events: [],
        };
      }

      const results = await dynamicTrigger.source.handle(
        source,
        sourceRequest,
        this.#logger
      );

      if (!results) {
        return {
          events: [],
          response: {
            status: 200,
            body: {
              ok: true,
            },
          },
        };
      }

      return {
        events: results.events,
        response: results.response ?? {
          status: 200,
          body: {
            ok: true,
          },
        },
      };
    }

    const handler = this.#registeredHttpSourceHandlers[source.key];

    if (!handler) {
      this.#logger.debug("No handler registered for HTTP source", {
        source,
      });

      return {
        response: {
          status: 200,
          body: {
            ok: true,
          },
        },
        events: [],
      };
    }

    const results = await handler(source, sourceRequest);

    if (!results) {
      return {
        events: [],
        response: {
          status: 200,
          body: {
            ok: true,
          },
        },
      };
    }

    return {
      events: results.events,
      response: results.response ?? {
        status: 200,
        body: {
          ok: true,
        },
      },
    };
  }
}

function buildEndpointUrl(path?: string): string {
  // Try to get the endpoint from the environment
  const endpoint = process.env.TRIGGER_ENDPOINT;

  // If the endpoint is set, we return it + the path
  if (endpoint) {
    return endpoint + (path ?? "");
  }

  // Try and get the host from the environment
  const host =
    process.env.TRIGGER_HOST ??
    process.env.HOST ??
    process.env.HOSTNAME ??
    process.env.NOW_URL ??
    process.env.VERCEL_URL;

  // If the host is set, we return it + the path
  if (host) {
    return "https://" + host + (path ?? "");
  }

  // If we can't get the host, we throw an error
  throw new Error(
    "Could not determine the endpoint for the trigger client. Please set the TRIGGER_ENDPOINT environment variable."
  );
}
