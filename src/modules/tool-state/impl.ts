import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import * as modules from "@/modules";
import { WORKSPACE_DIR } from "./constants";
import {
  RepoIntegrityCompromisedReason,
  VerifyRepoIntegrityError,
  type CurrentUserState,
  type IOrgScopedCloneTokenState,
  type IReadOnlyTokenState,
  type RepoIdentifier,
} from "./interface";

const USERS_DIR = `${WORKSPACE_DIR}/users`;
const CURRENT_USER_FILE = `${USERS_DIR}/current.json`;
const READ_ONLY_TOKEN_FILE = "readonly-github-clone-token.json";
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

  const repoPathFor = (repo: RepoIdentifier): string =>
    path.join(
      e.Option.getOrElse(workspaceRoot, () => process.cwd()),
      `@${repo.org}`,
      repo.repo,
    );

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

  const orgScopedCloneTokenFilePath = e.Effect.fn(function*(root: string, email: string, owner: string) {
    const directory = yield* userDirectory(root, email);
    const normalizedOwner = owner
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/[\/\\]/g, "_");
    return path.join(directory, `readonly-org-scoped-@${normalizedOwner}-repo-token.json`);
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

  return {
    getRepoPath: (repo: RepoIdentifier) => repoPathFor(repo),
    requiredCLICommands: [],
    workspaceRoot,
    inWorkspace: e.Effect.fn(function*() {
      return e.Option.isSome(workspaceRoot);
    })(),
    readCurrentUserState: e.Effect.fn(function*() {
      if (e.Option.isNone(workspaceRoot)) return e.Option.none<CurrentUserState>();

      const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
      const current = yield* readJsonObject(currentUserPath);
      if (e.Option.isNone(current)) return e.Option.none<CurrentUserState>();

      const email = current.value.email;
      if (typeof email !== "string" || !email) return e.Option.none<CurrentUserState>();
      return e.Option.some({ email });
    })(),
    clearCurrentUserState: e.Effect.fn(function*() {
      if (e.Option.isNone(workspaceRoot)) return;

      const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
      yield* fileSystem.remove(currentUserPath, { force: true }).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    })(),
    writeCurrentUserState: e.Effect.fn(function*(state: CurrentUserState) {
      if (e.Option.isNone(workspaceRoot)) return;

      yield* ensureUsersDirectory(workspaceRoot.value).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );

      const currentUserPath = path.join(workspaceRoot.value, CURRENT_USER_FILE);
      yield* writeJsonObject(currentUserPath, state).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    }),
    readReadOnlyTokenState: e.Effect.fn(function*(email: string) {
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
      const sshKeySource: "local" | "yubikey" = state.value.sshKeySource === "yubikey" ? "yubikey" : "local";
      const sshKeyFingerprint = typeof state.value.sshKeyFingerprint === "string" ? state.value.sshKeyFingerprint : "";
      const sshKeyName = typeof state.value.sshKeyName === "string" ? state.value.sshKeyName : "";
      const sshKeyPath = typeof state.value.sshKeyPath === "string" ? state.value.sshKeyPath : "";
      const yubiKeySerial = typeof state.value.yubiKeySerial === "string" ? state.value.yubiKeySerial : "";

      return e.Option.some({
        token,
        scope,
        tokenType,
        gitUserName,
        githubAccountId,
        githubUsername,
        sshKeySource,
        sshKeyFingerprint,
        sshKeyName,
        sshKeyPath,
        yubiKeySerial,
      });
    }),
    writeReadOnlyTokenState: e.Effect.fn(function*(email: string, state: IReadOnlyTokenState) {
      if (e.Option.isNone(workspaceRoot)) return;

      yield* ensureUserStateDirectory(workspaceRoot.value, email).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
      const tokenPath = yield* readOnlyTokenFilePath(workspaceRoot.value, email);
      yield* writeJsonObject(tokenPath, state).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    }),
    readOrgScopedCloneTokenState: e.Effect.fn(function*(email: string, owner: string) {
      if (e.Option.isNone(workspaceRoot)) return e.Option.none<IOrgScopedCloneTokenState>();

      const tokenPath = yield* orgScopedCloneTokenFilePath(workspaceRoot.value, email, owner);
      const state = yield* readJsonObject(tokenPath);
      if (e.Option.isNone(state)) return e.Option.none<IOrgScopedCloneTokenState>();

      const token = typeof state.value.token === "string" ? state.value.token : "";
      if (!token) return e.Option.none<IOrgScopedCloneTokenState>();

      const tokenType = typeof state.value.tokenType === "string" ? state.value.tokenType : "bearer";
      return e.Option.some({ token, tokenType });
    }),
    writeOrgScopedCloneTokenState: e.Effect.fn(function*(email: string, owner: string, state: IOrgScopedCloneTokenState) {
      if (e.Option.isNone(workspaceRoot)) return;

      yield* ensureUserStateDirectory(workspaceRoot.value, email).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
      const tokenPath = yield* orgScopedCloneTokenFilePath(workspaceRoot.value, email, owner);
      yield* writeJsonObject(tokenPath, state).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    }),
    readWriteRefreshToken: e.Effect.fn(function*(email: string) {
      if (e.Option.isNone(workspaceRoot)) return "";

      const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
      const token = yield* fileSystem.readFileString(tokenPath).pipe(
        e.Effect.catchAll(() => e.Effect.succeed("")),
      );

      return token.trim();
    }),
    writeWriteRefreshToken: e.Effect.fn(function*(email: string, token: string) {
      if (e.Option.isNone(workspaceRoot)) return;

      yield* ensureUserStateDirectory(workspaceRoot.value, email).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
      const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
      yield* fileSystem.writeFileString(tokenPath, token, { mode: 0o600 }).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    }),
    clearWriteRefreshToken: e.Effect.fn(function*(email: string) {
      if (e.Option.isNone(workspaceRoot)) return;

      const tokenPath = yield* writeRefreshTokenFilePath(workspaceRoot.value, email);
      yield* fileSystem.remove(tokenPath, { force: true }).pipe(
        e.Effect.catchAll(() => e.Effect.void),
      );
    }),
    verifyRepoIntegrity: e.Effect.fn(function*(repo: RepoIdentifier) {
      const repoPath = repoPathFor(repo);
      const repoExists = yield* pathExists(repoPath);
      if (!repoExists) {
        return yield* e.Effect.fail(new VerifyRepoIntegrityError({
          reason: RepoIntegrityCompromisedReason.RepoMissing(),
        }));
      }

      const packageJsonExists = yield* pathExists(path.join(repoPath, "package.json"));
      if (!packageJsonExists) {
        return yield* e.Effect.fail(new VerifyRepoIntegrityError({
          reason: RepoIntegrityCompromisedReason.NotAPackage(),
        }));
      }

      return { path: repoPath };
    }),
  };
}));
