import * as process from "node:process";
import { CLI } from "@/temp-libs/cli";
import * as e from "effect";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "./constants";
import { IToolState, ToolStateImpl } from "@/modules";
import * as epn from "@effect/platform-node";

const readStdin = e.Effect.async<unknown>((resume) => {
  if (process.stdin.isTTY) return resume(e.Effect.succeed({}));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
  });
  process.stdin.on("end", () => {
    const obj = Object.fromEntries(buffer
      .split("\n")
      .map(line => line.trim())
      .map(line => line.split("=")));
    resume(e.Effect.succeed(obj));
  });
  process.stdin.on("error", (err) => {
    resume(e.Effect.dieMessage(err.message));
  });
})

const program = e.Effect.gen(function*() {
  const toolState = yield* IToolState;
  yield* CLI.new(GIT_CREDENTIAL_HELPER_NAME, CLI.DiscreteOptions({
    get: CLI.Handle(e.Effect.fn(function*() {
      const input = yield* readStdin;
      const decoded = yield* e.pipe(
        input,
        e.Schema.decodeUnknown(e.Schema.Struct({
          protocol: e.Schema.Literal("https"),
          host: e.Schema.Literal("github.com")
        })),
        e.Effect.catchTag("ParseError", err => e.Effect.dieMessage(err.message))
      );
      const isInJiveWorkspace = yield* toolState.inWorkspace;
      if (!isInJiveWorkspace) {
        return yield* e.Effect.dieMessage(`not currently in a ${TOOL_NAME} workspace.`);
      }
      const user = yield* toolState.readCurrentUserState;
      if (e.Option.isNone(user)) {
        return yield* e.Effect.dieMessage(`no user currently signed-in, run \`${TOOL_NAME} login\`.`)
      }
      const token = yield* toolState.readReadOnlyTokenState(user.value.email);
      if (e.Option.isNone(token)) {
        return yield* e.Effect.dieMessage(`signed in as ${user.value.email}, but no token currently exists, re-login.`);
      }
      console.log("username=token");
      console.log(`password=${token.value.token}`);
    })),
    store: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle store
    })),
    erase: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle erase
    })),
    capability: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle capability
    }))
  }))
});

e.pipe(
  program,
  e.Effect.provide(ToolStateImpl),
  e.Effect.provide(epn.NodeFileSystem.layer),
  e.Effect.runPromiseExit
).then(exit => {
  function exitLog(obj: any) {
    console.error(`${TOOL_NAME} credential helper failure:`, obj);
    process.exit(1);
  }
  if (e.Exit.isFailure(exit)) {
    if (exit.cause._tag === "Die") {
      const defect = exit.cause.defect as any;
      if (defect._tag === "RuntimeException") {
        return exitLog(defect.message);
      }
      return exitLog(defect);
    }
    return exitLog(exit.cause);
  }
});
