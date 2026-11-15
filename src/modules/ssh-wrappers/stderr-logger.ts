import * as e from "effect";
import { inspect } from "node:util";

/**
 * How `jive-ssh` and `jive-ssh-sign` print: every line to stderr, named after the program as ssh names itself
 * (`jive-ssh: …`), a warning marked `warning:`. Their stdout is ssh's and ssh-keygen's own, which git reads as its
 * protocol or a signature, so nothing of jive's may go there.
 */
export const wrapperLogger = (programName: string) => e.Logger.layer([e.Logger.make(({ logLevel, message }) => {
  const text = (Array.isArray(message) ? message : [message])
    .map((part) => typeof part === "string" ? part : inspect(part, { depth: null, colors: false }))
    .join(" ");
  process.stderr.write(`${programName}: ${logLevel === "Warn" ? "warning: " : ""}${text}\n`);
})]);
