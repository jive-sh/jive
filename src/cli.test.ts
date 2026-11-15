import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { version } from "../package.json";

/** The `jive` entrypoint run as a process, as a person runs it; none of these commands reaches a network. */

const entrypoint = path.join(import.meta.dir, "entrypoints", "jive.ts");
const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "jive-entrypoint-test-")));
mkdirSync(path.join(workspace, ".jive"));
mkdirSync(path.join(workspace, "@acme", "widget"), { recursive: true });
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

async function jive(...args: ReadonlyArray<string>) {
  // Async spawn, so the test process stays responsive while the child runs.
  const proc = Bun.spawn(["bun", entrypoint, ...args], { cwd: workspace, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("--version prints the package's version", async () => {
  expect(await jive("--version")).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
});

test("--help lists the commands", async () => {
  const { exitCode, stdout } = await jive("--help");
  expect(exitCode).toBe(0);
  for (const command of ["load", "unload", "on", "login", "whoami"]) expect(stdout).toContain(command);
  // ssh runs as `jive-ssh`, and signing as `jive-ssh-sign`.
  expect(stdout).not.toMatch(/^  ssh /m);
  expect(stdout).not.toMatch(/^  version/m);
  // Relinking is `jive init` run again.
  expect(stdout).not.toMatch(/^  link /m);
});

test("Tab answers from the workspace the shell is in", async () => {
  expect(await jive("--compgen", "on", "")).toEqual({ exitCode: 0, stdout: "acme\n", stderr: "" });
});

test("no test can open a browser: the openers a sign-in would run refuse", () => {
  // jive spawns with `process.env` (jive-abstract-library's spawnProcess), so this is the PATH its opener is found on.
  for (const opener of ["open", "xdg-open"]) {
    const resolved = Bun.which(opener, { PATH: process.env["PATH"]! });
    expect(resolved).toStartWith(process.env["HOME"]!);
    const run = Bun.spawnSync([opener, "https://jive.sh/login"], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 1, stderr: "tests never open a browser\n" });
  }
});

test("a refused command prints its cause and fix, without a stack, and exits 1", async () => {
  expect(await jive("on", "acme", "widget", "--", "ls")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "ERROR: Malformed submodule configuration for repo @acme/widget\nERROR: Fix: Re-run `jive load acme widget` to re-configure\n",
  });
});

test("whoami with no daemon running says so, with the fix", async () => {
  expect(await jive("whoami")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "ERROR: jive's daemon is not running\nERROR: Fix: run `jive daemons` to see why; `jive upgrade` registers and starts it again, and so does logging in again\n",
  });
});
