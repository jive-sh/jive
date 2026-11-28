import * as path from "node:path";

/**
 * The names a sign-in request shows for a caller's process chain, oldest ancestor first and the direct caller last:
 * each process by its program's name, plus its first argument when that is a plain word (`jive login`, `git push`).
 * Nothing else of a command line leaves the machine, since arguments can hold secrets.
 */

/** Programs that run a script: the script names the program (`bun …/agenticloud-connect.js` is `agenticloud-connect`). */
const SCRIPT_RUNNERS = new Set(["bun", "node", "deno", "python", "python3", "ruby", "perl", "sh", "bash", "zsh"]);
const PLAIN_WORD = /^[a-z][a-z0-9-]{0,30}$/;
const SCRIPT_EXTENSION = /\.(c|m)?(js|ts)x?$|\.(py|rb|pl|sh)$/;

export function programNameOf(command: string): string {
  const [first = "", ...rest] = command.trim().split(/\s+/);
  // A login shell's name starts with "-" (`-zsh`).
  const executable = path.basename(first).replace(/^-/, "");
  const maybeScript = rest.find((argument) => !argument.startsWith("-"));
  if (SCRIPT_RUNNERS.has(executable) && maybeScript !== undefined && maybeScript.includes("/")) {
    return path.basename(maybeScript).replace(SCRIPT_EXTENSION, "");
  }
  const firstArgument = rest[0];
  return firstArgument !== undefined && PLAIN_WORD.test(firstArgument) ? `${executable} ${firstArgument}` : executable;
}

export const programNamesOf = (commands: ReadonlyArray<string>): ReadonlyArray<string> =>
  commands.map(programNameOf).filter((name) => name !== "");
