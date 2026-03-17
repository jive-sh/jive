import * as e from "effect";
import * as modules from "@/modules";
import type { VerifiedCommand } from "@/modules/host-shell/interface";
import type { RepoIdentifier } from "@/modules/tool-state/interface";

export const BunImpl = e.Layer.effect(modules.IBun, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const hostShell = yield* modules.IHostShell;
  const bun = yield* hostShell.getCommand("bun");

  const run = e.Effect.fn(function*(cmd: VerifiedCommand, arg: string, repo: { in: RepoIdentifier }) {
    const { exitCode } = yield* e.pipe(
      toolState.verifyRepoIntegrity(repo.in),
      e.Effect.catchTag("VerifyRepoIntegrityError", err => e.Effect.dieMessage(err.reason._tag)),
      e.Effect.flatMap(({path}) =>
        hostShell.runInheritIO({
          verifiedCommand: bun,
          args: [arg],
          runInDir: path
        })
      ),
      e.Effect.catchTag("SystemError", err => e.Effect.dieMessage(err.message)),
      e.Effect.catchTag("BadArgument", err => e.Effect.dieMessage(err.message))
    );
    if (exitCode !== 0) {
      return yield* e.Effect.die(undefined);
    }
  });

  return {
    install: e.Effect.fn(function*(repo) {
      yield* run(bun, "install", {in: repo});
    }),
    link: e.Effect.fn(function*(repo) {
      yield* run(bun, "link", {in: repo});
    }),
    unlink: e.Effect.fn(function*(repo) {
      yield* run(bun, "unlink", {in: repo});
    }),
  };
}));
