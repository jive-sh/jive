import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Layer, Option, Path, pipe } from "effect";
import { FetchHttpClient } from "effect/http";
import { DesignDataFileLive } from "./modules/design-data/impl";
import { DesignPageGeneratorLive } from "./modules/design-page/impl";
import { DesignPageGenerator } from "./modules/design-page/interface";
import { JiveCliLive } from "./modules/jive-cli/impl";
import { NpmRegistryLive } from "./modules/npm-registry/impl";
import { PackageFoldersLive } from "./modules/package-folders/impl";

/** The page's Packages section reads every package folder, which only a monorepo checkout has. */
class NotInsideMonorepo extends Data.TaggedError("NotInsideMonorepo")<{ readonly jiveRoot: string }> {
  override get message() {
    return `${this.jiveRoot} is not at packages/@jive-sh/jive in a monorepo, so there are no package folders to read. Run this from a monorepo that loads jive-sh/jive there.`;
  }
}

/** The monorepo's packages/ folder, when this checkout of jive-sh/jive sits at packages/@jive-sh/jive in one. */
const monorepoPackagesRoot = Effect.fn(function* (jiveRoot: string) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const packagesRoot = path.resolve(jiveRoot, "../..");
  const realPathOf = (target: string) => Effect.option(fileSystem.realPath(target));
  const jiveInPackages = yield* realPathOf(path.join(packagesRoot, "@jive-sh", "jive"));
  const jive = yield* realPathOf(jiveRoot);
  const isInside =
    path.basename(packagesRoot) === "packages" &&
    Option.isSome(jive) &&
    Option.getOrUndefined(jiveInPackages) === jive.value;
  return isInside ? packagesRoot : yield* new NotInsideMonorepo({ jiveRoot });
});

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const designDirectory = path.resolve(import.meta.dir, "..");
  const jiveRoot = path.resolve(designDirectory, "..");
  const outputPath = path.join(designDirectory, "jive_design.html");
  const { html, staleNotes } = yield* (yield* DesignPageGenerator).generate({
    designDataPath: path.join(designDirectory, "design.json"),
    packagesRoot: yield* monorepoPackagesRoot(jiveRoot),
    repoRoot: jiveRoot,
    jiveCliEntrypoint: "src/entrypoints/jive.ts",
  });
  for (const note of staleNotes) yield* Effect.logWarning(`design.json: ${note}`);
  yield* (yield* FileSystem.FileSystem).writeFileString(outputPath, html);
  yield* Effect.log(`Wrote ${outputPath}`);
});

const layer = pipe(
  DesignPageGeneratorLive,
  Layer.provideMerge(Layer.mergeAll(DesignDataFileLive, PackageFoldersLive, NpmRegistryLive, JiveCliLive)),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(BunServices.layer),
);

BunRuntime.runMain(Effect.provide(program, layer));
