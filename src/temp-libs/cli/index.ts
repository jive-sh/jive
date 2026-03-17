import * as e from "effect";
import omelette from "omelette";

export type InvocationMode =
  | "execute"
  | "help"
  | "autocomplete"
  | "setup-completion"
  | "remove-completion";

type AsyncOptionsGetter<E = never, R = never> = () => e.Effect.Effect<string[], E, R>;
type HandleRunner<E = never, R = never> = (remaining: string[]) => e.Effect.Effect<void, E, R>;

const AUTOCOMPLETE_ERROR_OPTION_PREFIX = "\u2063";

interface CLIInvocationContext {
  readonly mode: InvocationMode;
}

class ICLIInvocation extends e.Context.Tag("ICLIInvocation")<ICLIInvocation, CLIInvocationContext>() {}

interface CLIType<E = never, R = never> {
  readonly _tag: "DiscreteOptions" | "AsyncOptions" | "Handle";
  readonly _E: E;
  readonly _R: R;
}

class DiscreteOptionsCLI<Options extends Record<string, AnyCLI>> implements CLIType<CLIOptionsError<Options>, CLIOptionsContext<Options>> {
  readonly _tag = "DiscreteOptions";
  declare readonly _E: CLIOptionsError<Options>;
  declare readonly _R: CLIOptionsContext<Options>;

  constructor(readonly options: Options) {}

  withHandler<HandlerE, HandlerR>(run: HandleRunner<HandlerE, HandlerR>): DiscreteOptionsWithHandlerCLI<Options, HandlerE, HandlerR> {
    return new DiscreteOptionsWithHandlerCLI(this.options, run);
  }
}

class DiscreteOptionsWithHandlerCLI<Options extends Record<string, AnyCLI>, HandlerE, HandlerR>
  implements CLIType<CLIOptionsError<Options> | HandlerE, CLIOptionsContext<Options> | HandlerR>
{
  readonly _tag = "DiscreteOptions";
  declare readonly _E: CLIOptionsError<Options> | HandlerE;
  declare readonly _R: CLIOptionsContext<Options> | HandlerR;

  constructor(readonly options: Options, readonly handler: HandleRunner<HandlerE, HandlerR>) {}
}

class AsyncOptionsCLI<GetterE, GetterR, Child extends AnyCLI>
  implements CLIType<GetterE | CLIError<Child>, GetterR | CLIContext<Child>>
{
  readonly _tag = "AsyncOptions";
  declare readonly _E: GetterE | CLIError<Child>;
  declare readonly _R: GetterR | CLIContext<Child>;

  constructor(readonly getter: AsyncOptionsGetter<GetterE, GetterR>, readonly then: (choice: string) => Child) {}

  withHandler<HandlerE, HandlerR>(
    run: HandleRunner<HandlerE, HandlerR>,
  ): AsyncOptionsWithHandlerCLI<GetterE, GetterR, Child, HandlerE, HandlerR> {
    return new AsyncOptionsWithHandlerCLI(this.getter, this.then, run);
  }
}

class AsyncOptionsWithHandlerCLI<GetterE, GetterR, Child extends AnyCLI, HandlerE, HandlerR>
  implements CLIType<GetterE | CLIError<Child> | HandlerE, GetterR | CLIContext<Child> | HandlerR>
{
  readonly _tag = "AsyncOptions";
  declare readonly _E: GetterE | CLIError<Child> | HandlerE;
  declare readonly _R: GetterR | CLIContext<Child> | HandlerR;

  constructor(
    readonly getter: AsyncOptionsGetter<GetterE, GetterR>,
    readonly then: (choice: string) => Child,
    readonly handler: HandleRunner<HandlerE, HandlerR>,
  ) {}
}

class HandleCLI<HandlerE, HandlerR> implements CLIType<HandlerE, HandlerR> {
  readonly _tag = "Handle";
  declare readonly _E: HandlerE;
  declare readonly _R: HandlerR;

  constructor(readonly run: HandleRunner<HandlerE, HandlerR>) {}
}

type AnyCLI =
  | DiscreteOptionsCLI<any>
  | DiscreteOptionsWithHandlerCLI<any, any, any>
  | AsyncOptionsCLI<any, any, any>
  | AsyncOptionsWithHandlerCLI<any, any, any, any, any>
  | HandleCLI<any, any>;

type CLIError<Node extends AnyCLI> = [Node] extends [CLIType<infer E, any>] ? E : never;
type CLIContext<Node extends AnyCLI> = [Node] extends [CLIType<any, infer R>] ? R : never;
type CLIOptionsError<Options extends Record<string, AnyCLI>> = CLIError<Options[keyof Options]>;
type CLIOptionsContext<Options extends Record<string, AnyCLI>> = CLIContext<Options[keyof Options]>;

