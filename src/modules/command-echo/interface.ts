import type { EffectGen } from "effective-modules";
import type { ShellCommand } from "./shell-command";

/**
 * How jive shows the person each command it runs with its output on their terminal, just before running it: the
 * command itself, as a shell command they could paste from where they ran jive (Alex, 2026-11-25: "Just the actual
 * running command colored teal perhaps ... just like a normal multiline shell call").
 */
export interface ICommandEcho {
  /** Writes `command` to stderr, in teal when stderr is a terminal and NO_COLOR is not set to a value. */
  show(command: ShellCommand): EffectGen<void>;
}
