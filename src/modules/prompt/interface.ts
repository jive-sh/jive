import * as e from "effect";
import type { EffectGen } from "effective-modules";

/** jive's input is not a terminal (a pipe, a file, a CI job), so there is nobody to answer a question. */
export class NoTerminalToAsk extends e.Data.TaggedError("NoTerminalToAsk")<{}> {}

/** Questions jive asks the person running it, on the terminal it runs in. */
export interface IPrompt {
  /**
   * Asks `question` with a yes-or-no answer, no being the default: only `y` or `yes` (any case) is yes. Fails with
   * `NoTerminalToAsk` when jive's input is not a terminal, without asking.
   */
  confirm(question: string): EffectGen<boolean, NoTerminalToAsk>;
  /** Asks `question` and returns the line typed, trimmed. Fails with `NoTerminalToAsk` as `confirm` does. */
  ask(question: string): EffectGen<string, NoTerminalToAsk>;
}

/** Whether a typed answer to `confirm` is yes: `y` or `yes` in any case, around any spaces; everything else is no. */
export const isYes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());
