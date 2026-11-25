import * as e from "effect";
import type { EffectGen } from "effective-modules";

/** jive's input is not a terminal (a pipe, a file, a CI job), so there is nobody to answer a question. */
export class NoTerminalToAsk extends e.Data.TaggedError("NoTerminalToAsk")<{}> {}

/** Questions jive asks the person running it, on the terminal it runs in. */
export interface IPrompt {
  /**
   * Asks `question` and returns the line typed, trimmed. Fails with `NoTerminalToAsk` when jive's input is not a
   * terminal, without asking.
   */
  ask(question: string): EffectGen<string, NoTerminalToAsk>;
}
