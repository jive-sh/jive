import * as e from "effect";
import * as ep from "@effect/platform";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as modules from "@/modules";
import { GithubAccessTokenType } from "@/modules/github/interface";
import { MalformedKeyError, SshKey } from "@/modules/ssh/interface";
import { WORKSPACE_DIR } from "./constants";
import {
  RepoIntegrityCompromisedReason,
  RepoIdentifier,
  VerifyRepoIntegrityError,
  type CurrentUserState,
  type TokenExpirationState,
  type TokenState,
} from "./interface";

const USERS_DIR = "users";
const CURRENT_USER_FILE = "current.json";
const MANAGED_SSH_KEY_FILE = "ssh-key";

interface CurrentUserStateJson {
  readonly username: string;
  readonly email: string;
  readonly accessTokenState: {
    readonly tokenType: "OAuthApp" | "GithubApp";
    readonly token: string;
    readonly scope: string;
    readonly expiration: {
      readonly tokenExpiresAt: number;
      readonly refreshToken: string;
      readonly refreshTokenExpiresAt: number;
    } | null;
  };
  readonly sshKeyLocation: string | null;
}

export const ToolStateImpl = e.Layer.effect(modules.IToolState, e.Effect.gen(function*() {
  const fileSystem = yield* ep.FileSystem.FileSystem;

  const ignorePathError = <A>(effect: e.Effect.Effect<A, ep.Error.PlatformError>) =>
    e.pipe(
      effect,
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.void),
    );

  const orDiePathError = <A>(effect: e.Effect.Effect<A, ep.Error.PlatformError>) =>
    e.pipe(
      effect,
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );

  const pathExists = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.exists(targetPath),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed(false)),
    );
  });

  const readDirectory = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.readDirectory(targetPath),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed([] as string[])),
    );
  });

  const readFileString = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.readFileString(targetPath),
      e.Effect.map(contents => e.Option.some(contents)),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed(e.Option.none<string>())),
    );
  });

  const statIsDirectory = e.Effect.fn(function*(targetPath: string) {
    return yield* e.pipe(
      fileSystem.stat(targetPath),
      e.Effect.map(info => info.type === "Directory"),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed(false)),
    );
  });

  const findWorkspaceRoot = e.Effect.fn(function*() {
    let currentPath = process.cwd();
    while (true) {
      if (yield* statIsDirectory(path.join(currentPath, WORKSPACE_DIR))) {
        return e.Option.some(currentPath);
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return e.Option.none<string>();
      }
      currentPath = parentPath;
    }
  });

  const workspaceRoot = yield* findWorkspaceRoot();
  const rootPath = e.Option.getOrElse(workspaceRoot, () => process.cwd());
  const workspaceDirectoryPath = path.join(rootPath, WORKSPACE_DIR);
  const usersDirectoryPath = path.join(workspaceDirectoryPath, USERS_DIR);
  const currentUserFilePath = path.join(usersDirectoryPath, CURRENT_USER_FILE);

  const getRepoPath = (repo: RepoIdentifier): string =>
    path.join(rootPath, `@${repo.org}`, repo.repo);

  const sanitizeUserDirectory = (email: string): string =>
    email
      .trim()
      .toLowerCase()
      .replace(/[\/\\]/g, "_");

  const getUserDirectoryPath = (email: string): string =>
    path.join(usersDirectoryPath, sanitizeUserDirectory(email));

  const getManagedSshKeyPath = (email: string): string =>
    path.join(getUserDirectoryPath(email), MANAGED_SSH_KEY_FILE);

  const ensureDirectory = e.Effect.fn(function*(targetPath: string) {
    yield* orDiePathError(fileSystem.makeDirectory(targetPath, { recursive: true }));
  });

  const removePathIfPresent = e.Effect.fn(function*(targetPath: string) {
    yield* ignorePathError(fileSystem.remove(targetPath, { recursive: true, force: true }));
  });

  const readJsonObject = e.Effect.fn(function*(targetPath: string) {
    const maybeContents = yield* readFileString(targetPath);
    if (e.Option.isNone(maybeContents)) {
      return e.Option.none<Record<string, unknown>>();
    }
    try {
      const parsed = JSON.parse(maybeContents.value) as unknown;
      if (parsed && typeof parsed === "object") {
        return e.Option.some(parsed as Record<string, unknown>);
      }
    } catch {
      return e.Option.none<Record<string, unknown>>();
    }
    return e.Option.none<Record<string, unknown>>();
  });

  const writeJsonObject = e.Effect.fn(function*(targetPath: string, data: object) {
    yield* orDiePathError(fileSystem.writeFileString(targetPath, JSON.stringify(data, undefined, 2), { mode: 0o600 }));
  });

  const parseTokenExpiration = (value: unknown): e.Option.Option<TokenExpirationState> => {
    if (!value || typeof value !== "object") {
      return e.Option.none();
    }
    const expiration = value as Record<string, unknown>;
    const tokenExpiresAt = typeof expiration.tokenExpiresAt === "number" ? expiration.tokenExpiresAt : NaN;
    const refreshToken = typeof expiration.refreshToken === "string" ? expiration.refreshToken : "";
    const refreshTokenExpiresAt =
      typeof expiration.refreshTokenExpiresAt === "number" ?
        expiration.refreshTokenExpiresAt :
        NaN;
    if (!Number.isFinite(tokenExpiresAt) || !refreshToken || !Number.isFinite(refreshTokenExpiresAt)) {
      return e.Option.none();
    }
    return e.Option.some({
      tokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    });
  };

  const parseTokenType = (value: unknown) =>
    value === "GithubApp" ? GithubAccessTokenType.GithubApp() : GithubAccessTokenType.OAuthApp();

  const parseTokenState = (value: unknown): e.Option.Option<TokenState> => {
    if (!value || typeof value !== "object") {
      return e.Option.none();
    }
    const tokenState = value as Record<string, unknown>;
    const token = typeof tokenState.token === "string" ? tokenState.token : "";
    const scope = typeof tokenState.scope === "string" ? tokenState.scope : "";
    if (!token || !scope) {
      return e.Option.none();
    }
    return e.Option.some({
      tokenType: parseTokenType(tokenState.tokenType),
      token,
      scope,
      expiration: parseTokenExpiration(tokenState.expiration),
    });
  };

  const parseSshKey = e.Effect.fn(function*(value: unknown) {
    if (typeof value !== "string" || !value) {
      return e.Option.none<SshKey>();
    }
    return yield* e.pipe(
      SshKey.make(value),
      e.Effect.provideService(ep.FileSystem.FileSystem, fileSystem),
      e.Effect.map(sshKey => e.Option.some(sshKey)),
      e.Effect.catchTag("MalformedKeyError", () => e.Effect.succeed(e.Option.none<SshKey>())),
    );
  });

  const readCurrentUserState = e.Effect.gen(function*() {
    const currentUserJson = yield* readJsonObject(currentUserFilePath);
    if (e.Option.isNone(currentUserJson)) {
      return e.Option.none<CurrentUserState>();
    }

    const username = typeof currentUserJson.value.username === "string" ? currentUserJson.value.username : "";
    const email = typeof currentUserJson.value.email === "string" ? currentUserJson.value.email : "";
    const accessTokenState = parseTokenState(currentUserJson.value.accessTokenState);
    if (!username || !email || e.Option.isNone(accessTokenState)) {
      return e.Option.none<CurrentUserState>();
    }

    const sshKey = yield* parseSshKey(currentUserJson.value.sshKeyLocation);
    return e.Option.some({
      username,
      email,
      accessTokenState: accessTokenState.value,
      sshKey,
    });
  });

  const writeCurrentUserState = e.Effect.fn(function*(state: CurrentUserState) {
    yield* ensureDirectory(usersDirectoryPath);
    const serialized: CurrentUserStateJson = {
      username: state.username,
      email: state.email,
      accessTokenState: {
        tokenType: state.accessTokenState.tokenType._tag,
        token: state.accessTokenState.token,
        scope: state.accessTokenState.scope,
        expiration: e.Option.match(state.accessTokenState.expiration, {
          onNone: () => null,
          onSome: expiration => ({
            tokenExpiresAt: expiration.tokenExpiresAt,
            refreshToken: expiration.refreshToken,
            refreshTokenExpiresAt: expiration.refreshTokenExpiresAt,
          }),
        }),
      },
      sshKeyLocation: e.Option.match(state.sshKey, {
        onNone: () => null,
        onSome: sshKey => sshKey.location,
      }),
    };
    yield* writeJsonObject(currentUserFilePath, serialized);
  });

  const copyManagedSshKey = e.Effect.fn(function*(email: string, sshKey: SshKey) {
    const targetPath = getManagedSshKeyPath(email);
    yield* ensureDirectory(getUserDirectoryPath(email));

    const privateKeyContents = yield* e.pipe(
      fileSystem.readFileString(sshKey.location),
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );
    const publicKeyContents = yield* e.pipe(
      fileSystem.readFileString(`${sshKey.location}.pub`),
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );

    yield* orDiePathError(fileSystem.writeFileString(targetPath, privateKeyContents, { mode: 0o600 }));
    yield* orDiePathError(fileSystem.writeFileString(`${targetPath}.pub`, publicKeyContents, { mode: 0o644 }));

    return yield* e.pipe(
      SshKey.make(targetPath),
      e.Effect.provideService(ep.FileSystem.FileSystem, fileSystem),
      e.Effect.catchTag("MalformedKeyError", (error: MalformedKeyError) => e.Effect.die(error)),
    );
  });

  return {
    getRepoPath,
    inWorkspace: e.Option.isSome(workspaceRoot),
    usingTempDirectory: <T, E>(doThing: (tempPath: string) => e.Effect.Effect<T, E>) => e.Effect.gen(function*() {
      const tempPath = path.join(os.tmpdir(), `jive-${randomUUID()}`);
      yield* ensureDirectory(tempPath);
      return yield* e.Effect.ensuring(
        doThing(tempPath),
        removePathIfPresent(tempPath),
      );
    }),
    readCurrentUserState,
    clearCurrentUserState: e.Effect.gen(function*() {
      yield* removePathIfPresent(currentUserFilePath);
    }),
    setUser: e.Effect.fn(function*({
      email,
      username,
      accessToken,
    }: {
      readonly email: string;
      readonly username: string;
      readonly accessToken: TokenState;
    }) {
      const managedSshKeyPath = getManagedSshKeyPath(email);
      yield* ensureDirectory(getUserDirectoryPath(email));
      yield* removePathIfPresent(managedSshKeyPath);
      yield* removePathIfPresent(`${managedSshKeyPath}.pub`);

      const newUserState: CurrentUserState = {
        username,
        email,
        accessTokenState: accessToken,
        sshKey: e.Option.none(),
      };
      yield* writeCurrentUserState(newUserState);
      return newUserState;
    }),
    setSshKey: e.Effect.fn(function*(sshKey: SshKey) {
      const maybeCurrentUserState = yield* readCurrentUserState;
      if (e.Option.isNone(maybeCurrentUserState)) {
        return yield* e.Effect.dieMessage("IMPOSSIBLE TO SET SSH KEY WITH NO CURRENT USER");
      }
      const managedSshKey = yield* copyManagedSshKey(maybeCurrentUserState.value.email, sshKey);
      const newUserState: CurrentUserState = {
        ...maybeCurrentUserState.value,
        sshKey: e.Option.some(managedSshKey),
      };
      yield* writeCurrentUserState(newUserState);
      return { newUserState };
    }),
    verifyRepoIntegrity: e.Effect.fn(function*(repo: RepoIdentifier) {
      const repoPath = getRepoPath(repo);
      if (!(yield* pathExists(repoPath))) {
        return yield* new VerifyRepoIntegrityError({
          reason: RepoIntegrityCompromisedReason.RepoMissing(),
        });
      }
      if (!(yield* pathExists(path.join(repoPath, ".git")))) {
        return yield* new VerifyRepoIntegrityError({
          reason: RepoIntegrityCompromisedReason.SubmoduleMisconfiguration(),
        });
      }
      if (!(yield* pathExists(path.join(repoPath, "package.json")))) {
        return yield* new VerifyRepoIntegrityError({
          reason: RepoIntegrityCompromisedReason.NotAPackage(),
        });
      }
      return { path: repoPath };
    }),
    addRepo: e.Effect.fn(function*(repo: RepoIdentifier) {
      yield* ensureDirectory(path.dirname(getRepoPath(repo)));
    }),
  };
}));
