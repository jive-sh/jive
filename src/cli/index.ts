import * as e from "effect";
import omelette from "omelette";

type EffectThunk<A> = e.Effect.Effect<A> | (() => e.Effect.Effect<A>);
type HandleRunner = e.Effect.Effect<void> | ((remaining: string[]) => e.Effect.Effect<void>);

export type CLI =
  | { readonly _tag: "DiscreteOptions"; options: Record<string, CLI> }
  | { readonly _tag: "AsyncOptions"; getter: EffectThunk<string[]>; then: (choice: string) => CLI }
  | { readonly _tag: "Handle"; run: HandleRunner }

export const CLI = {
  DiscreteOptions: (options: Record<string, CLI>): CLI => ({ _tag: "DiscreteOptions", options }),
  AsyncOptions: (getter: EffectThunk<string[]>, then: (choice: string) => CLI): CLI => ({ _tag: "AsyncOptions", getter, then }),
  Handle: (run: HandleRunner): CLI => ({ _tag: "Handle", run }),
  new: cli
}

function maxDepth(node: CLI): number {
  switch (node._tag) {
    case "DiscreteOptions": {
      const depths = Object.values(node.options).map(maxDepth);
      return 1 + (depths.length > 0 ? Math.max(...depths) : 0);
    }
    case "AsyncOptions": return 1 + maxDepth(node.then(""));
    case "Handle":       return 0;
  }
}

type NavigateResult = { node: CLI; remaining: string[] };

function navigate(node: CLI, args: string[]): e.Option.Option<NavigateResult> {
  if (args.length === 0) return e.Option.some({ node, remaining: [] });
  const [head, ...rest] = args;
  switch (node._tag) {
    case "DiscreteOptions": {
      const next = node.options[head!];
      return next ? navigate(next, rest) : e.Option.none();
    }
    case "AsyncOptions": return navigate(node.then(head!), rest);
    case "Handle":       return e.Option.some({ node, remaining: args });
  }
}

function cli(name: string, definition: CLI): e.Effect.Effect<void> {
  const depth = maxDepth(definition);
  const fragments = Array.from({ length: depth }, (_, i) => `<arg${i + 1}>`);
  const completion = omelette([name, ...fragments].join(" "));

  for (let i = 0; i < depth; i++) {
    completion.onAsync(`arg${i + 1}`, async ({ line, reply }) => {
      const typed = line.trim().split(/\s+/).slice(1, i + 1);
      const result = navigate(definition, typed);
      if (e.Option.isNone(result)) { reply(Promise.resolve([])); return; }
      const { node } = result.value;
      switch (node._tag) {
        case "DiscreteOptions":
          reply(Promise.resolve(Object.keys(node.options)));
          break;
        case "AsyncOptions":
          reply(e.Effect.runPromise(resolveGetter(node.getter)));
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

  completion.init();

  const args = process.argv.slice(2);
  const result = navigate(definition, args);
  if (e.Option.isSome(result) && result.value.node._tag === "Handle") {
    return typeof result.value.node.run === "function"
      ? result.value.node.run(result.value.remaining)
      : result.value.node.run;
  }

  return e.Effect.void;
}

function resolveGetter(getter: EffectThunk<string[]>): e.Effect.Effect<string[]> {
  return typeof getter === "function" ? getter() : getter;
}
