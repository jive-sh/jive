import * as e from "effect";
import omelette from "omelette";

type LazyEffect<A> = e.Effect.Effect<A> | (() => e.Effect.Effect<A>);
type HandleRunner = e.Effect.Effect<void> | ((remaining: string[]) => e.Effect.Effect<void>);

class DiscreteOptionsCLI {
  readonly _tag = "DiscreteOptions";

  constructor(readonly options: Record<string, CLI>) {}

  withHandler(run: HandleRunner): DiscreteOptionsWithHandlerCLI {
    return new DiscreteOptionsWithHandlerCLI(this.options, run);
  }
}

class DiscreteOptionsWithHandlerCLI {
  readonly _tag = "DiscreteOptions";

  constructor(readonly options: Record<string, CLI>, readonly handler: HandleRunner) {}
}

class AsyncOptionsCLI {
  readonly _tag = "AsyncOptions";

  constructor(readonly getter: LazyEffect<string[]>, readonly then: (choice: string) => CLI) {}

  withHandler(run: HandleRunner): AsyncOptionsWithHandlerCLI {
    return new AsyncOptionsWithHandlerCLI(this.getter, this.then, run);
  }
}

class AsyncOptionsWithHandlerCLI {
  readonly _tag = "AsyncOptions";

  constructor(
    readonly getter: LazyEffect<string[]>,
    readonly then: (choice: string) => CLI,
    readonly handler: HandleRunner,
  ) {}
}

class HandleCLI {
  readonly _tag = "Handle";

  constructor(readonly run: HandleRunner) {}
}

export type CLI =
  | DiscreteOptionsCLI
  | DiscreteOptionsWithHandlerCLI
  | AsyncOptionsCLI
  | AsyncOptionsWithHandlerCLI
  | HandleCLI;

type NavigateResult = {
  readonly node: CLI;
  readonly path: string[];
  readonly remaining: string[];
  readonly invalid: e.Option.Option<string>;
};

export const CLI = {
  DiscreteOptions: (options: Record<string, CLI>): DiscreteOptionsCLI =>
    new DiscreteOptionsCLI(options),
  AsyncOptions: (
    getter: LazyEffect<string[]>,
    then: (choice: string) => CLI,
  ): AsyncOptionsCLI =>
    new AsyncOptionsCLI(getter, then),
  Handle: (run: HandleRunner): HandleCLI => new HandleCLI(run),
  new: cli,
};

function maxDepth(node: CLI): number {
  switch (node._tag) {
    case "DiscreteOptions": {
      const depths = Object.values(node.options).map(maxDepth);
      return 1 + (depths.length > 0 ? Math.max(...depths) : 0);
    }
    case "AsyncOptions":
      return 1 + maxDepth(node.then(""));
    case "Handle":
      return 0;
  }
}

function navigate(node: CLI, args: string[], path: string[]): NavigateResult {
  if (args.length === 0) {
    return { node, path, remaining: [], invalid: e.Option.none() };
  }

  const [head, ...rest] = args;
  switch (node._tag) {
    case "DiscreteOptions": {
      const next = node.options[head!];
      if (!next) {
        return { node, path, remaining: rest, invalid: e.Option.some(head!) };
      }

      return navigate(next, rest, [...path, head!]);
    }
    case "AsyncOptions":
      return navigate(node.then(head!), rest, [...path, head!]);
    case "Handle":
      return { node, path, remaining: args, invalid: e.Option.none() };
  }
}

