import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import { IBun, IToolState } from "@/modules";

export const BunImpl = e.Layer.effect(IBun, e.Effect.gen(function*() {
  const toolState = yield* IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;

  const resolveRepoPath = e.Effect.fn(function*(org: string, repo: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return e.Option.none();

    const repoPath = path.join(toolState.workspaceRoot.value, `@${org}`, repo);
    const exists = yield* fileSystem.exists(repoPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
    return exists ? e.Option.some(repoPath) : e.Option.none();
  });

  function runBun(
    args: readonly string[],
    cwd: string,
  ): e.Option.Option<ReturnType<typeof Bun.spawnSync>> {
    const bunPath = Bun.which("bun");
    if (!bunPath) return e.Option.none();

    return e.Option.some(
      Bun.spawnSync([bunPath, ...args], {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
  }

  const install = e.Effect.fn(function*(org: string, repo: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) {
      yield* e.Effect.logError(`Failed to run bun install in @${org}/${repo}: repo path is missing.`);
      return yield* e.Effect.dieMessage("bun install failed");
    }

    const result = runBun(["install"], repoPath.value);
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

    const result = runBun(["link"], repoPath.value);
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

    const result = runBun(["unlink"], repoPath.value);
    if (e.Option.isNone(result) || result.value.exitCode !== 0) {
      yield* e.Effect.logError(`Failed to run bun unlink in @${org}/${repo}.`);
      return yield* e.Effect.dieMessage("bun unlink failed");
    }
  });

  return { install, link, unlink };
}));
