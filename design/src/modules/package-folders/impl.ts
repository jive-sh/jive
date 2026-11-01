import { Effect, FileSystem, Layer, Option, Path, Schema, SchemaIssue, pipe } from "effect";
import type { PlatformError } from "effect";
import {
  FolderContents,
  PackageFolders,
  PackageManifestInvalid,
  type IPackageFolders,
  type PackageFolder,
} from "./interface";

const formatIssue = SchemaIssue.makeFormatterDefault();

const Dependencies = Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.String));

const Manifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Dependencies,
  devDependencies: Dependencies,
  peerDependencies: Dependencies,
  jive: Schema.OptionFromOptionalKey(
    Schema.Struct({
      "backend-convex": Schema.OptionFromOptionalKey(
        Schema.Struct({ clientPackageName: Schema.OptionFromOptionalKey(Schema.NonEmptyString) }),
      ),
    }),
  ),
});

const ABSTRACT_PREFIX = "jive-abstract-";

const isHidden = (entryName: string) => entryName.startsWith(".");

class PackageFoldersImpl implements IPackageFolders {
  constructor(
    private readonly fileSystem: FileSystem.FileSystem,
    private readonly path: Path.Path,
  ) {}

  *list(
    packagesRoot: string,
  ): Effect.fn.Return<ReadonlyArray<PackageFolder>, PackageManifestInvalid | PlatformError.PlatformError> {
    const folderPaths: Array<string> = [];
    for (const entry of yield* this.childDirectories(packagesRoot)) {
      if (entry.startsWith("@")) {
        for (const scoped of yield* this.childDirectories(this.path.join(packagesRoot, entry))) {
          folderPaths.push(`${entry}/${scoped}`);
        }
      } else {
        folderPaths.push(entry);
      }
    }
    const folders: Array<PackageFolder> = [];
    for (const folderPath of folderPaths) {
      folders.push(yield* this.readFolder(this.path.join(packagesRoot, folderPath), folderPath));
    }
    return folders;
  }

  private *childDirectories(directory: string): Effect.fn.Return<ReadonlyArray<string>, PlatformError.PlatformError> {
    const directories: Array<string> = [];
    for (const entry of (yield* this.fileSystem.readDirectory(directory)).toSorted()) {
      if (isHidden(entry)) continue;
      const info = yield* this.fileSystem.stat(this.path.join(directory, entry));
      if (info.type === "Directory") directories.push(entry);
    }
    return directories;
  }

  private *readFolder(
    folder: string,
    folderPath: string,
  ): Effect.fn.Return<PackageFolder, PackageManifestInvalid | PlatformError.PlatformError> {
    const manifestPath = this.path.join(folder, "package.json");
    if (yield* this.fileSystem.exists(manifestPath)) {
      const manifest = yield* pipe(
        this.fileSystem.readFileString(manifestPath),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(new PackageManifestInvalid({ path: manifestPath, reason: formatIssue(error.issue) })),
        ),
      );
      const dependencyNames = new Set(
        [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].flatMap((field) =>
          Option.match(field, { onNone: () => [], onSome: (dependencies) => Object.keys(dependencies) }),
        ),
      );
      return {
        name: manifest.name,
        path: folderPath,
        contents: FolderContents.Manifest({
          hasJiveBlock: Option.isSome(manifest.jive),
          abstractDependencies: [...dependencyNames]
            .filter((name) => name.startsWith(ABSTRACT_PREFIX) && name !== manifest.name)
            .toSorted(),
          generatedClientName: pipe(
            manifest.jive,
            Option.flatMap((jive) => jive["backend-convex"]),
            Option.flatMap((backend) => backend.clientPackageName),
          ),
        }),
      };
    }
    const files = yield* this.visibleFiles(folder);
    return {
      name: folderPath,
      path: folderPath,
      contents:
        files.length === 0
          ? FolderContents.Empty()
          : files.every((file) => file.endsWith(".md"))
            ? FolderContents.DocsOnly()
            : FolderContents.Stub(),
    };
  }

  private *visibleFiles(directory: string): Effect.fn.Return<ReadonlyArray<string>, PlatformError.PlatformError> {
    const files: Array<string> = [];
    for (const entry of yield* this.fileSystem.readDirectory(directory)) {
      if (isHidden(entry) || entry === "node_modules") continue;
      const entryPath = this.path.join(directory, entry);
      const info = yield* this.fileSystem.stat(entryPath);
      if (info.type === "Directory") files.push(...(yield* this.visibleFiles(entryPath)));
      else files.push(entryPath);
    }
    return files;
  }
}

export const PackageFoldersLive = Layer.effect(
  PackageFolders,
  Effect.gen(function* () {
    return new PackageFoldersImpl(yield* FileSystem.FileSystem, yield* Path.Path);
  }),
);
