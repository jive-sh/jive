import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import * as modules from "@/modules";
import type { HostShellCommand } from "@/modules/host-shell/interface";

export const BunImpl = e.Layer.effect(modules.IBun, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const hostShell = yield* modules.IHostShell;

  const resolveRepoPath = e.Effect.fn(function*(org: string, repo: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return e.Option.none();

    const repoPath = path.join(toolState.workspaceRoot.value, `@${org}`, repo);
    const exists = yield* fileSystem.exists(repoPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
    return exists ? e.Option.some(repoPath) : e.Option.none();
  });

  const runBun = (args: readonly string[], cwd: string): HostShellCommand => ({
    command: "bun",
    args,
    cwd: e.Option.some(cwd),
    env: {},
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    shell: e.Option.none(),
  });

  const install = e.Effect.fn(function*(org: string, repo: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) {
      yield* e.Effect.logError(`Failed to run bun install in @${org}/${repo}: repo path is missing.`);
      return yield* e.Effect.dieMessage("bun install failed");
    }

    const result = yield* hostShell.run(runBun(["install"], repoPath.value)).pipe(
      e.Effect.map((value) => e.Option.some(value)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );
    if (e.Option.isNone(result) || result.value.exitCode !== 0) {
      yield* e.Effect.logError(`Failed to run bun install in @${org}/${repo}.`);
      return yield* e.Effect.dieMessage("bun install failed");
    }
  });

  const link = e.Effect.fn(function*(org: string, repo: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) {
      yield* e.Effect.logError(`Failed to run bun link in @${org}/${repo}: repo path is missing.`);
      return yield* e.Effect.dieMessage("bun link failed");
    }

    const result = yield* hostShell.run(runBun(["link"], repoPath.value)).pipe(
      e.Effect.map((value) => e.Option.some(value)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );
    if (e.Option.isNone(result) || result.value.exitCode !== 0) {
      yield* e.Effect.logError(`Failed to run bun link in @${org}/${repo}.`);
      return yield* e.Effect.dieMessage("bun link failed");
    }
  });

  const unlink = e.Effect.fn(function*(org: string, repo: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) {
      yield* e.Effect.logError(`Failed to run bun unlink in @${org}/${repo}: repo path is missing.`);
      return yield* e.Effect.dieMessage("bun unlink failed");
    }

    const result = yield* hostShell.run(runBun(["unlink"], repoPath.value)).pipe(
      e.Effect.map((value) => e.Option.some(value)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );
    if (e.Option.isNone(result) || result.value.exitCode !== 0) {
      yield* e.Effect.logError(`Failed to run bun unlink in @${org}/${repo}.`);
      return yield* e.Effect.dieMessage("bun unlink failed");
    }
  });

  return {
    requiredCLICommands: ["bun"],
    install,
    link,
    unlink,
  };
}));
