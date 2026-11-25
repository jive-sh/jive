/**
 * A command jive runs, as the person would type it in a POSIX shell: the program, each leading option that takes a
 * value on a line of its own (`-c key=value`, `-C <dir>`), and the subcommand with its arguments on the last line.
 */
export interface ShellCommand {
  readonly program: string;
  readonly optionLines: ReadonlyArray<ReadonlyArray<string>>;
  readonly arguments: ReadonlyArray<string>;
}

/** Words a shell passes through as they are; anything else is single-quoted. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `word` as a shell needs it typed to receive it unchanged: as it is, or single-quoted with `'` written as `'\''`. */
export const shellQuote = (word: string): string => SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The command as text a shell runs when pasted: one line when it has no option lines, otherwise one line per option with
 * ` \` continuations, the arguments last.
 */
export function formatShellCommand({ program, optionLines, arguments: commandArguments }: ShellCommand): string {
  const words = (line: ReadonlyArray<string>) => line.map(shellQuote).join(" ");
  if (optionLines.length === 0) return words([program, ...commandArguments]);
  return [shellQuote(program), ...[...optionLines, commandArguments].map((line) => `  ${words(line)}`)].join(" \\\n");
}
