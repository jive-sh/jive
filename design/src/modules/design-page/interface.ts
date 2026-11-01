import { Context } from "effect";
import type { Effect, PlatformError } from "effect";
import type { DesignDataInvalid } from "../design-data/interface";
import type { JiveCliHelpUnreadable } from "../jive-cli/interface";
import type { NpmRegistryUnreachable } from "../npm-registry/interface";
import type { PackageManifestInvalid } from "../package-folders/interface";
import type { AmbiguousExtends, ExtendsCycle } from "./model";

export interface GeneratedDesignPage {
  readonly html: string;
  /** Design data entries that no longer match the packages or the CLI, each with what to change. */
  readonly staleNotes: ReadonlyArray<string>;
}

export interface GenerateInput {
  readonly designDataPath: string;
  readonly packagesRoot: string;
  /** Where the jive CLI runs and the design data's doc paths start. */
  readonly repoRoot: string;
  /** The jive CLI's entrypoint, from `repoRoot`. */
  readonly jiveCliEntrypoint: string;
}

export interface IDesignPageGenerator {
  /** Builds the page from the design data, the package folders under `packagesRoot`, npm, and the jive CLI's help. */
  generate(input: GenerateInput): Effect.fn.Return<
    GeneratedDesignPage,
    | DesignDataInvalid
    | PackageManifestInvalid
    | PlatformError.PlatformError
    | NpmRegistryUnreachable
    | AmbiguousExtends
    | ExtendsCycle
    | JiveCliHelpUnreadable
  >;
}

export class DesignPageGenerator extends Context.Service<DesignPageGenerator, IDesignPageGenerator>()(
  "DesignPageGenerator",
) {}
