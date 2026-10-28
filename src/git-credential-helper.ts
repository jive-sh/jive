import * as e from "effect";
import * as process from "node:process";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cli } from "jive-abstract-library";
import { version } from "../package.json";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "./constants";
import { modules } from "@/modules";
import { GithubImpl } from "@/modules/github/impl";
import { ToolStateImpl } from "@/modules/tool-state/impl";

/** Git's credential request: `key=value` lines on stdin. A terminal on stdin means no request was piped in. */
const readStdin = e.Effect.callback<Record<string, string>>((resume) => {
  if (process.stdin.isTTY) return resume(e.Effect.succeed({}));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
  });
  process.stdin.on("end", () => {
    const entries = buffer
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line): Array<[string, string]> => {
        const [key, ...valueParts] = line.split("=");
        return key ? [[key, valueParts.join("=")]] : [];
      });
    resume(e.Effect.succeed(Object.fromEntries(entries)));
  });
  process.stdin.on("error", (err) => {
    resume(e.Effect.die(err.message));
  });
});

// Git only ever asks a credential helper to `get`, `store` or `erase`; jive keeps no credentials of git's.
const ignoredByJive = Cli.command({ *run() {} });

const credentialHelper = Cli.make(GIT_CREDENTIAL_HELPER_NAME, {
  get: Cli.command({
    *run() {
      const toolState = yield* modules.toolState;
      const github = yield* modules.github;
      const input = yield* readStdin;
      const protocol = input["protocol"] ?? "";
      const host = input["host"] ?? "";
      if (protocol !== "https" || host !== "github.com") {
        return yield* e.Effect.die(`unsupported credential request: protocol=${protocol || "(missing)"} host=${host || "(missing)"}`);
      }

      yield* e.pipe(
        e.Effect.gen(() => toolState.assertInWorkspace()),
        e.Effect.catchTag("NotInWorkspaceError", () => e.Effect.die(`not currently in a ${TOOL_NAME} workspace.`)),
      );
      const maybeCurrentUserState = yield* toolState.readCurrentUserState();
      if (e.Option.isNone(maybeCurrentUserState)) {
        return yield* e.Effect.die(`no user currently signed-in, run \`${TOOL_NAME} login\`.`);
      }
      const currentUserState = maybeCurrentUserState.value;
      const { accessToken } = yield* e.pipe(
        e.Effect.gen(() => github.resolveAccessToken(currentUserState)),
        e.Effect.catchTag("BadArgumentError", error =>
          e.Effect.die(
            `signed in as ${currentUserState.email}, but the persisted GitHub session is unusable because the ${error.argument} is invalid: ${error.reason}; run \`${TOOL_NAME} login\`.`,
          ),
        ),
      );

      const username = currentUserState.username || "oauth-token";
      process.stdout.write(`username=${username}\n`);
      process.stdout.write(`password=${accessToken.accessToken}\n`);
    },
  }),
  store: ignoredByJive,
  erase: ignoredByJive,
  capability: ignoredByJive,
});

BunRuntime.runMain(e.pipe(
  Cli.run(credentialHelper, { version }),
  e.Effect.provide(e.pipe(GithubImpl.Layer, e.Layer.provideMerge(ToolStateImpl.Layer))),
  e.Effect.provide(Cli.terminalLogger),
  e.Effect.provide(BunServices.layer),
));
