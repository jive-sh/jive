import * as e from "effect";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { GithubAccessTokenType } from "@/modules/github/interface";
import { SshKey } from "@/modules/ssh/ssh-key";
import { WORKSPACE_DIR } from "./constants";
import {
  NotInWorkspaceError,
  RepoIntegrityCompromisedReason,
  VerifyRepoIntegrityError,
  type CurrentUserState,
  type IToolState,
  type RepoLocation,
  type TokenExpirationState,
  type TokenState,
} from "./interface";
import type { RepoIdentifier } from "./repo-identifier";

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

/**
 * The workspace is the nearest directory, from the current one upward, holding a `.jive` directory; its loaded
 * repos live at `@<org>/<repo>` under it and its signed-in user's state under `.jive/users`.
 */
export class ToolStateImpl extends implementing(modules.toolState).uses(e.FileSystem.FileSystem) implements IToolState {
  *assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError> {
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot();
    if (e.Option.isNone(maybeWorkspaceRoot)) {
      return yield* new NotInWorkspaceError({ path: process.cwd() });
    }
    return { workspaceRoot: maybeWorkspaceRoot.value };
  }

  *usingTempDirectory<T, E, R>(doThing: (tempPath: string) => e.Effect.Effect<T, E, R>): EffectGen<T, E, R> {
    const tempPath = path.join(os.tmpdir(), `jive-${randomUUID()}`);
    yield* this.ensureDirectory(tempPath);
    return yield* e.Effect.ensuring(doThing(tempPath), e.Effect.gen(() => this.removePathIfPresent(tempPath)));
  }

  *readCurrentUserState(): EffectGen<e.Option.Option<CurrentUserState>> {
    const currentUserJson = yield* this.readJsonObject(yield* this.currentUserFilePath());
    if (e.Option.isNone(currentUserJson)) {
      return e.Option.none();
    }

    const username = typeof currentUserJson.value["username"] === "string" ? currentUserJson.value["username"] : "";
    const email = typeof currentUserJson.value["email"] === "string" ? currentUserJson.value["email"] : "";
    const accessTokenState = parseTokenState(currentUserJson.value["accessTokenState"]);
    if (!username || !email || e.Option.isNone(accessTokenState)) {
      return e.Option.none();
    }

    const sshKey = yield* this.parseSshKey(currentUserJson.value["sshKeyLocation"]);
    return e.Option.some({
      username,
      email,
      accessTokenState: accessTokenState.value,
      sshKey,
    });
  }

  *clearCurrentUserState(): EffectGen<void> {
    yield* this.removePathIfPresent(yield* this.currentUserFilePath());
  }

  *setUser({ email, username, accessToken }: { email: string; username: string; accessToken: TokenState }): EffectGen<CurrentUserState> {
    const managedSshKeyPath = yield* this.managedSshKeyPath(email);
    yield* this.ensureDirectory(path.dirname(managedSshKeyPath));
    yield* this.removePathIfPresent(managedSshKeyPath);
    yield* this.removePathIfPresent(`${managedSshKeyPath}.pub`);

    const newUserState: CurrentUserState = {
      username,
      email,
      accessTokenState: accessToken,
      sshKey: e.Option.none(),
    };
    yield* this.writeCurrentUserState(newUserState);
    return newUserState;
  }

  *setSshKey(sshKey: SshKey): EffectGen<{ newUserState: CurrentUserState }> {
    const maybeCurrentUserState = yield* this.readCurrentUserState();
    if (e.Option.isNone(maybeCurrentUserState)) {
      return yield* e.Effect.die("IMPOSSIBLE TO SET SSH KEY WITH NO CURRENT USER");
    }
    const managedSshKey = yield* this.copyManagedSshKey(maybeCurrentUserState.value.email, sshKey);
    const newUserState: CurrentUserState = {
      ...maybeCurrentUserState.value,
      sshKey: e.Option.some(managedSshKey),
    };
    yield* this.writeCurrentUserState(newUserState);
    return { newUserState };
  }

