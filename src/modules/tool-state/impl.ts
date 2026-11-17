import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { NotInWorkspaceError, type IToolState } from "./interface";

const ROOT_MANIFEST = "package.json";

/** A package.json that marks its directory the workspace root. */
const WorkspaceRootManifest = e.Schema.fromJsonString(e.Schema.Struct({
  jive: e.Schema.Struct({ root: e.Schema.Literal(true) }),
}));

/** Any JSON object, so marking keeps every other field of an existing package.json. */
const JsonObject = e.Schema.fromJsonString(e.Schema.Record(e.Schema.String, e.Schema.Unknown));

export class ToolStateImpl extends implementing(modules.toolState).uses(OSPlatform, e.FileSystem.FileSystem) implements IToolState {
  *findWorkspaceRoot(): EffectGen<e.Option.Option<string>> {
    let currentPath = yield* this.dependencies.OSPlatform.getCurrentDirectory();
    while (true) {
      if (yield* this.isMarkedRoot(currentPath)) return e.Option.some(currentPath);
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return e.Option.none();
      currentPath = parentPath;
    }
  }

  *assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError> {
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot();
    if (e.Option.isNone(maybeWorkspaceRoot)) {
      return yield* new NotInWorkspaceError({ path: yield* this.dependencies.OSPlatform.getCurrentDirectory() });
    }
    return { workspaceRoot: maybeWorkspaceRoot.value };
  }

  *markWorkspaceRoot(directory: string): EffectGen<boolean, BadPreconditionsError> {
    if (yield* this.isMarkedRoot(directory)) return false;
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const file = path.join(directory, ROOT_MANIFEST);
    const exists = yield* e.pipe(fs.exists(file), e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)));
    const existing = exists
      ? yield* e.pipe(fs.readFileString(file), e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to read ${file}`, message)))
      : "{}\n";
    const manifest = yield* e.pipe(
      e.Schema.decodeUnknownEffect(JsonObject)(existing),
      e.Effect.mapError(() => new BadPreconditionsError({ cause: `${file} is not a JSON object`, fix: `Fix ${file}, then run this again` })),
    );
    const jive = manifest["jive"];
    const isObject = typeof jive === "object" && jive !== null && !Array.isArray(jive);
    if (jive !== undefined && !isObject) {
      return yield* new BadPreconditionsError({ cause: `${file}'s "jive" field is not an object`, fix: `Fix ${file}, then run this again` });
    }
    const jiveBlock = isObject ? jive : {};
    // Keeps the file's own indentation; a new file gets two spaces.
    const indentation = /^\{\s*\n([ \t]+)"/.exec(existing);
    const written = JSON.stringify({ ...manifest, jive: { ...jiveBlock, root: true } }, null, indentation !== null ? indentation[1] : 2);
    yield* e.pipe(
      fs.writeFileString(file, `${written}\n`),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to write ${file}`, message)),
    );
    return true;
  }

  private *isMarkedRoot(directory: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).readFileString(path.join(directory, ROOT_MANIFEST)),
      e.Effect.flatMap(e.Schema.decodeUnknownEffect(WorkspaceRootManifest)),
      e.Effect.as(true),
      e.Effect.catchTags({
        PlatformError: () => e.Effect.succeed(false),
        SchemaError: () => e.Effect.succeed(false),
      }),
    );
  }
}
