import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import { NoTerminalToAsk, type IPrompt } from "./interface";

/**
 * Asks on the terminal through Effect's `Terminal`. Effect's `Terminal` doesn't say whether input is a terminal, so
 * that one fact is read from the process's stdin here, the only place jive reads it.
 */
export class TerminalPromptImpl extends implementing(modules.prompt).uses(e.Terminal.Terminal) implements IPrompt {
  *ask(question: string): EffectGen<string, NoTerminalToAsk> {
    if (process.stdin.isTTY !== true) return yield* new NoTerminalToAsk();
    const terminal = this.getDependency(e.Terminal.Terminal);
    yield* e.pipe(terminal.display(`${question} `), e.Effect.mapError(() => new NoTerminalToAsk()));
    // A closed input (Ctrl-D) or Ctrl-C answers with nothing.
    const answer = yield* e.pipe(terminal.readLine, e.Effect.catchTag("QuitError", () => e.Effect.succeed("")));
    return answer.trim();
  }
}
