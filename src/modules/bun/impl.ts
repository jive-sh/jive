import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { IBun } from "./interface";

export class BunImpl extends implementing(modules.bun).uses(modules.toolState, OSPlatform) implements IBun {
  *install(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    yield* this.bunInRepo("install", repo);
  }
  *link(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    yield* this.bunInRepo("link", repo);
  }
  *unlink(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    yield* this.bunInRepo("unlink", repo);
  }

  private *bunInRepo(subcommand: string, repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { absolutePath } = yield* this.dependencies.toolState.verifyRepoIntegrity(repo);
    yield* e.Effect.log(`Running bun ${subcommand} in ${repo.packageName()}`);
    const { exitCode } = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({
        command: "bun", args: [subcommand], cwd: absolutePath, stdout: "inherit", stderr: "inherit",
      })),
      e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run bun ${subcommand}`, message)),
    );
    if (exitCode !== 0) {
      return yield* new BadPreconditionsError({
        cause: `bun ${subcommand} in ${repo.packageName()} exited with code ${exitCode}`,
        fix: "Fix what bun reported, then run the command again",
      });
    }
  }
}
