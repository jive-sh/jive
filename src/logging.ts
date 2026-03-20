import * as e from "effect";
import { bright, dim, magenta as magentaColor, red, yellow } from "ansicolor";
import * as util from "node:util";

const LOG_LEVEL_STYLES = {
  TRACE: dim,
  DEBUG: dim,
  INFO: (message: string) => message,
  WARN: yellow,
  ERROR: red,
  FATAL: bright.red,
} as const satisfies Record<string, (message: string) => string>;

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

  const style = LOG_LEVEL_STYLES[level as keyof typeof LOG_LEVEL_STYLES];
  return style ? style(message) : message;
}

export function magenta(text: string, isTTY = process.stdout.isTTY || process.stderr.isTTY): string {
  if (!isTTY) return text;
  return magentaColor(text);
}

export function pluralize(items: any[], singular: string, plural: string) {
  return items.length === 1 ? singular : plural;
}

export function prettyList(items: string[]): string {
  const [first, ...others] = items;
  if (!first) return "";
  if (others.length === 0) return first;
  if (others.length === 1) return `${first} and ${others[0]}`;
  const last = others.pop()!;
  return `${first}${others.map(other => `, ${other}`).join("")}, and ${last}`;
}
