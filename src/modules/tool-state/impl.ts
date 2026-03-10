import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import * as modules from "@/modules";
import { WORKSPACE_DIR } from "./constants";
import type { CurrentUserState, IReadOnlyTokenState } from "./interface";

const USERS_DIR = `${WORKSPACE_DIR}/users`;
const CURRENT_USER_FILE = `${USERS_DIR}/current.json`;
const READ_ONLY_TOKEN_FILE = "readonly-github-api-token.json";
const WRITE_REFRESH_TOKEN_FILE = "write-refresh-token.json";

export const ToolStateImpl = e.Layer.effect(modules.IToolState, e.Effect.gen(function*() {
  const fileSystem = yield* ep.FileSystem.FileSystem;

  const pathExists = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.exists(targetPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
  });

  const findWorkspaceRoot = e.Effect.fn(function*() {
    let dir = process.cwd();

    while (true) {
      const workspaceDirExists = yield* pathExists(path.join(dir, WORKSPACE_DIR));
      if (workspaceDirExists) return e.Option.some(dir);

      const parent = path.dirname(dir);
      if (parent === dir) return e.Option.none<string>();
      dir = parent;
    }
  });

  const workspaceRoot = yield* findWorkspaceRoot();

  const sanitizeEmailDirectoryName = (email: string): string =>
    email
      .trim()
      .toLowerCase()
      .replace(/[\/\\]/g, "_");

  const userDirectory = e.Effect.fn(function*(root: string, email: string) {
    return path.join(root, USERS_DIR, sanitizeEmailDirectoryName(email));
  });

  const ensureUserStateDirectory = e.Effect.fn(function*(root: string, email: string) {
    const directory = yield* userDirectory(root, email);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  });

  const ensureUsersDirectory = e.Effect.fn(function*(root: string) {
    yield* fileSystem.makeDirectory(path.join(root, USERS_DIR), { recursive: true });
  });

  const readOnlyTokenFilePath = e.Effect.fn(function*(root: string, email: string) {
    const directory = yield* userDirectory(root, email);
    return path.join(directory, READ_ONLY_TOKEN_FILE);
  });

  const writeRefreshTokenFilePath = e.Effect.fn(function*(root: string, email: string) {
    const directory = yield* userDirectory(root, email);
    return path.join(directory, WRITE_REFRESH_TOKEN_FILE);
  });

  const readJsonObject = e.Effect.fn(function*(targetPath: string) {
    const contents = yield* fileSystem.readFileString(targetPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed("")),
    );
    if (!contents) return e.Option.none<Record<string, unknown>>();

    try {
      const parsed = JSON.parse(contents) as unknown;
      if (parsed && typeof parsed === "object") {
        return e.Option.some(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed data and treat as absent.
    }

    return e.Option.none<Record<string, unknown>>();
  });

  const writeJsonObject = e.Effect.fn(function*(targetPath: string, data: object) {
    yield* fileSystem.writeFileString(targetPath, JSON.stringify(data, undefined, 2), {
      mode: 0o600,
    });
  });

  const inWorkspace = e.Effect.fn(function*() {
    return e.Option.isSome(workspaceRoot);
  })();

  const readCurrentUserState = e.Effect.fn(function*() {
    if (e.Option.isNone(workspaceRoot)) return e.Option.none<CurrentUserState>();

    const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
    const current = yield* readJsonObject(currentUserPath);
    if (e.Option.isNone(current)) return e.Option.none<CurrentUserState>();

    const email = current.value.email;
    const yubiKeyId = current.value.yubiKeyId;
    const yubiKeyLabel = current.value.yubiKeyLabel;
    if (typeof email !== "string" || !email) return e.Option.none<CurrentUserState>();
    if (typeof yubiKeyId !== "string" || !yubiKeyId) return e.Option.none<CurrentUserState>();
    if (typeof yubiKeyLabel !== "string" || !yubiKeyLabel) return e.Option.none<CurrentUserState>();

    return e.Option.some({ email, yubiKeyId, yubiKeyLabel });
  })();

  const clearCurrentUserState = e.Effect.fn(function*() {
    if (e.Option.isNone(workspaceRoot)) return;

    const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
    yield* fileSystem.remove(currentUserPath, { force: true }).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  })();

  const writeCurrentUserState = e.Effect.fn(function*(state: CurrentUserState) {
    if (e.Option.isNone(workspaceRoot)) return;

    yield* ensureUsersDirectory(workspaceRoot.value).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );

    const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
    yield* writeJsonObject(currentUserPath, state).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  });

  const readReadOnlyTokenState = e.Effect.fn(function*(email: string) {
    if (e.Option.isNone(workspaceRoot)) return e.Option.none<IReadOnlyTokenState>();

    const tokenPath = yield* readOnlyTokenFilePath(workspaceRoot.value, email);
    const state = yield* readJsonObject(tokenPath);
    if (e.Option.isNone(state)) return e.Option.none<IReadOnlyTokenState>();

    const token = typeof state.value.token === "string" ? state.value.token : "";
    if (!token) return e.Option.none<IReadOnlyTokenState>();

    const scope = typeof state.value.scope === "string" ? state.value.scope : "";
    const tokenType = typeof state.value.tokenType === "string" ? state.value.tokenType : "bearer";
    const gitUserName = typeof state.value.gitUserName === "string" && state.value.gitUserName
      ? state.value.gitUserName
      : email;
    const githubAccountId = typeof state.value.githubAccountId === "number" && Number.isFinite(state.value.githubAccountId)
      ? state.value.githubAccountId
      : 0;
    const githubUsername = typeof state.value.githubUsername === "string" && state.value.githubUsername
      ? state.value.githubUsername
      : "";

    return e.Option.some({ token, scope, tokenType, gitUserName, githubAccountId, githubUsername });
  });

  const writeReadOnlyTokenState = e.Effect.fn(function*(email: string, state: IReadOnlyTokenState) {
    if (e.Option.isNone(workspaceRoot)) return;

    yield* ensureUserStateDirectory(workspaceRoot.value, email).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
    const tokenPath = yield* readOnlyTokenFilePath(workspaceRoot.value, email);
    yield* writeJsonObject(tokenPath, state).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  });

  const readWriteRefreshToken = e.Effect.fn(function*(email: string) {
    if (e.Option.isNone(workspaceRoot)) return "";

    const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
    const token = yield* fileSystem.readFileString(tokenPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed("")),
    );

    return token.trim();
  });

  const writeWriteRefreshToken = e.Effect.fn(function*(email: string, token: string) {
    if (e.Option.isNone(workspaceRoot)) return;

    yield* ensureUserStateDirectory(workspaceRoot.value, email).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
    const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
    yield* fileSystem.writeFileString(tokenPath, token, { mode: 0o600 }).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  });

  const clearWriteRefreshToken = e.Effect.fn(function*(email: string) {
    if (e.Option.isNone(workspaceRoot)) return;

    const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
    yield* fileSystem.remove(tokenPath, { force: true }).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  });

  return {
    requiredCLICommands: [],
    workspaceRoot,
    inWorkspace,
    readCurrentUserState,
    clearCurrentUserState,
    writeCurrentUserState,
    readReadOnlyTokenState,
    writeReadOnlyTokenState,
    readWriteRefreshToken,
    writeWriteRefreshToken,
    clearWriteRefreshToken,
  };
}));
