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
  for (const command of ["load", "unload", "on", "ssh", "login", "whoami"]) expect(stdout).toContain(command);
  expect(stdout).not.toMatch(/^  version/m);
  // Relinking is `jive init` run again.
  expect(stdout).not.toMatch(/^  link /m);
});

test("Tab answers from the workspace the shell is in", async () => {
  expect(await jive("--compgen", "on", "")).toEqual({ exitCode: 0, stdout: "acme\n", stderr: "" });
});

test("Tab offers ssh's connect and sign, and nothing after them, since their words are ssh's", async () => {
  const { exitCode, stdout } = await jive("--compgen", "ssh", "");
  expect(exitCode).toBe(0);
  expect(stdout.split("\n").filter(line => line !== "").map(line => line.split("\t")[0])).toEqual(["connect", "sign"]);
  expect(await jive("--compgen", "ssh", "connect", "user@host", "-")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});

test("ssh connect --help shows its help and runs no ssh", async () => {
  const { exitCode, stdout } = await jive("ssh", "connect", "--help");
  expect(exitCode).toBe(0);
  expect(stdout).toStartWith("Usage: jive ssh connect [<arguments>…]\n");
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
