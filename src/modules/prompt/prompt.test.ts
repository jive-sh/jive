import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { isYes } from "./interface";

test.each([
  { answer: "y", yes: true },
  { answer: "Y", yes: true },
  { answer: "yes", yes: true },
  { answer: " YES \n", yes: true },
  { answer: "", yes: false },
  { answer: "n", yes: false },
  { answer: "no", yes: false },
  { answer: "yep", yes: false },
  { answer: "sure", yes: false },
])("answering '$answer' is yes: $yes", ({ answer, yes }) => {
  expect(isYes(answer)).toBe(yes);
});

/**
 * The real prompt, through the CLI run as a process whose input is a pipe, as in a CI job or a script: `jive init`
 * inside a workspace warns, asks nothing, exits 1 and writes nothing. Nothing signs in: the question comes first. The
 * scratch folder is inside this package's checkout, so `GIT_CEILING_DIRECTORIES` stops git there, and no git command
 * sees that checkout.
 */
const scratch = path.join(import.meta.dir, "..", "..", "..", "node_modules", ".cache", "prompt-test");
mkdirSync(scratch, { recursive: true });
const workspace = mkdtempSync(path.join(scratch, "workspace-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

test("init inside a workspace with input that is not a terminal warns, asks nothing and exits 1 without writing", async () => {
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ jive: { root: true } }));
  const folder = path.join(workspace, "new-project");
  mkdirSync(folder);
  const { exitCode, output } = await initWithPipedInput(folder);
  expect(exitCode).toBe(1);
  expect(output).toContain(`${folder} is inside the jive workspace at ${workspace}`);
  expect(output).toContain(`Not configuring ${workspace}: there is no terminal to ask whether to`);
  expect(output).not.toContain("Are you sure");
  expect(await Bun.file(path.join(folder, ".git")).exists()).toBe(false);
  expect(await Bun.file(path.join(folder, "package.json")).exists()).toBe(false);
}, 30_000);

/** `jive init` run as a process in `directory`, its input a pipe that would answer yes; git sees nothing above `scratch`. */
async function initWithPipedInput(directory: string) {
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "entrypoints", "jive.ts"), "init"], {
    cwd: directory,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
    stdin: new Blob(["y\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, output: stdout + stderr };
}
