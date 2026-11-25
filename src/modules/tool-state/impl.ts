import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { modules } from "@/modules";
import { NotInWorkspaceError, type IToolState } from "./interface";

export class ToolStateImpl extends implementing(modules.toolState).uses(OSPlatform, e.FileSystem.FileSystem) implements IToolState {
  *findWorkspaceRoot(directory: string): EffectGen<e.Option.Option<string>> {
    let currentPath = directory;
    while (true) {
      if (yield* this.holdsGit(currentPath)) return e.Option.some(currentPath);
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return e.Option.none();
      currentPath = parentPath;
    }
  }

  *assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError> {
    const currentDirectory = yield* this.dependencies.OSPlatform.getCurrentDirectory();
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot(currentDirectory);
    if (e.Option.isNone(maybeWorkspaceRoot)) return yield* new NotInWorkspaceError({ path: currentDirectory });
    return { workspaceRoot: maybeWorkspaceRoot.value };
  }

  private *holdsGit(directory: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).exists(path.join(directory, ".git")),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }
}