  *verifyRepoIntegrity(repo: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError | BadArgumentError> {
    const orgLocation = yield* this.orgPath(repo);
    const repoLocation = yield* this.repoPath(repo);
    const failWith = (reason: RepoIntegrityCompromisedReason) =>
      VerifyRepoIntegrityError.toToolError(new VerifyRepoIntegrityError({ reason, repo }));
    if (!(yield* this.pathExists(orgLocation.absolutePath))) {
      return yield* failWith(RepoIntegrityCompromisedReason.OrgMissing());
    }
    if (!(yield* this.pathExists(repoLocation.absolutePath))) {
      return yield* failWith(RepoIntegrityCompromisedReason.RepoMissing());
    }
    if (!(yield* this.pathExists(path.join(repoLocation.absolutePath, ".git")))) {
      return yield* failWith(RepoIntegrityCompromisedReason.SubmoduleMisconfiguration());
    }
    if (!(yield* this.pathExists(path.join(repoLocation.absolutePath, "package.json")))) {
      return yield* failWith(RepoIntegrityCompromisedReason.NotAPackage());
    }
    return repoLocation;
  }

  *orgPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRootOrFail();
    return {
      relativePath: repoId.orgName(),
      absolutePath: path.join(workspaceRoot, repoId.orgName()),
    };
  }

  *repoPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError> {
    const { relativePath, absolutePath } = yield* this.orgPath(repoId);
    return {
      relativePath: path.join(relativePath, repoId.repo),
      absolutePath: path.join(absolutePath, repoId.repo),
    };
  }

  private *workspaceRootOrFail(): EffectGen<string, BadPreconditionsError> {
    const maybeWorkspaceRoot = yield* this.findWorkspaceRoot();
    if (e.Option.isNone(maybeWorkspaceRoot)) {
      return yield* BadPreconditionsError.fromNotInWorkspaceError(new NotInWorkspaceError({ path: process.cwd() }));
    }
    return maybeWorkspaceRoot.value;
  }

  private *findWorkspaceRoot(): EffectGen<e.Option.Option<string>> {
    let currentPath = process.cwd();
    while (true) {
      if (yield* this.isDirectory(path.join(currentPath, WORKSPACE_DIR))) {
        return e.Option.some(currentPath);
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return e.Option.none();
      }
      currentPath = parentPath;
    }
  }

  /** User state is kept beside the workspace when there is one, and beside the current directory otherwise. */
  private *usersDirectoryPath(): EffectGen<string> {
    const rootPath = e.Option.getOrElse(yield* this.findWorkspaceRoot(), () => process.cwd());
    return path.join(rootPath, WORKSPACE_DIR, USERS_DIR);
  }

  private *currentUserFilePath(): EffectGen<string> {
    return path.join(yield* this.usersDirectoryPath(), CURRENT_USER_FILE);
  }

  private *managedSshKeyPath(email: string): EffectGen<string> {
    const userDirectory = email.trim().toLowerCase().replace(/[\/\\]/g, "_");
    return path.join(yield* this.usersDirectoryPath(), userDirectory, MANAGED_SSH_KEY_FILE);
  }

  private *pathExists(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).exists(targetPath),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *isDirectory(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).stat(targetPath),
      e.Effect.map(info => info.type === "Directory"),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *ensureDirectory(targetPath: string): EffectGen<void> {
    yield* e.Effect.orDie(this.getDependency(e.FileSystem.FileSystem).makeDirectory(targetPath, { recursive: true }));
  }

