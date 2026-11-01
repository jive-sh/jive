import { Option } from "effect";

export interface HelpListing {
  readonly name: string;
  readonly description: Option.Option<string>;
}

const COMMAND_LINE = /^ {2}(\S+)(?:\s{2,}(\S.*?))?\s*$/;

/**
 * The "Commands:" section of a jive help page: one "  name   description" line per command, up to the first line
 * that is not one. None when the output is not a help page.
 */
export const parseHelp = (output: string): Option.Option<ReadonlyArray<HelpListing>> => {
  const lines = output.split("\n");
  if (!lines[0]?.startsWith("Usage: ")) return Option.none();
  const start = lines.indexOf("Commands:");
  if (start === -1) return Option.some([]);
  const listings: Array<HelpListing> = [];
  for (const line of lines.slice(start + 1)) {
    const match = COMMAND_LINE.exec(line);
    if (match === null) break;
    listings.push({ name: match[1]!, description: Option.fromNullishOr(match[2]) });
  }
  return Option.some(listings);
};
