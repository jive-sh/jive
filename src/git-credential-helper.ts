import * as process from "node:process";
import { CLI } from "@/temp-libs/cli";
import * as e from "effect";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "./constants";
import { GitHubImpl, HostShellImpl, IGitHub, IToolState, ToolStateImpl } from "@/modules";
import * as epn from "@effect/platform-node";

const readStdin = e.Effect.async<Record<string, string>>((resume) => {
  if (process.stdin.isTTY) return resume(e.Effect.succeed({}));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
  });
  process.stdin.on("end", () => {
    const obj = Object.fromEntries(
      buffer
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [key, ...valueParts] = line.split("=");
          if (!key) return e.Option.none<readonly [string, string]>();
          return e.Option.some([key, valueParts.join("=")] as const);
        })
        .filter(e.Option.isSome)
        .map((entry) => entry.value),
    ) as Record<string, string>;
    resume(e.Effect.succeed(obj));
  });
  process.stdin.on("error", (err) => {
    resume(e.Effect.dieMessage(err.message));
  });
});

const program = e.Effect.gen(function*() {
  const toolState = yield* IToolState;
  const github = yield* IGitHub;
  yield* CLI.new(GIT_CREDENTIAL_HELPER_NAME, CLI.DiscreteOptions({
    get: CLI.Handle(e.Effect.fn(function*() {
      const input = yield* readStdin;
      const protocol = input.protocol ?? "";
      const host = input.host ?? "";
      if (protocol !== "https" || host !== "github.com") {
        return yield* e.Effect.dieMessage(`unsupported credential request: protocol=${protocol || "(missing)"} host=${host || "(missing)"}`);
      }

      yield* e.pipe(
        toolState.assertInWorkspace,
        e.Effect.catchTag("NotInWorkspaceError", () => e.Effect.dieMessage(`not currently in a ${TOOL_NAME} workspace.`)),
      );
      const maybeCurrentUserState = yield* toolState.readCurrentUserState;
      if (e.Option.isNone(maybeCurrentUserState)) {
        return yield* e.Effect.dieMessage(`no user currently signed-in, run \`${TOOL_NAME} login\`.`);
      }
      const currentUserState = maybeCurrentUserState.value;
      const { accessToken } = yield* e.pipe(
        github.resolveAccessToken(currentUserState),
        e.Effect.catchTag("BadArgumentError", error =>
          e.Effect.dieMessage(
            `signed in as ${currentUserState.email}, but the persisted GitHub session is unusable because the ${error.argument} is invalid: ${error.reason}; run \`${TOOL_NAME} login\`.`,
          ),
        ),
      );

      const username = currentUserState.username || "oauth-token";
      process.stdout.write(`username=${username}\n`);
      process.stdout.write(`password=${accessToken.accessToken}\n`);
    })),
    store: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle store
    })),
    erase: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle erase
    })),
    capability: CLI.Handle(e.Effect.fn(function*() {
      // We explicitly don't want to handle capability
    })),
  }));
});

const main = e.pipe(
  program,
  e.Effect.provide(GitHubImpl),
  e.Effect.provide(HostShellImpl),
  e.Effect.provide(ToolStateImpl),
  e.Effect.provide(epn.NodeCommandExecutor.layer),
  e.Effect.provide(epn.NodeFileSystem.layer),
);

void e.Effect.runPromiseExit(main).then((exit) => {
  function exitLog(obj: any) {
    process.stderr.write(`${TOOL_NAME} credential helper failure: ${String(obj)}\n`);
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
