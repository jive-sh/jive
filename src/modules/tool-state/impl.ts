import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { WORKSPACE_DIR } from "./constants";
import {
  NotInWorkspaceError,
  RepoIntegrityCompromisedReason,
  VerifyRepoIntegrityError,
  type IToolState,
  type RepoLocation,
} from "./interface";
import type { RepoIdentifier } from "./repo-identifier";

/**
 * The workspace is the nearest directory, from the current one upward, holding a `.jive` directory; its loaded
 * repos live at `@<org>/<repo>` under it.
 */
export class ToolStateImpl extends implementing(modules.toolState).uses(OSPlatform, e.FileSystem.FileSystem) implements IToolState {
  *assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError> {
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot();
    if (e.Option.isNone(maybeWorkspaceRoot)) {
      return yield* new NotInWorkspaceError({ path: yield* this.dependencies.OSPlatform.getCurrentDirectory() });
    }
    return { workspaceRoot: maybeWorkspaceRoot.value };
  }

  *verifyRepoIntegrity(repo: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError | BadArgumentError> {
    const orgLocation = yield* this.orgPath(repo);
    const repoLocation = yield* this.repoPath(repo);
    const failWith = (reason: RepoIntegrityCompromisedReason) =>
      VerifyRepoIntegrityError.toToolError(new VerifyRepoIntegrityError({ reason, repo }));
    if (!(yield* this.pathExists(orgLocation.absolutePath))) {
      return yield* failWith(RepoIntegrityCompromisedReason.OrgMissing());
    }
    if (!(yield* this.pathExists(repoLocation.absolutePath))) {
      return yield* failWith(RepoIntegrityCompromisedReason.RepoMissing());
    }
    if (!(yield* this.pathExists(path.join(repoLocation.absolutePath, ".git")))) {
      return yield* failWith(RepoIntegrityCompromisedReason.SubmoduleMisconfiguration());
    }
    if (!(yield* this.pathExists(path.join(repoLocation.absolutePath, "package.json")))) {
      return yield* failWith(RepoIntegrityCompromisedReason.NotAPackage());
    }
    return repoLocation;
  }

  *orgPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRootOrFail();
    return {
      relativePath: repoId.orgName(),
      absolutePath: path.join(workspaceRoot, repoId.orgName()),
    };
  }

  *repoPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError> {
    const { relativePath, absolutePath } = yield* this.orgPath(repoId);
    return {
      relativePath: path.join(relativePath, repoId.repo),
      absolutePath: path.join(absolutePath, repoId.repo),
    };
  }

  private *workspaceRootOrFail(): EffectGen<string, BadPreconditionsError> {
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot();
    if (e.Option.isNone(maybeWorkspaceRoot)) {
      return yield* BadPreconditionsError.fromNotInWorkspaceError(new NotInWorkspaceError({ path: yield* this.dependencies.OSPlatform.getCurrentDirectory() }));
    }
    return maybeWorkspaceRoot.value;
  }

  /** The home directory's `.jive` is jive's own home (session, account key, agent socket), never a workspace. */
  private *findWorkspaceRoot(): EffectGen<e.Option.Option<string>> {
    const homeDirectory = yield* this.dependencies.OSPlatform.getHomeDirectory();
    let currentPath = yield* this.dependencies.OSPlatform.getCurrentDirectory();
    while (true) {
      if (currentPath !== homeDirectory && (yield* this.isDirectory(path.join(currentPath, WORKSPACE_DIR)))) {
        return e.Option.some(currentPath);
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return e.Option.none();
      }
      currentPath = parentPath;
    }
  }

  private *pathExists(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).exists(targetPath),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *isDirectory(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).stat(targetPath),
      e.Effect.map(info => info.type === "Directory"),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }
}