export type CLI = AnyCLI;

type DiscreteNode =
  | DiscreteOptionsCLI<Record<string, AnyCLI>>
  | DiscreteOptionsWithHandlerCLI<Record<string, AnyCLI>, any, any>;

type AsyncNode =
  | AsyncOptionsCLI<any, any, AnyCLI>
  | AsyncOptionsWithHandlerCLI<any, any, AnyCLI, any, any>;

type HandleNode = HandleCLI<any, any>;

type NavigateResult = {
  readonly node: AnyCLI;
  readonly path: string[];
  readonly remaining: string[];
  readonly invalid: e.Option.Option<string>;
};

export const CLI = {
  DiscreteOptions: <Options extends Record<string, AnyCLI>>(options: Options): DiscreteOptionsCLI<Options> =>
    new DiscreteOptionsCLI(options),
  AsyncOptions: <GetterE, GetterR, Child extends AnyCLI>(
    getter: AsyncOptionsGetter<GetterE, GetterR>,
    then: (choice: string) => Child,
  ): AsyncOptionsCLI<GetterE, GetterR, Child> =>
    new AsyncOptionsCLI(getter, then),
  Handle: <HandlerE, HandlerR>(run: HandleRunner<HandlerE, HandlerR>): HandleCLI<HandlerE, HandlerR> =>
    new HandleCLI(run),
  currentInvocationMode: (args: readonly string[] = process.argv.slice(2)): InvocationMode =>
    detectInvocationMode(args),
  isAutocompleteRequest: (args: readonly string[] = process.argv.slice(2)): boolean =>
    detectInvocationMode(args) === "autocomplete",
  invocationMode: e.Effect.map(ICLIInvocation, ({ mode }) => mode),
  new: cli,
};

function matchCLI<A>(
  node: AnyCLI,
  cases: {
    readonly DiscreteOptions: (node: DiscreteNode) => A;
    readonly AsyncOptions: (node: AsyncNode) => A;
    readonly Handle: (node: HandleNode) => A;
  },
): A {
  const handlers: Record<AnyCLI["_tag"], (node: AnyCLI) => A> = {
    DiscreteOptions: (node) => cases.DiscreteOptions(node as DiscreteNode),
    AsyncOptions: (node) => cases.AsyncOptions(node as AsyncNode),
    Handle: (node) => cases.Handle(node as HandleNode),
  };
  return handlers[node._tag](node);
}

function maxDepth(node: CLI): number {
  return matchCLI(node, {
    DiscreteOptions: (node) => {
      const depths = Object.values(node.options).map(maxDepth);
      return 1 + (depths.length > 0 ? Math.max(...depths) : 0);
    },
    AsyncOptions: (node) => 1 + maxDepth(node.then("")),
    Handle: () => 0,
  });
}

function navigate(node: AnyCLI, args: string[], path: string[]): NavigateResult {
  if (args.length === 0) {
    return { node, path, remaining: [], invalid: e.Option.none() };
  }

  const [head, ...rest] = args;
  return matchCLI(node, {
    DiscreteOptions: (node) => {
      const next = node.options[head!];
      if (!next) {
        return { node, path, remaining: rest, invalid: e.Option.some(head!) };
      }

      return navigate(next, rest, [...path, head!]);
    },
    AsyncOptions: (node) => navigate(node.then(head!), rest, [...path, head!]),
    Handle: (node) => ({ node, path, remaining: args, invalid: e.Option.none() }),
  });
}

