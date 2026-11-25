import { afterEach, expect, test } from "bun:test";
import * as e from "effect";
import { modules } from "@/modules";
import { CommandEchoImpl } from "./impl";
import { formatShellCommand, type ShellCommand } from "./shell-command";

const clone: ShellCommand = {
  program: "git",
  optionLines: [
    ["-c", "core.sshCommand=/opt/bun-global/node_modules/@jive-sh/jive/bin/jive-ssh"],
    ["-c", "ssh.variant=ssh"],
    ["-c", "url.git@github.com:.insteadOf=https://github.com/"],
  ],
  arguments: ["clone", "https://github.com/ozyman42/workspace", "/Users/alex/github.com/ozyman42/workspace"],
};
const cloneText = [
  "git \\",
  "  -c core.sshCommand=/opt/bun-global/node_modules/@jive-sh/jive/bin/jive-ssh \\",
  "  -c ssh.variant=ssh \\",
  "  -c url.git@github.com:.insteadOf=https://github.com/ \\",
  "  clone https://github.com/ozyman42/workspace /Users/alex/github.com/ozyman42/workspace",
].join("\n");

test.each([
  { name: "a command with -c options, one line each, the subcommand last", command: clone, text: cloneText },
  { name: "a command with no options, on one line", command: { program: "git", optionLines: [], arguments: ["submodule", "deinit", "-f", "packages/@acme/widget"] }, text: "git submodule deinit -f packages/@acme/widget" },
  {
    name: "words a shell would split or expand, single-quoted",
    command: { program: "git", optionLines: [["-c", "core.sshCommand='/Users/a b/jive-ssh'"], ["-C", "/Users/a b/repo"]], arguments: ["clone", "https://github.com/o/r", "", "it's"] },
    text: "git \\\n  -c 'core.sshCommand='\\''/Users/a b/jive-ssh'\\''' \\\n  -C '/Users/a b/repo' \\\n  clone https://github.com/o/r '' 'it'\\''s'",
  },
])("formats $name", ({ command, text }) => {
  expect(formatShellCommand(command)).toBe(text);
});

test("the quoted text is what a shell hands the program, word for word", () => {
  const command: ShellCommand = { program: "printf", optionLines: [["%s|", "core.sshCommand='/Users/a b/jive-ssh'"]], arguments: ["", "it's", "$HOME", "a\\b"] };
  const run = Bun.spawnSync(["sh", "-c", formatShellCommand(command)], { stdout: "pipe" });
  expect(run.stdout.toString()).toBe("core.sshCommand='/Users/a b/jive-ssh'||it's|$HOME|a\\b|");
});

const originalNoColor = process.env["NO_COLOR"];
afterEach(() => {
  if (originalNoColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = originalNoColor;
});

/** What the echo writes to stderr when stderr is a terminal (`terminal`) or not, with NO_COLOR as `noColor`. */
async function echoed({ terminal, noColor }: { readonly terminal: boolean; readonly noColor: string | undefined }) {
  if (noColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = noColor;
  const stderr: Array<string> = [];
  await e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () { yield* (yield* modules.commandEcho).show(clone); }),
    e.Effect.provide(CommandEchoImpl.Layer),
    e.Effect.provide(e.Stdio.layerTest({
      stderrIsTerminal: e.Effect.succeed(terminal),
      stderr: () => e.Sink.forEach((chunk: string | Uint8Array) => e.Effect.sync(() => {
        stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      })),
    })),
  ));
  return stderr.join("");
}

test.each([
  { name: "a terminal, NO_COLOR unset: teal", terminal: true, noColor: undefined, text: `\u001b[36m${cloneText}\u001b[0m\n` },
  { name: "a terminal, NO_COLOR empty: teal", terminal: true, noColor: "", text: `\u001b[36m${cloneText}\u001b[0m\n` },
  { name: "a terminal, NO_COLOR=1: plain", terminal: true, noColor: "1", text: `${cloneText}\n` },
  { name: "no terminal: plain", terminal: false, noColor: undefined, text: `${cloneText}\n` },
])("echoes on stderr to $name", async ({ terminal, noColor, text }) => {
  expect(await echoed({ terminal, noColor })).toBe(text);
});
