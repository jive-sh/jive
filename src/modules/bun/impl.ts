import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import { LinkResult, LinkScope, type IBun, type WorkspaceLink } from "./interface";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** A dependent naming one of these already chose a local copy itself. */
const LOCAL_SPECIFIER = /^(link|file|workspace|portal):/;

const Dependencies = e.Schema.optionalKey(e.Schema.Record(e.Schema.String, e.Schema.String));
const PackageManifest = e.Schema.fromJsonString(e.Schema.Struct({
  name: e.Schema.optionalKey(e.Schema.String),
  version: e.Schema.optionalKey(e.Schema.String),
  main: e.Schema.optionalKey(e.Schema.Unknown),
  module: e.Schema.optionalKey(e.Schema.Unknown),
  exports: e.Schema.optionalKey(e.Schema.Unknown),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
  peerDependencies: Dependencies,
}));
type PackageManifest = typeof PackageManifest.Type;

interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  /** The directory with every symlink resolved, which is what two paths to one package share. */
  readonly realDirectory: string;
  readonly manifest: PackageManifest;
}

export class BunImpl extends implementing(modules.bun).uses(modules.toolState, OSPlatform, e.FileSystem.FileSystem) implements IBun {
  *install(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { absolutePath } = yield* this.dependencies.toolState.verifyRepoIntegrity(repo);
    yield* this.bunIn(absolutePath, repo.packageName(), ["install"]);
  }

  *linkWorkspace({ repositories, scope }: { readonly repositories: ReadonlyArray<string>; readonly scope: LinkScope }): EffectGen<ReadonlyArray<WorkspaceLink>, BadPreconditionsError> {
    const packages = yield* this.workspacePackages(repositories);
    const scopeDirectory = scope._tag === "Workspace" ? e.Option.none<string>() : e.Option.some(yield* this.realPath(scope.directory));
    const byName = new Map<string, Array<WorkspacePackage>>();
    for (const workspacePackage of packages) byName.set(workspacePackage.name, [...(byName.get(workspacePackage.name) ?? []), workspacePackage]);
    const links: Array<WorkspaceLink> = [];
    for (const dependent of packages) {
      for (const [dependencyName, specifier] of dependenciesOf(dependent.manifest)) {
        const candidates = byName.get(dependencyName);
        if (candidates === undefined || dependencyName === dependent.name || !inScope({ scope, scopeDirectory, dependent: dependent.realDirectory, dependency: candidates[0]!.realDirectory })) continue;
        const dependency = candidates[0]!;
        links.push({
          dependent: dependent.name,
          dependency: dependencyName,
          specifier,
          checkoutVersion: dependency.version,
          specifierSatisfied: Bun.semver.satisfies(dependency.version, specifier),
          result: candidates.length > 1
            ? LinkResult.SameName({ directories: candidates.map(candidate => candidate.directory) })
            : yield* this.link({ dependent, dependency, specifier }),
        });
      }
    }
    return links;
  }

  *unlinkPackage({ repositories, packageDirectory }: { readonly repositories: ReadonlyArray<string>; readonly packageDirectory: string }): EffectGen<ReadonlyArray<string>, BadPreconditionsError> {
    if (!(yield* this.pathExistsWithoutFollowing(packageDirectory))) return [];
    const packages = yield* this.workspacePackages(repositories);
    const removedRealPath = yield* this.realPath(packageDirectory);
    const removed = packages.find(workspacePackage => workspacePackage.realDirectory === removedRealPath);
    if (removed === undefined) return [];
    const reinstalled: Array<string> = [];
    for (const dependent of packages) {
      if (dependent === removed) continue;
      const linkPath = nodeModulesEntry(dependent.directory, removed.name);
      if (!(yield* this.isSymlink(linkPath))) continue;
      const target = yield* this.realPath(linkPath);
      if (target !== removedRealPath && !target.startsWith(`${removedRealPath}${path.sep}`)) continue;
      yield* this.removePath(linkPath);
      yield* this.bunIn(dependent.directory, dependent.name, ["install"]);
      reinstalled.push(dependent.name);
    }
    return reinstalled;
  }

