import { pathToFileURL } from "node:url";
import { Array, Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect";
import { DesignDataFile, type IDesignDataFile } from "../design-data/interface";
import { JiveCli, type IJiveCli } from "../jive-cli/interface";
import { NpmRegistry, type INpmRegistry } from "../npm-registry/interface";
import { PackageFolders, type IPackageFolders } from "../package-folders/interface";
import { deriveCliSection } from "./cli";
import { deriveDesignPage, packagesToLookUp } from "./derive";
import { DesignPageGenerator, type GenerateInput, type IDesignPageGenerator } from "./interface";
import { renderDesignPage } from "./render";

class DesignPageGeneratorImpl implements IDesignPageGenerator {
  constructor(
    private readonly designDataFile: IDesignDataFile,
    private readonly packageFolders: IPackageFolders,
    private readonly npmRegistry: INpmRegistry,
    private readonly jiveCli: IJiveCli,
    private readonly fileSystem: FileSystem.FileSystem,
    private readonly path: Path.Path,
  ) {}

  *generate(input: GenerateInput) {
    const data = yield* this.designDataFile.load(input.designDataPath);
    const folders = yield* this.packageFolders.list(input.packagesRoot);
    const names = packagesToLookUp({ data, folders });
    yield* Effect.log(
      `Read ${input.designDataPath} and ${folders.length} package folders under ${input.packagesRoot}; looking up ${names.length} packages on npm`,
    );
    const npmRegistry = this.npmRegistry;
    const versions = new Map(
      yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            return [name, yield* npmRegistry.latestVersion(name)] as const;
          }),
        { concurrency: 8 },
      ),
    );
    const { page, staleNotes } = yield* deriveDesignPage({
      data,
      folders,
      publishedVersionOf: (name) => Option.flatten(Option.fromNullishOr(versions.get(name))),
    });
    const cli = deriveCliSection({
      notes: data.jiveCli,
      source: `bun ${input.jiveCliEntrypoint} --help`,
      commands: yield* this.jiveCli.commands({ entrypoint: input.jiveCliEntrypoint, cwd: input.repoRoot }),
      existingDocUrls: new Map(
        Array.getSomes(
          yield* Effect.forEach(data.jiveCli.docs, (doc) => Effect.gen(() => this.existingDocUrl(input.repoRoot, doc))),
        ),
      ),
    });
    return { html: renderDesignPage({ ...page, cli: cli.section }), staleNotes: [...staleNotes, ...cli.staleNotes] };
  }

  /** The doc's file:// URL, when it exists. */
  private *existingDocUrl(
    repoRoot: string,
    doc: string,
  ): Effect.fn.Return<Option.Option<readonly [string, string]>, PlatformError.PlatformError> {
    const absolutePath = this.path.join(repoRoot, doc);
    return (yield* this.fileSystem.exists(absolutePath))
      ? Option.some([doc, pathToFileURL(absolutePath).href] as const)
      : Option.none();
  }
}

export const DesignPageGeneratorLive = Layer.effect(
  DesignPageGenerator,
  Effect.gen(function* () {
    return new DesignPageGeneratorImpl(
      yield* DesignDataFile,
      yield* PackageFolders,
      yield* NpmRegistry,
      yield* JiveCli,
      yield* FileSystem.FileSystem,
      yield* Path.Path,
    );
  }),
);
