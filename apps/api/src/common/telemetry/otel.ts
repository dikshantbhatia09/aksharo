/**
 * OpenTelemetry bootstrap (05-system-architecture §Observability: "trace api →
 * queue → worker per job").
 *
 * Started from `main.ts` BEFORE the Nest application is created, because the
 * instrumentation has to patch `http` before anything requires it.
 *
 * Configuration comes from OpenTelemetry's own specified environment variables
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `OTEL_SERVICE_NAME`) and NOT from `@montaj/config`: CONTRACTS §1 is a frozen
 * list of product configuration, and adding an OTel variable to it would need an
 * ADR for something the OTel spec already names. With no endpoint configured the
 * whole thing is a no-op — no exporter, no background timer, no cost.
 */
import { Logger } from "@nestjs/common";

/** Stop the SDK. Safe to call when telemetry was never started. */
export type StopTelemetry = () => Promise<void>;

const NOOP: StopTelemetry = async () => {
  /* telemetry was not configured */
};

/**
 * The active SDK's stop function.
 *
 * Module-level because tracing starts before the Nest application exists (the
 * instrumentation must patch `http` first), yet has to be shut down by the
 * application's own lifecycle. `TelemetryShutdownService` is the bridge.
 */
let activeStop: StopTelemetry = NOOP;

/** Stop the active SDK, if any. Idempotent. */
export async function shutdownTelemetry(): Promise<void> {
  const stop = activeStop;
  activeStop = NOOP;
  await stop();
}

export interface TelemetryOptions {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  /** Defaults to `process.env`; injectable for tests. */
  readonly env?: Record<string, string | undefined>;
}

/** The OTLP traces endpoint, or `undefined` when telemetry is off. */
export function resolveOtlpEndpoint(env: Record<string, string | undefined>): string | undefined {
  const specific = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]?.trim();
  if (specific !== undefined && specific !== "") return specific;
  const general = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  if (general !== undefined && general !== "") return `${general.replace(/\/$/, "")}/v1/traces`;
  return undefined;
}

/**
 * Start tracing if an OTLP endpoint is configured.
 *
 * The SDK packages are required lazily so that a deployment with telemetry off
 * never loads them, and so a broken exporter can never stop the API from booting:
 * a failure here is logged and swallowed.
 */
export async function startTelemetry(options: TelemetryOptions = {}): Promise<StopTelemetry> {
  const env = options.env ?? process.env;
  const endpoint = resolveOtlpEndpoint(env);
  const logger = new Logger("telemetry");

  if (endpoint === undefined) {
    logger.log("OTLP endpoint not configured; tracing disabled");
    return NOOP;
  }

  try {
    // Loaded lazily and by dynamic `import()`, so a deployment with tracing off
    // never pays to parse ~3 MB of SDK, and a broken exporter package can never
    // stop the API from booting.
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
    const semconv = await import("@opentelemetry/semantic-conventions");

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]:
          options.serviceName ?? env["OTEL_SERVICE_NAME"] ?? "montaj-api",
        [semconv.ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        new HttpInstrumentation({
          // Health probes would swamp the trace budget and say nothing.
          ignoreIncomingRequestHook: (request) =>
            request.url === "/health" || request.url === "/health/ready",
        }),
      ],
    });

    sdk.start();
    logger.log(`tracing to ${endpoint}`);
    activeStop = async () => {
      await sdk.shutdown();
    };
    return activeStop;
  } catch (error) {
    logger.warn(`tracing disabled: ${error instanceof Error ? error.message : String(error)}`);
    return NOOP;
  }
}