  private *removePathIfPresent(targetPath: string): EffectGen<void> {
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).remove(targetPath, { recursive: true, force: true }),
      e.Effect.catchTag("PlatformError", () => e.Effect.void),
    );
  }

  private *readJsonObject(targetPath: string): EffectGen<e.Option.Option<Record<string, unknown>>> {
    const maybeContents = yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).readFileString(targetPath),
      e.Effect.map(e.Option.some),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(e.Option.none<string>())),
    );
    if (e.Option.isNone(maybeContents)) {
      return e.Option.none();
    }
    try {
      const parsed: unknown = JSON.parse(maybeContents.value);
      return parsed !== null && typeof parsed === "object" ? e.Option.some(parsed as Record<string, unknown>) : e.Option.none();
    } catch {
      return e.Option.none();
    }
  }

  private *writeCurrentUserState(state: CurrentUserState): EffectGen<void> {
    const currentUserFilePath = yield* this.currentUserFilePath();
    yield* this.ensureDirectory(path.dirname(currentUserFilePath));
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
    yield* e.Effect.orDie(this.getDependency(e.FileSystem.FileSystem).writeFileString(
      currentUserFilePath,
      JSON.stringify(serialized, undefined, 2),
      { mode: 0o600 },
    ));
  }

  private *parseSshKey(value: unknown): EffectGen<e.Option.Option<SshKey>> {
    if (typeof value !== "string" || !value) {
      return e.Option.none();
    }
    return yield* e.pipe(
      SshKey.make(value),
      e.Effect.provideService(e.FileSystem.FileSystem, this.getDependency(e.FileSystem.FileSystem)),
      e.Effect.map(e.Option.some),
      e.Effect.catchTag("MalformedKeyError", () => e.Effect.succeed(e.Option.none<SshKey>())),
    );
  }

  private *copyManagedSshKey(email: string, sshKey: SshKey): EffectGen<SshKey> {
    const fileSystem = this.getDependency(e.FileSystem.FileSystem);
    const targetPath = yield* this.managedSshKeyPath(email);
    yield* this.ensureDirectory(path.dirname(targetPath));

    const privateKeyContents = yield* e.Effect.orDie(fileSystem.readFileString(sshKey.location));
    const publicKeyContents = yield* e.Effect.orDie(fileSystem.readFileString(`${sshKey.location}.pub`));
    yield* e.Effect.orDie(fileSystem.writeFileString(targetPath, privateKeyContents, { mode: 0o600 }));
    yield* e.Effect.orDie(fileSystem.writeFileString(`${targetPath}.pub`, publicKeyContents, { mode: 0o644 }));

    return yield* e.pipe(
      SshKey.make(targetPath),
      e.Effect.provideService(e.FileSystem.FileSystem, fileSystem),
      e.Effect.orDie,
    );
  }
}

function parseTokenExpiration(value: unknown): e.Option.Option<TokenExpirationState> {
  if (!value || typeof value !== "object") {
    return e.Option.none();
  }
  const expiration = value as Record<string, unknown>;
  const tokenExpiresAt = typeof expiration["tokenExpiresAt"] === "number" ? expiration["tokenExpiresAt"] : NaN;
  const refreshToken = typeof expiration["refreshToken"] === "string" ? expiration["refreshToken"] : "";
  const refreshTokenExpiresAt =
    typeof expiration["refreshTokenExpiresAt"] === "number" ? expiration["refreshTokenExpiresAt"] : NaN;
  if (!Number.isFinite(tokenExpiresAt) || !refreshToken || !Number.isFinite(refreshTokenExpiresAt)) {
    return e.Option.none();
  }
  return e.Option.some({ tokenExpiresAt, refreshToken, refreshTokenExpiresAt });
}

function parseTokenState(value: unknown): e.Option.Option<TokenState> {
  if (!value || typeof value !== "object") {
    return e.Option.none();
  }
  const tokenState = value as Record<string, unknown>;
  const token = typeof tokenState["token"] === "string" ? tokenState["token"] : "";
  const scope = typeof tokenState["scope"] === "string" ? tokenState["scope"] : "";
  if (!token || !scope) {
    return e.Option.none();
  }
  return e.Option.some({
    tokenType: tokenState["tokenType"] === "GithubApp" ? GithubAccessTokenType.GithubApp() : GithubAccessTokenType.OAuthApp(),
    token,
    scope,
    expiration: parseTokenExpiration(tokenState["expiration"]),
  });
}
