import * as e from "effect";
import { selectFromList } from "@ozyman42/interactive-cli-select";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { magenta } from "./logging";

// TODO: Move this raw-mode cleanup into @ozyman42/interactive-cli-select once that repo is back in scope.
const restoreTerminalInputMode = (): e.Effect.Effect<void> =>
  e.Effect.sync(() => {
    if (input.isTTY && typeof input.setRawMode === "function" && input.isRaw) {
      input.setRawMode(false);
    }
    input.resume();
  });

export const selectOne = (
  prompt: string,
  options: Record<string, string>,
  onlyOneItemPrompt?: (item: string) => string
): e.Effect.Effect<string> =>
  e.Effect.gen(function*() {
    const entries = Object.entries(options);
    const firstEntry = entries[0];
    if (firstEntry === undefined) {
      return yield* e.Effect.die(`GOT NON EMPTY OPTIONS ARRAY FOR PROMPT "${prompt}"`);
    }
    if (entries.length === 1) {
      if (onlyOneItemPrompt) {
        yield* e.Effect.log(onlyOneItemPrompt);
      }
      return firstEntry[0];
    }
    yield* e.Effect.log(prompt);
    const [k, v] = yield* selectFromList({
      options: entries,
      getKey: ([k, v]) => k,
      renderOption: ([k, v]) => v,
    }).pipe(
      e.Effect.map((selection) => selection),
      e.Effect.catchTag("NoEntriesError", err => e.Effect.die("IMPOSSIBLE NO ENTRIES ERROR")),
      e.Effect.catchTag("DuplicateEntryError", err => e.Effect.die("IMPOSSIBLE DUPLICATE ENTRY ERROR"))
    );
    yield* restoreTerminalInputMode();
    // TODO: show prompt before choice but clear old selection using something like ink
    yield* e.Effect.log(`${magenta(v)}`);
    return k;
  });

export const promptYesNo = (question: string): e.Effect.Effect<boolean> => {
  return e.pipe(
    selectOne(
      question,
      {
        yes: "Yes",
        no: "No"
      }
    ),
    e.Effect.map((selected) => selected === "yes"),
  );
};

export const promptText = (question: string): e.Effect.Effect<string> =>
  e.Effect.acquireUseRelease(
    e.Effect.sync(() => createInterface({ input, output })),
    (rl) =>
      e.Effect.promise(() => rl.question(question)).pipe(
        e.Effect.map((value) => value.trim()),
      ),
    (rl) => e.Effect.sync(() => rl.close()),
  );
