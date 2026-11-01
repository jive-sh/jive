import { Context, Data } from "effect";
import type { Effect, Option, PlatformError } from "effect";

/** What a folder under packages/ holds. */
export type FolderContents = Data.TaggedEnum<{
  /** Has a package.json. */
  Manifest: {
    readonly hasJiveBlock: boolean;
    /** The jive-abstract-* packages it depends on, in any dependency field. */
    readonly abstractDependencies: ReadonlyArray<string>;
    /** The client package a jive-abstract-backend-convex backend publishes, from `jive["backend-convex"].clientPackageName`. */
    readonly generatedClientName: Option.Option<string>;
  };
  /** No files at all (dotfiles aside). */
  Empty: {};
  /** Only Markdown files. */
  DocsOnly: {};
  /** Files, but no package.json. */
  Stub: {};
}>;
export const FolderContents = Data.taggedEnum<FolderContents>();

export interface PackageFolder {
  /** The package.json name, or the folder path under packages/ when there is no package.json. */
  readonly name: string;
  /** The folder under packages/, such as `@jive-sh/server`. */
  readonly path: string;
  readonly contents: FolderContents;
}

export class PackageManifestInvalid extends Data.TaggedError("PackageManifestInvalid")<{
  readonly path: string;
  readonly reason: string;
}> {}

export interface IPackageFolders {
  /** Lists every package folder: packages/<name> and packages/@<scope>/<name>. */
  list(packagesRoot: string): Effect.fn.Return<ReadonlyArray<PackageFolder>, PackageManifestInvalid | PlatformError.PlatformError>;
}

export class PackageFolders extends Context.Service<PackageFolders, IPackageFolders>()("PackageFolders") {}
