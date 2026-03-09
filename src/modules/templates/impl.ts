import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import * as modules from "@/modules";
import { TEMPLATE_PREFIX } from "@/modules/templates/constants";

export const TemplatesImpl = e.Layer.effect(modules.ITemplates, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;

  const isTemplatePackageName = (name: string): boolean =>
    name.startsWith(TEMPLATE_PREFIX) || name.includes(`/${TEMPLATE_PREFIX}`);

  const listDirectoryNames = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.readDirectory(targetPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed([] as string[])),
    );
  });

  const isDirectory = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.stat(targetPath).pipe(
      e.Effect.map((info) => info.type === "Directory"),
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
  });

  const readPackageName = e.Effect.fn(function*(packageJsonPath: string) {
    const contents = yield* fileSystem.readFileString(packageJsonPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed("")),
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
    const response = yield* e.Effect.promise(() =>
      fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(TEMPLATE_PREFIX)}&size=250`),
    ).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(undefined as Response | undefined)),
    );

    if (!response || !response.ok) return [] as string[];

    const payload = yield* e.Effect.promise(() =>
      response.json() as Promise<{ objects?: Array<{ package?: { name?: string } }> }>,
    ).pipe(
      e.Effect.catchAll(() => e.Effect.succeed({} as { objects?: Array<{ package?: { name?: string } }> })),
    );

    return (payload.objects ?? [])
      .map((entry) => entry.package?.name)
      .filter((name): name is string => typeof name === "string" && isTemplatePackageName(name));
  });

  const queryLocalTemplatePackages = e.Effect.fn(function*() {
    if (e.Option.isNone(toolState.workspaceRoot)) return [] as string[];

    const found = new Set<string>();
    const orgEntries = yield* listDirectoryNames(toolState.workspaceRoot.value);

    for (const orgEntry of orgEntries) {
      if (!orgEntry.startsWith("@")) continue;

      const orgPath = path.join(toolState.workspaceRoot.value, orgEntry);
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

  const availableTemplates = e.Effect.fn(function*() {
    const [localTemplates, npmTemplates] = yield* e.Effect.all(
      [queryLocalTemplatePackages(), queryNpmTemplates()],
      { concurrency: "unbounded" },
    );

    return Array.from(new Set([...localTemplates, ...npmTemplates])).sort();
  })();

  return {
    requiredCLICommands: [],
    availableTemplates,
  };
}));
