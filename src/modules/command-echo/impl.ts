import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { ICommandEcho } from "./interface";
import { formatShellCommand, type ShellCommand } from "./shell-command";

/** ANSI cyan, the terminal's teal, and the reset after it. */
const TEAL = "\u001b[36m";
const RESET = "\u001b[0m";

/**
 * Writes through Effect's `Stdio`, which says whether stderr is a terminal. NO_COLOR (https://no-color.org: set to any
 * value but the empty string) is read from the process's environment here, the only place jive reads it.
 */
export class CommandEchoImpl extends implementing(modules.commandEcho).uses(e.Stdio.Stdio) implements ICommandEcho {
  *show(command: ShellCommand): EffectGen<void> {
    const stdio = this.getDependency(e.Stdio.Stdio);
    const noColor = process.env["NO_COLOR"];
    const colored = (yield* stdio.stderrIsTerminal) && (noColor === undefined || noColor === "");
    const text = formatShellCommand(command);
    // A command echo that can't be written leaves the command itself to run.
    yield* e.Effect.ignore(e.Stream.run(e.Stream.make(colored ? `${TEAL}${text}${RESET}\n` : `${text}\n`), stdio.stderr()));
  }
}
