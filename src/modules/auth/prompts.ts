import * as e from "effect";
import { selectFromList } from "@ozyman42/interactive-cli-select";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const logInfoSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.log(...message));
};
const logErrorSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logError(...message));
};

export async function selectOne<T>(
  prompt: string,
  options: T[],
  getKey: (option: T) => string,
  renderOption: (option: T, index: number) => string,
): Promise<e.Option.Option<T>> {
  if (options.length === 0) return e.Option.none();

  logInfoSync(prompt);
  const optionsWithIndex = options.map((option, index) => ({ option, index }));

  const selection = await e.Effect.runPromiseExit(
    selectFromList({
      options: optionsWithIndex,
      getKey: ({ option }) => getKey(option),
      renderOption: ({ option, index }) => renderOption(option, index),
    }),
  );

  if (e.Exit.isFailure(selection)) {
    logErrorSync("Selection cancelled.");
    return e.Option.none();
  }

  return e.Option.some(selection.value.option);
}

export async function promptYesNo(question: string): Promise<boolean> {
  const options = [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ];

  const selected = await selectOne(
    question,
    options,
    (option) => option.id,
    (option) => option.label,
  );

  return e.Option.isSome(selected) && selected.value.id === "yes";
}

export async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
