import * as process from "node:process";
import { CLI } from "@/temp-libs/cli";
import * as e from "effect";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "./constants";
import { IToolState, ToolStateImpl } from "@/modules";
import * as epn from "@effect/platform-node";
import { loadCredentials } from "./modules/auth/credentials";

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
  yield* CLI.new(GIT_CREDENTIAL_HELPER_NAME, CLI.DiscreteOptions({
    get: CLI.Handle(e.Effect.fn(function*() {
      const input = yield* readStdin;
      const protocol = input.protocol ?? "";
      const host = input.host ?? "";
      if (protocol !== "https" || host !== "github.com") {
        return yield* e.Effect.dieMessage(`unsupported credential request: protocol=${protocol || "(missing)"} host=${host || "(missing)"}`);
      }

      const repoOwner = parseGitHubOwner(typeof input.path === "string" ? input.path : "");
      const isInJiveWorkspace = yield* toolState.inWorkspace;
      if (!isInJiveWorkspace) {
        return yield* e.Effect.dieMessage(`not currently in a ${TOOL_NAME} workspace.`);
      }
      const user = yield* toolState.readCurrentUserState;
      if (e.Option.isNone(user)) {
        return yield* e.Effect.dieMessage(`no user currently signed-in, run \`${TOOL_NAME} login\`.`);
      }
      const credentials = yield* loadCredentials(toolState);
      const token = e.Option.map(credentials, (value) => ({
        token: value.readOnlyToken,
        gitUserName: value.gitUserName,
        githubUsername: value.githubUsername,
      }));
      const orgScopedToken = repoOwner
        ? yield* toolState.readOrgScopedCloneTokenState(user.value.email, repoOwner)
        : e.Option.none();
      const selectedToken = e.Option.isSome(orgScopedToken)
        ? orgScopedToken.value
        : e.Option.getOrElse(token, () => null);
      if (!selectedToken) {
        return yield* e.Effect.dieMessage(`signed in as ${user.value.email}, but no token currently exists, re-login.`);
      }

      const username = e.Option.isSome(token)
        ? token.value.githubUsername || token.value.gitUserName || "oauth-token"
        : "oauth-token";
      process.stdout.write(`username=${username}\n`);
      process.stdout.write(`password=${selectedToken.token}\n`);
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

e.pipe(
  program,
  e.Effect.provide(ToolStateImpl),
  e.Effect.provide(epn.NodeFileSystem.layer),
  e.Effect.runPromiseExit,
).then(exit => {
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

function parseGitHubOwner(pathname: string | undefined): string {
  if (!pathname) return "";
  const trimmed = pathname.trim().replace(/^\/+/, "");
  const [owner] = trimmed.split("/", 1);
  return owner ?? "";
}
