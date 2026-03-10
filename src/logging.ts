import * as e from "effect";
import * as util from "node:util";

const LOG_LEVEL_STYLES = {
  TRACE: "\x1b[2m",
  DEBUG: "\x1b[2m",
  INFO: "",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  FATAL: "\x1b[1;31m",
} as const satisfies Record<string, string>;

const RESET = "\x1b[0m";

const ConsoleLogger = e.Logger.make(({ logLevel, message }) => {
  const stream = logLevel.label === "ERROR" || logLevel.label === "FATAL"
    ? process.stderr
    : process.stdout;

  stream.write(colorize(logLevel.label, formatLogLine(logLevel.label, message), stream.isTTY) + "\n");
});

export const PlainTextLogger = e.Logger.replace(
  e.Logger.defaultLogger,
  ConsoleLogger,
);

function formatLogLine(level: e.LogLevel.LogLevel["label"], message: unknown): string {
  const rendered = formatMessage(message);
  const prefix = (level === "INFO" ? "" : (level.padStart(5, " ") + ": "));
  return rendered
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map(formatPart).join(" ");
  }

  return formatPart(message);
}

function formatPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return util.inspect(value, { depth: null, colors: false });
}

function colorize(level: e.LogLevel.LogLevel["label"], message: string, isTTY: boolean): string {
  if (!isTTY) return message;

  const prefix = LOG_LEVEL_STYLES[level as keyof typeof LOG_LEVEL_STYLES] ?? "";
  if (!prefix) return message;

  return `${prefix}${message}${RESET}`;
}
