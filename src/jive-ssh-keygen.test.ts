import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * A repository jive 0.7.0 configured names `jive-ssh-keygen` as git's `gpg.ssh.program`. Here git runs this
 * version's `jive-ssh-keygen` from source in that role, in a scratch repository with no global git config, from a
 * subdirectory, and the commit fails with the message naming the fix and the repository.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jk-")));
const repository = path.join(scratch, "repo");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("git signing through jive-ssh-keygen fails with the message to run jive init in that repository", async () => {
  const program = path.join(scratch, "jive-ssh-keygen");
  writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dir, "entrypoints", "jive-ssh-keygen.ts"))} "$@"\n`);
  chmodSync(program, 0o755);
  const publicKey = path.join(scratch, "account.pub");
  writeFileSync(publicKey, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl tester@jive.sh\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: ReadonlyArray<string>, cwd: string) =>
    Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  mkdirSync(path.join(repository, "nested"), { recursive: true });
  expect(await git(["init", "-q"], repository).exited).toBe(0);
  for (const [key, value] of [
    ["user.name", "Tester"], ["user.email", "tester@example.com"],
    ["gpg.format", "ssh"], ["user.signingKey", publicKey], ["commit.gpgSign", "true"], ["gpg.ssh.program", program],
  ] as const) expect(await git(["config", key, value], repository).exited).toBe(0);

  const commit = git(["commit", "-q", "--allow-empty", "-m", "signed"], path.join(repository, "nested"));
  const [stderr, exitCode] = await Promise.all([new Response(commit.stderr).text(), commit.exited]);
  expect({ exitCode, stderr }).toEqual({
    exitCode: 128,
    stderr: `error: jive-ssh-keygen was replaced by jive-ssh-sign in jive 0.8.0; run jive init in ${repository} to update its git config\n\nfatal: failed to write commit object\n`,
  });
});

test("outside a repository, jive-ssh-keygen says this repository, and exits 1", async () => {
  const run = Bun.spawn([process.execPath, path.join(import.meta.dir, "entrypoints", "jive-ssh-keygen.ts"), "-Y", "sign"], {
    cwd: scratch, env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "jive-ssh-keygen was replaced by jive-ssh-sign in jive 0.8.0; run jive init in this repository to update its git config\n",
  });
});
