import * as e from "effect";
import omelette from "omelette";

export type CLI =
  | { readonly _tag: "DiscreteOptions"; options: Record<string, CLI> }
  | { readonly _tag: "AsyncOptions"; getter: e.Effect.Effect<string[]>; then: (choice: string) => CLI }
  | { readonly _tag: "Handle"; run: (remaining: string[]) => void | Promise<void> }

export const CLI = {
  DiscreteOptions: (options: Record<string, CLI>): CLI => ({ _tag: "DiscreteOptions", options }),
  AsyncOptions: (getter: e.Effect.Effect<string[]>, then: (choice: string) => CLI): CLI => ({ _tag: "AsyncOptions", getter, then }),
  Handle: (run: (remaining: string[]) => void): CLI => ({ _tag: "Handle", run }),
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

function navigate(node: CLI, args: string[]): NavigateResult | null {
  if (args.length === 0) return { node, remaining: [] };
  const [head, ...rest] = args;
  switch (node._tag) {
    case "DiscreteOptions": {
      const next = node.options[head!];
      return next ? navigate(next, rest) : null;
    }
    case "AsyncOptions": return navigate(node.then(head!), rest);
    case "Handle":       return { node, remaining: args };
  }
}

function cli(name: string, definition: CLI) {
  const depth = maxDepth(definition);
  const fragments = Array.from({ length: depth }, (_, i) => `<arg${i + 1}>`);
  const completion = omelette([name, ...fragments].join(" "));

  for (let i = 0; i < depth; i++) {
    completion.onAsync(`arg${i + 1}`, async ({ line, reply }) => {
      const typed = line.trim().split(/\s+/).slice(1, i + 1);
      const result = navigate(definition, typed);
      if (!result) { reply(Promise.resolve([])); return; }
      const { node } = result;
      switch (node._tag) {
        case "DiscreteOptions": reply(Promise.resolve(Object.keys(node.options)));          break;
        case "AsyncOptions":    reply(e.Effect.runPromise(node.getter));                    break;
        case "Handle":          reply(Promise.resolve([]));                                                 break;
      }
    });
  }

  if (process.argv.includes("--setup-completion")) {
    completion.setupShellInitFile();
    console.log("Completion installed. Restart your shell or source your init file.");
    process.exit(0);
  }

  if (process.argv.includes("--remove-completion")) {
    completion.cleanupShellInitFile();
    console.log("Completion removed.");
    process.exit(0);
  }

  completion.init();

  const args = process.argv.slice(2);
  const result = navigate(definition, args);
  if (result?.node._tag === "Handle") {
    const p = result.node.run(result.remaining);
    if (p) p.catch(err => { console.error(err); process.exit(1); });
  }
}