function cli(name: string, definition: CLI): e.Effect.Effect<void> {
  const depth = maxDepth(definition);
  const fragments = Array.from({ length: depth }, (_, i) => `<arg${i + 1}>`);
  const completion = omelette([name, ...fragments].join(" "));

  for (let i = 0; i < depth; i++) {
    completion.onAsync(`arg${i + 1}`, async ({ line, reply }) => {
      const typed = line.trim().split(/\s+/).slice(1, i + 1);
      const result = navigate(definition, typed, [name]);
      switch (result.node._tag) {
        case "DiscreteOptions":
          reply(Promise.resolve(Object.keys(result.node.options)));
          break;
        case "AsyncOptions":
          reply(e.Effect.runPromise(resolveGetter(result.node.getter)));
          break;
        case "Handle":
          reply(Promise.resolve([]));
          break;
      }
    });
  }

  if (process.argv.includes("--setup-completion")) {
    completion.setupShellInitFile();
    return e.Effect.gen(function*() {
      yield* e.Effect.log("Completion installed. Restart your shell or source your init file.");
      yield* e.Effect.sync(() => process.exit(0));
    });
  }

  if (process.argv.includes("--remove-completion")) {
    completion.cleanupShellInitFile();
    return e.Effect.gen(function*() {
      yield* e.Effect.log("Completion removed.");
      yield* e.Effect.sync(() => process.exit(0));
    });
  }

  if (isCompletionRequest()) {
    completion.init();
    return e.Effect.never;
  }

  const args = process.argv.slice(2);
  const helpIndex = args.findIndex(isHelpFlag);
  const requestedHelp = helpIndex >= 0;
  const navigatedArgs = requestedHelp ? args.slice(0, helpIndex) : args;
  const result = navigate(definition, navigatedArgs, [name]);

  if (requestedHelp || e.Option.isSome(result.invalid) || !hasHandler(result.node)) {
    return renderHelp(result.node, result.path);
  }

  return runNode(result.node, result.remaining);
}

function hasHandler(node: CLI): boolean {
  switch (node._tag) {
    case "Handle":
      return true;
    case "DiscreteOptions":
    case "AsyncOptions":
      return "handler" in node;
  }
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function isCompletionRequest(): boolean {
  return process.argv.includes("--compgen");
}

function resolveGetter(getter: LazyEffect<string[]>): e.Effect.Effect<string[]> {
  return typeof getter === "function" ? getter() : getter;
}

function resolveRunner(run: HandleRunner, remaining: string[]): e.Effect.Effect<void> {
  return typeof run === "function" ? run(remaining) : run;
}

function runNode(node: CLI, remaining: string[]): e.Effect.Effect<void> {
  switch (node._tag) {
    case "Handle":
      return resolveRunner(node.run, remaining);
    case "DiscreteOptions":
    case "AsyncOptions":
      return "handler" in node
        ? resolveRunner(node.handler, remaining)
        : e.Effect.void;
  }
}

function renderHelp(node: CLI, path: string[]): e.Effect.Effect<void> {
  switch (node._tag) {
    case "Handle":
      return e.Effect.log(`Usage: ${path.join(" ")} [args...]`);
    case "DiscreteOptions":
      return logDiscreteHelp(path, Object.keys(node.options), hasHandler(node));
    case "AsyncOptions":
      return e.pipe(
        resolveGetter(node.getter),
        e.Effect.flatMap((choices) => logAsyncHelp(path, choices, hasHandler(node))),
      );
  }
}

function logDiscreteHelp(
  commandPath: readonly string[],
  commands: readonly string[],
  handlerPresent: boolean,
): e.Effect.Effect<void> {
  const usageSuffix = commands.length > 0 ? (handlerPresent ? "[command]" : "<command>") : "";
  const usage = `Usage: ${[...commandPath, usageSuffix].filter(Boolean).join(" ")}`;
  if (commands.length === 0) {
    return e.Effect.log(usage);
  }

  const listedCommands = commands
    .slice()
    .sort()
    .map((command) => `  ${command}`)
    .join("\n");

  return e.Effect.log(`${usage}\n\nCommands:\n${listedCommands}`);
}

function logAsyncHelp(
  commandPath: readonly string[],
  choices: readonly string[],
  handlerPresent: boolean,
): e.Effect.Effect<void> {
  const usage = `Usage: ${[...commandPath, handlerPresent ? "[option]" : "<option>"].join(" ")}`;
  if (choices.length === 0) {
    return e.Effect.log(usage);
  }

  const listedChoices = choices
    .slice()
    .sort()
    .map((choice) => `  ${choice}`)
    .join("\n");

  return e.Effect.log(`${usage}\n\nOptions:\n${listedChoices}`);
}
