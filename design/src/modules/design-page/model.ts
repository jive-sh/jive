import { Data } from "effect";
import type { Option } from "effect";
import type { OpenDecision } from "../design-data/interface";

/** The badge on a package row. */
export type PackageStatus = Data.TaggedEnum<{
  Published: { readonly version: string };
  /** Work in progress, noted by hand; `next` is the step being built. */
  Building: { readonly publishedVersion: Option.Option<string>; readonly next: string };
  /** Has a package.json, not on npm. */
  Built: {};
  Empty: {};
  DocsOnly: {};
  Stub: {};
  /** Listed as proposed in the design data; no folder yet. */
  Proposed: {};
}>;
export const PackageStatus = Data.taggedEnum<PackageStatus>();

export interface PackageRow {
  readonly name: string;
  readonly status: PackageStatus;
  readonly purpose: Option.Option<string>;
  /** Packages that extend this one (or, for a backend, the client it publishes). */
  readonly children: ReadonlyArray<PackageRow>;
}

export interface GroupSection {
  readonly label: string;
  readonly description: Option.Option<string>;
  readonly rows: ReadonlyArray<PackageRow>;
}

/** A package that should no longer exist, with what of it is left. */
export interface PackageToDeleteRow {
  readonly name: string;
  readonly reason: string;
  readonly publishedVersion: Option.Option<string>;
  readonly folderPath: Option.Option<string>;
}

/** The badge on a jive CLI row; a group, like `jive git`, has none. */
export type CliCommandStatus = "Implemented" | "Stub" | "Group";

export interface CliCommandRow {
  /** The full command: "jive git setup". */
  readonly command: string;
  readonly status: CliCommandStatus;
  readonly description: Option.Option<string>;
  readonly children: ReadonlyArray<CliCommandRow>;
}

export interface CliDoc {
  /** From the repository root. */
  readonly path: string;
  /** Its file:// URL; none while the doc is not written. */
  readonly url: Option.Option<string>;
}

export interface CliSection {
  /** The command whose help the rows come from. */
  readonly source: string;
  readonly commands: ReadonlyArray<CliCommandRow>;
  readonly docs: ReadonlyArray<CliDoc>;
}

export interface DesignPage {
  readonly openDecisions: ReadonlyArray<OpenDecision>;
  readonly packagesToDelete: ReadonlyArray<PackageToDeleteRow>;
  readonly groups: ReadonlyArray<GroupSection>;
  readonly cli: CliSection;
}

/** A package depends on more than one jive-abstract-* package, none of which extends the others. */
export class AmbiguousExtends extends Data.TaggedError("AmbiguousExtends")<{
  readonly packageName: string;
  readonly candidates: ReadonlyArray<string>;
}> {}

/** These packages extend each other in a loop, so no row in their group can hold them. */
export class ExtendsCycle extends Data.TaggedError("ExtendsCycle")<{
  readonly packageNames: ReadonlyArray<string>;
}> {}
