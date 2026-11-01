import { Option } from "effect";
import type { JiveCliNotes } from "../design-data/interface";
import type { CliCommand } from "../jive-cli/interface";
import type { CliCommandRow, CliSection } from "./model";

export interface DerivedCliSection {
  readonly section: CliSection;
  /** jiveCli entries that no longer match the CLI, each with what to change. */
  readonly staleNotes: ReadonlyArray<string>;
}

const allCommands = (commands: ReadonlyArray<CliCommand>): ReadonlyArray<CliCommand> =>
  commands.flatMap((command) => [command, ...allCommands(command.subcommands)]);

/** The CLI rows from its help, with the stubs the design data names, and a link to each of its docs that exists. */
export const deriveCliSection = (input: {
  readonly notes: JiveCliNotes;
  readonly source: string;
  readonly commands: ReadonlyArray<CliCommand>;
  /** The file:// URL of each doc that exists, by its path from the repository root. */
  readonly existingDocUrls: ReadonlyMap<string, string>;
}): DerivedCliSection => {
  const stubs = new Set(input.notes.stubs);
  const toRow = (command: CliCommand): CliCommandRow => ({
    command: ["jive", ...command.words].join(" "),
    status: command.subcommands.length > 0 ? "Group" : stubs.has(command.words.join(" ")) ? "Stub" : "Implemented",
    description: command.description,
    children: command.subcommands.map(toRow),
  });
  const listed = new Set(allCommands(input.commands).map((command) => command.words.join(" ")));
  return {
    section: {
      source: input.source,
      commands: input.commands.map(toRow),
      docs: input.notes.docs.map((path) => ({ path, url: Option.fromNullishOr(input.existingDocUrls.get(path)) })),
    },
    staleNotes: input.notes.stubs
      .filter((stub) => !listed.has(stub))
      .map((stub) => `jiveCli.stubs: "jive ${stub}" is not in the CLI's help: delete it`),
  };
};
