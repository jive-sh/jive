import * as e from "effect";
import { selectFromList } from "@ozyman42/interactive-cli-select";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

// TODO: Move this raw-mode cleanup into @ozyman42/interactive-cli-select once that repo is back in scope.
const restoreTerminalInputMode = (): e.Effect.Effect<void> =>
  e.Effect.sync(() => {
    if (input.isTTY && typeof input.setRawMode === "function" && input.isRaw) {
      input.setRawMode(false);
    }
    input.resume();
  });

export const selectOne = <T>(
  prompt: string,
  options: T[],
  getKey: (option: T) => string,
  renderOption: (option: T, index: number) => string,
): e.Effect.Effect<e.Option.Option<T>> =>
  e.Effect.gen(function*() {
    if (options.length === 0) return e.Option.none();

    yield* e.Effect.log(prompt);
    const optionsWithIndex = options.map((option, index) => ({ option, index }));

    const selected = yield* selectFromList({
      options: optionsWithIndex,
      getKey: ({ option }) => getKey(option),
      renderOption: ({ option, index }) => renderOption(option, index),
    }).pipe(
      e.Effect.map((selection) => e.Option.some(selection.option)),
      e.Effect.catchAll(() =>
        e.Effect.gen(function*() {
          yield* e.Effect.logError("Selection cancelled.");
          return e.Option.none<T>();
        }),
      ),
    );

    yield* restoreTerminalInputMode();
    return selected;
  });

export const promptYesNo = (question: string): e.Effect.Effect<boolean> => {
  const options = [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ];

  return e.pipe(
    selectOne(
      question,
      options,
      (option) => option.id,
      (option) => option.label,
    ),
    e.Effect.map((selected) => e.Option.isSome(selected) && selected.value.id === "yes"),
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
