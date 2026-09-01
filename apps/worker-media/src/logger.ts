/**
 * Minimal structured logger: one JSON object per line, which is what the
 * OpenTelemetry collector and Grafana Loki expect. A07 swaps in the shared
 * pino/OTel setup; until then this keeps the worker dependency-free and its
 * output machine-readable.
 *
 * Never log a value from `Env` — secrets must not reach stdout (THREAT-MODEL T21).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return LEVEL_ORDER[configured as LogLevel] ?? LEVEL_ORDER.info;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "worker-media",
    msg: message,
    ...fields,
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
} as const;