  /** Points the dependent's `node_modules/<dependency>` at the dependency's checkout, unless something stops it. */
  private *link({ dependent, dependency, specifier }: { readonly dependent: WorkspacePackage; readonly dependency: WorkspacePackage; readonly specifier: string }): EffectGen<LinkResult, BadPreconditionsError> {
    if (LOCAL_SPECIFIER.test(specifier)) return LinkResult.LocalSpecifier();
    const linkPath = nodeModulesEntry(dependent.directory, dependency.name);
    if (!(yield* this.pathExistsWithoutFollowing(linkPath))) return LinkResult.NotInstalled();
    const maybeTarget = yield* this.linkTarget(dependency);
    if (maybeTarget._tag !== "Linked") return maybeTarget;
    const { target } = maybeTarget;
    if ((yield* this.isSymlink(linkPath)) && (yield* this.realPath(linkPath)) === (yield* this.realPath(target))) return maybeTarget;
    yield* this.removePath(linkPath);
    // Relative, as `bun link` writes it, so the link survives the workspace moving.
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).symlink(path.relative(path.dirname(linkPath), target), linkPath),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to link ${linkPath} to ${target}`, message)),
    );
    return maybeTarget;
  }

  /**
   * Where a dependent's link to `dependency` points. A package whose source package.json names an entry point is
   * imported from its checkout. One built by a Jive abstract names none (the build writes `exports`), so it is imported
   * from the build jive-abstract-library writes to `dist/base`, which must be of the checkout's version; a local build
   * stamps it `<version>-local`.
   */
  private *linkTarget(dependency: WorkspacePackage): EffectGen<LinkResult, BadPreconditionsError> {
    const { manifest } = dependency;
    if (manifest.main !== undefined || manifest.module !== undefined || manifest.exports !== undefined) {
      return LinkResult.Linked({ target: dependency.directory });
    }
    const build = path.join(dependency.directory, "dist", "base");
    const maybeBuilt = yield* this.readManifest(build);
    if (e.Option.isNone(maybeBuilt) || maybeBuilt.value.name !== dependency.name) return LinkResult.NotBuilt();
    const builtVersion = maybeBuilt.value.version ?? "";
    if (builtVersion !== dependency.version && builtVersion !== `${dependency.version}-local`) {
      return LinkResult.StaleBuild({ builtVersion });
    }
    return LinkResult.Linked({ target: build });
  }

  /** Every repository among `repositories` whose package.json names a package. */
  private *workspacePackages(repositories: ReadonlyArray<string>): EffectGen<ReadonlyArray<WorkspacePackage>, BadPreconditionsError> {
    const packages: Array<WorkspacePackage> = [];
    for (const directory of repositories) {
      const maybeManifest = yield* this.readManifest(directory);
      if (e.Option.isNone(maybeManifest) || maybeManifest.value.name === undefined) continue;
      packages.push({ name: maybeManifest.value.name, version: maybeManifest.value.version ?? "", directory, realDirectory: yield* this.realPath(directory), manifest: maybeManifest.value });
    }
    return packages;
  }

  /** The package.json in `directory`; none when it has none, or one that isn't a package manifest. */
  private *readManifest(directory: string): EffectGen<e.Option.Option<PackageManifest>> {
    const file = path.join(directory, "package.json");
    const fs = this.getDependency(e.FileSystem.FileSystem);
    if (!(yield* e.pipe(fs.exists(file), e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false))))) return e.Option.none();
    return yield* e.pipe(
      fs.readFileString(file),
      e.Effect.flatMap(e.Schema.decodeUnknownEffect(PackageManifest)),
      e.Effect.map(e.Option.some),
      e.Effect.catchTags({
        PlatformError: () => e.Effect.succeed(e.Option.none()),
        SchemaError: () => e.Effect.succeed(e.Option.none()),
      }),
    );
  }

  private *bunIn(directory: string, packageName: string, args: ReadonlyArray<string>): EffectGen<void, BadPreconditionsError> {
    const commandLine = `bun ${args.join(" ")}`;
    yield* e.Effect.log(`Running ${commandLine} in ${packageName}`);
    const { exitCode } = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({ command: "bun", args, cwd: directory, stdout: "inherit", stderr: "inherit" })),
      e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run ${commandLine}`, message)),
    );
    if (exitCode !== 0) {
      return yield* new BadPreconditionsError({
        cause: `${commandLine} in ${packageName} exited with code ${exitCode}`,
        fix: "Fix what bun reported, then run the command again",
      });
    }
  }

  private *pathExistsWithoutFollowing(target: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).lstat(target),
      e.Effect.as(true),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *isSymlink(target: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).lstat(target),
      e.Effect.map(info => info.type === "SymbolicLink"),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *realPath(target: string): EffectGen<string, BadPreconditionsError> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).realPath(target),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to resolve ${target}`, message)),
    );
  }

  private *removePath(target: string): EffectGen<void, BadPreconditionsError> {
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).remove(target, { recursive: true, force: true }),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to remove ${target}`, message)),
    );
  }
}

/** Each workspace dependency once, from the first field naming it (a runtime dependency before a dev or peer one). */
function dependenciesOf(manifest: PackageManifest): ReadonlyMap<string, string> {
  const dependencies = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (!dependencies.has(name)) dependencies.set(name, specifier);
    }
  }
  return dependencies;
}

function inScope({ scope, scopeDirectory, dependent, dependency }: { readonly scope: LinkScope; readonly scopeDirectory: e.Option.Option<string>; readonly dependent: string; readonly dependency: string }): boolean {
  return e.pipe(scope, LinkScope.$match({
    Workspace: () => true,
    Touching: () => e.Option.contains(scopeDirectory, dependent) || e.Option.contains(scopeDirectory, dependency),
  }));
}

function nodeModulesEntry(directory: string, packageName: string): string {
  return path.join(directory, "node_modules", ...packageName.split("/"));
}
