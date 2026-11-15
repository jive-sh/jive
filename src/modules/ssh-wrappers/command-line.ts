import * as e from "effect";
import { parseArgs } from "node:util";

/**
 * Reads ssh's and ssh-keygen's arguments the way their getopt does, so a wrapper sees exactly the options the real
 * command will, and never mistakes a word of a remote command or a file name for one.
 */

/** One option as getopt reads it: its letter and, for an option that takes one, its value. */
export interface CommandLineOption {
  readonly letter: string;
  readonly value: e.Option.Option<string>;
}

interface OptionScan {
  readonly options: ReadonlyArray<CommandLineOption>;
  /** Where the operands start: the first word that is not an option, or the word after `--`. */
  readonly operandsStart: number;
  readonly terminatedByDoubleDash: boolean;
}

/** getopt over `args`, stopping at the first operand or `--`. `lettersWithValue` are the options that take a value. */
function scanOptions({ args, lettersWithValue }: { readonly args: ReadonlyArray<string>; readonly lettersWithValue: string }): OptionScan {
  const { tokens } = parseArgs({
    args: [...args],
    options: Object.fromEntries([...lettersWithValue].map((letter) => [`option-${letter}`, { type: "string" as const, short: letter }])),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const options: Array<CommandLineOption> = [];
  for (const token of tokens) {
    if (token.kind === "positional") return { options, operandsStart: token.index, terminatedByDoubleDash: false };
    if (token.kind === "option-terminator") return { options, operandsStart: token.index + 1, terminatedByDoubleDash: true };
    options.push({ letter: token.rawName.replace(/^-+/, ""), value: e.Option.fromUndefinedOr(token.value) });
  }
  return { options, operandsStart: args.length, terminatedByDoubleDash: false };
}

/** ssh's getopt string (OpenSSH's ssh.c): the letters followed by `:`. */
const SSH_LETTERS_WITH_VALUE = "BDEFIJLOPQRSWbceilmopw";

/**
 * ssh's options in `args`. ssh reads options before the destination and again right after it, up to the remote
 * command (ssh.c parses the words after the host once more unless `--` came first); the command's words are not ssh's.
 */
export function sshOptions(args: ReadonlyArray<string>): ReadonlyArray<CommandLineOption> {
  const beforeDestination = scanOptions({ args, lettersWithValue: SSH_LETTERS_WITH_VALUE });
  const destination = beforeDestination.operandsStart;
  if (beforeDestination.terminatedByDoubleDash || destination >= args.length) return beforeDestination.options;
  const afterDestination = scanOptions({ args: args.slice(destination + 1), lettersWithValue: SSH_LETTERS_WITH_VALUE });
  return [...beforeDestination.options, ...afterDestination.options];
}

/** ssh-keygen's getopt string (OpenSSH's ssh-keygen.c): the letters followed by `:`. */
const SSH_KEYGEN_LETTERS_WITH_VALUE = "CDEFIMNOPRVYZabfgjmnrstwz";

/** ssh-keygen's options in `args`, up to its first file operand. */
export function sshKeygenOptions(args: ReadonlyArray<string>): ReadonlyArray<CommandLineOption> {
  return scanOptions({ args, lettersWithValue: SSH_KEYGEN_LETTERS_WITH_VALUE }).options;
}

/** An `-o` value, `Keyword=argument` or `Keyword argument` as ssh_config reads it; keywords match in any case. */
export function sshConfigOption(value: string): { readonly keyword: string; readonly argument: string } {
  const match = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(value);
  return match === null ? { keyword: value.trim(), argument: "" } : { keyword: match[1]!, argument: match[2]! };
}
