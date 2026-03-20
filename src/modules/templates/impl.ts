import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "node:path";
import * as modules from "@/modules";
import { TEMPLATE_PREFIX } from "./constants";

class NpmRegistryRequestError extends e.Data.TaggedError("NpmRegistryRequestError")<{
  message: string;
}> {}

class NpmRegistryJsonParseError extends e.Data.TaggedError("NpmRegistryJsonParseError")<{
  message: string;
}> {}

const workspaceProbeRepo = new modules.RepoIdentifier("__jive_probe__", "__jive_probe__");

export const TemplatesImpl = e.Layer.effect(modules.ITemplates, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const workspaceRoot =
    toolState.inWorkspace ?
      path.dirname(path.dirname(toolState.getRepoPath(workspaceProbeRepo))) :
      "";

  const isTemplatePackageName = (name: string): boolean =>
    name.startsWith(TEMPLATE_PREFIX) || name.includes(`/${TEMPLATE_PREFIX}`);

  const listDirectoryNames = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.readDirectory(targetPath),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed([] as string[])),
    );
  });

  const isDirectory = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.stat(targetPath),
      e.Effect.map((info) => info.type === "Directory"),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed(false)),
    );
  });

  const readPackageName = e.Effect.fn(function*(packageJsonPath: string) {
    const contents = yield* e.pipe(
      fileSystem.readFileString(packageJsonPath),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed("")),
    );
    if (!contents) return e.Option.none<string>();

    try {
      const parsed = JSON.parse(contents) as { name?: unknown };
      return typeof parsed.name === "string" ? e.Option.some(parsed.name) : e.Option.none<string>();
    } catch {
      return e.Option.none<string>();
    }
  });

  const queryNpmTemplates = e.Effect.fn(function*() {
    const maybeResponse = yield* e.pipe(
      e.Effect.tryPromise({
        try: () => fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(TEMPLATE_PREFIX)}&size=250`),
        catch: error => new NpmRegistryRequestError({ message: error instanceof Error ? error.message : String(error) }),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("NpmRegistryRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return [] as string[];
    }

    const maybePayload = yield* e.pipe(
      e.Effect.tryPromise({
        try: () => maybeResponse.value.json() as Promise<{ objects?: Array<{ package?: { name?: string } }> }>,
        catch: error => new NpmRegistryJsonParseError({ message: error instanceof Error ? error.message : String(error) }),
      }),
      e.Effect.map(payload => e.Option.some(payload)),
      e.Effect.catchTag("NpmRegistryJsonParseError", () =>
        e.Effect.succeed(e.Option.none<{ objects?: Array<{ package?: { name?: string } }> }>()),
      ),
    );
    if (e.Option.isNone(maybePayload)) {
      return [] as string[];
    }

    return (maybePayload.value.objects ?? [])
      .map((entry) => entry.package?.name)
      .filter((name): name is string => typeof name === "string" && isTemplatePackageName(name));
  });

  const queryLocalTemplatePackages = e.Effect.fn(function*() {
    if (!workspaceRoot) return [] as string[];

    const found = new Set<string>();
    const orgEntries = yield* listDirectoryNames(workspaceRoot);

    for (const orgEntry of orgEntries) {
      if (!orgEntry.startsWith("@")) continue;

      const orgPath = path.join(workspaceRoot, orgEntry);
      const orgIsDirectory = yield* isDirectory(orgPath);
      if (!orgIsDirectory) continue;

      const repoEntries = yield* listDirectoryNames(orgPath);
      for (const repoEntry of repoEntries) {
        const repoPath = path.join(orgPath, repoEntry);
        const repoIsDirectory = yield* isDirectory(repoPath);
        if (!repoIsDirectory) continue;

        const packageJsonPath = path.join(repoPath, "package.json");
        const packageName = yield* readPackageName(packageJsonPath);
        if (e.Option.isSome(packageName) && isTemplatePackageName(packageName.value)) {
          found.add(packageName.value);
          continue;
        }

        if (isTemplatePackageName(repoEntry)) {
          found.add(repoEntry);
        }
      }
    }

    return [...found];
  });

  return {
    requiredCLICommands: [],
    availableTemplates: e.Effect.gen(function*() {
      const [localTemplates, npmTemplates] = yield* e.Effect.all(
        [queryLocalTemplatePackages(), queryNpmTemplates()],
        { concurrency: "unbounded" },
      );

      return Array.from(new Set([...localTemplates, ...npmTemplates])).sort();
    }),
  };
}));
