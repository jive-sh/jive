import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import { IToolState } from "@/modules";
import { WORKSPACE_DIR } from "./constants";
import type { ILegacyCredentialState, IReadOnlyTokenState } from "./interface";

const USERS_DIR = `${WORKSPACE_DIR}/users`;
const ACTIVE_USER_FILE = `${WORKSPACE_DIR}/active-user.json`;
const LEGACY_CREDENTIALS_FILE = `${WORKSPACE_DIR}/credentials.json`;
const READ_ONLY_TOKEN_FILE = "read-only-token.json";
const WRITE_REFRESH_TOKEN_FILE = "write-refresh-token.json";

export const ToolStateImpl = e.Layer.effect(IToolState, e.Effect.gen(function*() {
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
    const canonicalName = sanitizeEmailDirectoryName(email);
    const canonicalPath = path.join(root, USERS_DIR, canonicalName);

    const legacyEncodedName = encodeURIComponent(email.trim().toLowerCase());
    const legacyEncodedPath = path.join(root, USERS_DIR, legacyEncodedName);

    if (canonicalPath !== legacyEncodedPath) {
      const legacyExists = yield* pathExists(legacyEncodedPath);
      const canonicalExists = yield* pathExists(canonicalPath);
      if (legacyExists && !canonicalExists) {
        yield* fileSystem.rename(legacyEncodedPath, canonicalPath).pipe(
          e.Effect.catchAll(() => e.Effect.void),
        );
      }
    }

    return canonicalPath;
  });

  const ensureUserStateDirectory = e.Effect.fn(function*(root: string, email: string) {
    const directory = yield* userDirectory(root, email);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
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

  const readActiveUserEmail = e.Effect.fn(function*() {
    if (e.Option.isNone(workspaceRoot)) return e.Option.none<string>();

    const activeUserPath = path.join(workspaceRoot.value, ACTIVE_USER_FILE);
    const active = yield* readJsonObject(activeUserPath);
    if (e.Option.isNone(active)) return e.Option.none<string>();

    const email = active.value.email;
    return typeof email === "string" && email ? e.Option.some(email) : e.Option.none<string>();
  })();

  const writeActiveUserEmail = e.Effect.fn(function*(email: string) {
    if (e.Option.isNone(workspaceRoot)) return;

    const activeUserPath = path.join(workspaceRoot.value, ACTIVE_USER_FILE);
    yield* writeJsonObject(activeUserPath, { email }).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );
  });

  const readLegacyCredentialState = e.Effect.fn(function*() {
    if (e.Option.isNone(workspaceRoot)) return e.Option.none<ILegacyCredentialState>();

    const legacyPath = path.join(workspaceRoot.value, LEGACY_CREDENTIALS_FILE);
    const legacy = yield* readJsonObject(legacyPath);
    if (e.Option.isNone(legacy)) return e.Option.none<ILegacyCredentialState>();

    const token = typeof legacy.value.githubToken === "string"
      ? legacy.value.githubToken
      : typeof legacy.value.token === "string"
        ? legacy.value.token
        : "";

    const email = typeof legacy.value.email === "string"
      ? legacy.value.email
      : typeof legacy.value.githubEmail === "string"
        ? legacy.value.githubEmail
        : "";

    const gitUserName = typeof legacy.value.githubName === "string" && legacy.value.githubName
      ? legacy.value.githubName
      : email;

    if (!token || !email) return e.Option.none<ILegacyCredentialState>();

    return e.Option.some({ token, email, gitUserName });
  })();

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

    return e.Option.some({ token, scope, tokenType, gitUserName });
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
    workspaceRoot,
    inWorkspace,
    readActiveUserEmail,
    writeActiveUserEmail,
    readLegacyCredentialState,
    readReadOnlyTokenState,
    writeReadOnlyTokenState,
    readWriteRefreshToken,
    writeWriteRefreshToken,
    clearWriteRefreshToken,
  };
}));