function cli<Definition extends AnyCLI>(
  name: string,
  definition: Definition,
): e.Effect.Effect<void, CLIError<Definition>, CLIContext<Definition>> {
  return e.Effect.gen(function*() {
    const runtime = yield* e.Effect.runtime<CLIContext<Definition> | CLIInvocationContext>();
    const args = process.argv.slice(2);
    const invocationMode = detectInvocationMode(args);
    const depth = maxDepth(definition);
    const fragments = Array.from({ length: depth }, (_, i) => `<arg${i + 1}>`);
    const completion = omelette([name, ...fragments].join(" "));

    for (let i = 0; i < depth; i++) {
      const argumentName = `arg${i + 1}`;
      completion.onAsync(argumentName, async ({ line, reply }) => {
        const typed = line.trim().split(/\s+/).slice(1, i + 1);
        const result = navigate(definition, typed, [name]);
        matchCLI(result.node, {
          DiscreteOptions: (node) => reply(Promise.resolve(Object.keys(node.options))),
          AsyncOptions: (node) =>
            reply(e.Runtime.runPromise(runtime)(resolveAutocompleteChoices(node.getter, argumentName, invocationMode))),
          Handle: () => reply(Promise.resolve([])),
        });
      });
    }

    if (invocationMode === "setup-completion") {
      completion.setupShellInitFile();
      return yield* withInvocationContext(e.Effect.gen(function*() {
        yield* e.Effect.log("Completion installed. Restart your shell or source your init file.");
        yield* e.Effect.sync(() => process.exit(0));
      }), invocationMode);
    }

    if (invocationMode === "remove-completion") {
      completion.cleanupShellInitFile();
      return yield* withInvocationContext(e.Effect.gen(function*() {
        yield* e.Effect.log("Completion removed.");
        yield* e.Effect.sync(() => process.exit(0));
      }), invocationMode);
    }

    if (invocationMode === "autocomplete") {
      completion.init();
      return yield* withInvocationContext(e.Effect.never, invocationMode);
    }

    const helpIndex = args.findIndex(isHelpFlag);
    const requestedHelp = helpIndex >= 0;
    const navigatedArgs = requestedHelp ? args.slice(0, helpIndex) : args;
    const result = navigate(definition, navigatedArgs, [name]);

    if (requestedHelp || e.Option.isSome(result.invalid) || !hasHandler(result.node)) {
      return yield* withInvocationContext(renderHelp(result.node, result.path), invocationMode);
    }

    return yield* withInvocationContext(runNode(result.node, result.remaining), invocationMode);
  }) as e.Effect.Effect<void, CLIError<Definition>, CLIContext<Definition>>;
}

function hasHandler(node: CLI): boolean {
  return matchCLI(node, {
    Handle: () => true,
    DiscreteOptions: (node) => "handler" in node,
    AsyncOptions: (node) => "handler" in node,
  });
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function detectInvocationMode(args: readonly string[]): InvocationMode {
  if (args.includes("--setup-completion")) return "setup-completion";
  if (args.includes("--remove-completion")) return "remove-completion";
  if (args.includes("--compgen")) return "autocomplete";

  return args.some(isHelpFlag) ? "help" : "execute";
}

function withInvocationContext<A, E, R>(
  effect: e.Effect.Effect<A, E, R>,
  mode: InvocationMode,
) {
  return effect.pipe(
    e.Effect.provideService(ICLIInvocation, { mode }),
  );
}

function autocompleteErrorOptions(argumentName: string): string[] {
  return [`${AUTOCOMPLETE_ERROR_OPTION_PREFIX}ERROR RETREIVING OPTIONS FOR ${argumentName}`];
}

function resolveAutocompleteChoices<E, R>(
  getter: AsyncOptionsGetter<E, R>,
  argumentName: string,
  invocationMode: InvocationMode,
): e.Effect.Effect<string[], E, R> {
  return e.pipe(
    withInvocationContext(getter(), invocationMode),
    e.Effect.catchAllCause((cause) =>
      invocationMode === "autocomplete"
        ? e.Effect.succeed(autocompleteErrorOptions(argumentName))
        : e.Effect.failCause(cause),
    ),
  );
}

function resolveGetter<E, R>(getter: AsyncOptionsGetter<E, R>): e.Effect.Effect<string[], E, R> {
  return getter();
}

function resolveRunner<E, R>(run: HandleRunner<E, R>, remaining: string[]): e.Effect.Effect<void, E, R> {
  return run(remaining);
}

function runNode<Node extends AnyCLI>(
  node: Node,
  remaining: string[],
): e.Effect.Effect<void, CLIError<Node>, CLIContext<Node>> {
  return matchCLI(node, {
    Handle: (node) => resolveRunner(node.run, remaining),
    DiscreteOptions: (node) =>
      "handler" in node
        ? resolveRunner(node.handler, remaining)
        : e.Effect.void,
    AsyncOptions: (node) =>
      "handler" in node
        ? resolveRunner(node.handler, remaining)
        : e.Effect.void,
  });
}

function renderHelp<Node extends AnyCLI>(
  node: Node,
  path: string[],
): e.Effect.Effect<void, CLIError<Node>, CLIContext<Node>> {
  return matchCLI(node, {
    Handle: () => e.Effect.log(`Usage: ${path.join(" ")} [args...]`),
    DiscreteOptions: (node) => logDiscreteHelp(path, Object.keys(node.options), hasHandler(node)),
    AsyncOptions: (node) =>
      e.pipe(
        resolveGetter(node.getter),
        e.Effect.flatMap((choices) => logAsyncHelp(path, choices, hasHandler(node))),
      ),
  });
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
