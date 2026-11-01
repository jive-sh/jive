import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";

export const OpenDecision = Schema.Struct({
  title: Schema.NonEmptyString,
  text: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  options: Schema.OptionFromOptionalKey(Schema.Array(Schema.NonEmptyString)),
});
export type OpenDecision = Schema.Schema.Type<typeof OpenDecision>;

const groupFields = {
  label: Schema.NonEmptyString,
  description: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
};

export const PrefixGroup = Schema.Struct({ ...groupFields, namePrefix: Schema.NonEmptyString });
export type PrefixGroup = Schema.Schema.Type<typeof PrefixGroup>;

export const Group = Schema.Struct(groupFields);
export type Group = Schema.Schema.Type<typeof Group>;

export const PackageNote = Schema.Struct({
  name: Schema.NonEmptyString,
  purpose: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  group: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  building: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  proposed: Schema.OptionFromOptionalKey(
    Schema.Struct({ extends: Schema.OptionFromOptionalKey(Schema.NonEmptyString) }),
  ),
});
export type PackageNote = Schema.Schema.Type<typeof PackageNote>;

export const PackageToDelete = Schema.Struct({ name: Schema.NonEmptyString, reason: Schema.NonEmptyString });
export type PackageToDelete = Schema.Schema.Type<typeof PackageToDelete>;

/** What the jive CLI's help does not say. */
export const JiveCliNotes = Schema.Struct({
  /** Commands that exist but do nothing yet, as the words after `jive`: "create". */
  stubs: Schema.Array(Schema.NonEmptyString),
  /** Docs about the CLI, as paths from the repository root. */
  docs: Schema.Array(Schema.NonEmptyString),
});
export type JiveCliNotes = Schema.Schema.Type<typeof JiveCliNotes>;

export const DesignData = Schema.Struct({
  openDecisions: Schema.Array(OpenDecision),
  packagesToDelete: Schema.Array(PackageToDelete),
  groups: Schema.Array(PrefixGroup),
  groupForOtherPackages: Group,
  packages: Schema.Array(PackageNote),
  jiveCli: JiveCliNotes,
});
export type DesignData = Schema.Schema.Type<typeof DesignData>;

export class DesignDataInvalid extends Data.TaggedError("DesignDataInvalid")<{
  readonly path: string;
  readonly reason: string;
}> {}

export interface IDesignDataFile {
  /** Reads and validates the hand-kept design data, including that every group a package names exists. */
  load(path: string): Effect.fn.Return<DesignData, DesignDataInvalid>;
}

export class DesignDataFile extends Context.Service<DesignDataFile, IDesignDataFile>()("DesignDataFile") {}
