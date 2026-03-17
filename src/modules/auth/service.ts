import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import { authKeyName, signingKeyName } from "./constants";
import {
  loadCredentials,
  saveCredentials,
  saveUserTokenState,
  type ToolStateApi,
} from "./credentials";
import { printGitHubJiveKeyList, selectVerifiedEmail } from "./key-selection";
import {
  displayAutoClosingOAuthBrowserAction,
  displayOAuthBrowserAction,
  redirectOAuthBrowserAction,
  type OAuthBrowserAction,
} from "./oauth";
import { selectOne } from "@/prompts";
import type { Credentials } from "./types";
import type { GitService } from "../git/interface";
import type { GitHubService } from "../github/interface";
import type { GitHubJiveKeyInventory, GitHubSession, GitHubUserKey } from "../github/types";
import type { SshService } from "../ssh/interface";
import type { SshJiveKey } from "../ssh/types";
import { WORKSPACE_DIR } from "../tool-state/constants";
import type { CurrentUserState } from "../tool-state/interface";
import type { ConnectedYubiKey } from "../yubikey/interface";

type AuthServiceHostShell = {
  readonly hasCommand: (command: string) => e.Effect.Effect<boolean>;
};

export type AuthGitService = Pick<GitService, "localOrgs" | "localRepos"> & {
  readonly configureRepoRemoteAndUser: (
    org: string,
    repo: string,
    identity: {
      readonly userName: string;
      readonly userEmail: string;
      readonly sshPrivateKeyPath: string;
    },
  ) => e.Effect.Effect<boolean, unknown>;
};

interface AuthServiceDependencies {
  readonly toolState: ToolStateApi;
  readonly git: AuthGitService;
  readonly github: GitHubService;
  readonly hostShell: AuthServiceHostShell;
  readonly ssh: Pick<
    SshService,
    "ensureResidentSshSupport" | "resolveStoredSshKey" | "selectOrCreateLocalSshKey" | "selectOrCreateYubiKeySshKey"
  >;
  readonly yubiKey: {
    readonly listConnectedDevices: e.Effect.Effect<ConnectedYubiKey[]>;
    readonly ensurePinConfigured: (serial: string) => e.Effect.Effect<boolean>;
  };
}

interface ReadOnlyLoginResult {
  readonly session: GitHubSession;
  readonly verifiedEmails: readonly string[];
}

interface WriteSessionResult {
  readonly session: GitHubSession;
  readonly continueInBrowser: e.Option.Option<(action: OAuthBrowserAction) => void>;
}

interface PreparedAuthState {
  readonly root: string;
  readonly currentUser: CurrentUserState;
  readonly credentials: Credentials;
  readonly sshKey: SshJiveKey;
  readonly githubJiveKeys: GitHubJiveKeyInventory;
  readonly reusableWriteSession: e.Option.Option<GitHubSession>;
}

interface EnsuredGitHubKeyMaterial {
  readonly credentials: Credentials;
  readonly sshKey: SshJiveKey;
  readonly githubJiveKeys: GitHubJiveKeyInventory;
}

interface ExistingReadState {
  readonly credentials: Credentials;
  readonly githubJiveKeys: GitHubJiveKeyInventory;
}

type AcquireReusableWriteSession = (
  expectedCredentials: e.Option.Option<Credentials>,
) => e.Effect.Effect<e.Option.Option<GitHubSession>>;

interface RunLoginFlowOptions {
  readonly successPrefix: string;
  readonly promptAccountSelection: boolean;
}

export const login = (
  dependencies: AuthServiceDependencies,
)=>
  e.Effect.gen(function*() {
    yield* dependencies.toolState.clearCurrentUserState;
    yield* runLoginFlow(dependencies, {
      successPrefix: "Logged in as",
      promptAccountSelection: true,
    });
  });

export const ensureLoggedIn = (
  dependencies: AuthServiceDependencies,
)=> runLoginFlow(dependencies, {
  successPrefix: "Ensured login for",
  promptAccountSelection: false,
});

const runLoginFlow = (
  dependencies: AuthServiceDependencies,
  options: RunLoginFlowOptions,
) =>
  e.Effect.gen(function*() {
    const prepared = yield* prepareExistingOrFreshAuthState(dependencies, options);
    if (e.Option.isNone(prepared)) return;

    const acquireReusableWriteSession = createReusableWriteSessionAcquirer(
      dependencies,
      prepared.value.reusableWriteSession,
    );

    const ensured = yield* ensureGitHubKeyMaterial(
      dependencies,
      prepared.value,
      acquireReusableWriteSession,
    );
    if (e.Option.isNone(ensured)) return;

    yield* finalizeAuthState(dependencies, prepared.value.root, prepared.value.currentUser, ensured.value);
    yield* e.Effect.log(
      `${options.successPrefix} @${ensured.value.credentials.githubUsername} (${prepared.value.currentUser.email})`,
    );
  });

const prepareFreshLoginState = (
  dependencies: AuthServiceDependencies,
  options: RunLoginFlowOptions,
): e.Effect.Effect<e.Option.Option<PreparedAuthState>> =>
  e.Effect.gen(function*() {
    const { github, toolState } = dependencies;
    const root = yield* requireWorkspaceRoot(toolState);
    if (e.Option.isNone(root)) return e.Option.none<PreparedAuthState>();
    if (!(yield* ensureGitHubOAuthConfigured(github))) return e.Option.none<PreparedAuthState>();

    const writeLogin = github.beginWriteLogin({ promptAccountSelection: options.promptAccountSelection });
    const writeSession = yield* writeLogin.waitForSession;
    if (e.Option.isNone(writeSession)) return e.Option.none<PreparedAuthState>();

    const readOnlyLogin = yield* acquireReadOnlySession(
      github,
      writeSession.value,
      e.Option.some(writeLogin.continueInBrowser),
    );
    if (e.Option.isNone(readOnlyLogin)) return e.Option.none<PreparedAuthState>();

    const githubJiveKeys = yield* github.listJiveKeys(readOnlyLogin.value.session.token);
    if (e.Option.isNone(githubJiveKeys)) {
      yield* e.Effect.logError("Could not list existing Jive keys on GitHub with the read token.");
      return e.Option.none<PreparedAuthState>();
    }

    yield* printGitHubJiveKeyList(
      githubJiveKeys.value.auth,
      githubJiveKeys.value.signing,
    );

    const selectedEmail = yield* selectVerifiedEmail({
      verifiedEmails: Array.from(readOnlyLogin.value.verifiedEmails),
      discoveredEmail: readOnlyLogin.value.session.discoveredEmail,
    });
    if (e.Option.isNone(selectedEmail)) return e.Option.none<PreparedAuthState>();

    const sshKey = yield* resolveSelectedSshKey(
      dependencies,
      root.value,
      selectedEmail.value,
      e.Option.none(),
    );
    if (e.Option.isNone(sshKey)) return e.Option.none<PreparedAuthState>();

    const currentUser: CurrentUserState = { email: selectedEmail.value };
    const credentials = buildCredentials(
      currentUser.email,
      writeSession.value,
      readOnlyLogin.value.session,
      sshKey.value,
    );
    yield* persistSelectedAuthState(toolState, currentUser, credentials);
    yield* printKeyNamingConvention(credentials);

    return e.Option.some({
      root: root.value,
      currentUser,
      credentials,
      sshKey: sshKey.value,
      githubJiveKeys: githubJiveKeys.value,
      reusableWriteSession: e.Option.some(writeSession.value),
    });
  });

const prepareExistingOrFreshAuthState = (
  dependencies: AuthServiceDependencies,
  options: RunLoginFlowOptions,
): e.Effect.Effect<e.Option.Option<PreparedAuthState>> =>
  e.Effect.gen(function*() {
    const { github, toolState } = dependencies;
    const root = yield* requireWorkspaceRoot(toolState);
    if (e.Option.isNone(root)) return e.Option.none<PreparedAuthState>();
    if (!(yield* ensureGitHubOAuthConfigured(github))) return e.Option.none<PreparedAuthState>();

    const currentUserState = yield* toolState.readCurrentUserState;
    if (e.Option.isNone(currentUserState)) {
      return yield* prepareFreshLoginState(dependencies, options);
    }

    const existingReadState = yield* loadExistingReadState(github, toolState, currentUserState.value.email);
    if (e.Option.isSome(existingReadState)) {
      const sshKey = yield* resolveSelectedSshKey(
        dependencies,
        root.value,
        currentUserState.value.email,
        e.Option.some(existingReadState.value.credentials),
      );
      if (e.Option.isNone(sshKey)) return e.Option.none<PreparedAuthState>();

      const credentials = mergeCredentialsWithSshKey(existingReadState.value.credentials, sshKey.value);
      yield* toolState.writeCurrentUserState(currentUserState.value);
      yield* saveCredentials(toolState, credentials);
      yield* printKeyNamingConvention(credentials);

      return e.Option.some({
        root: root.value,
        currentUser: currentUserState.value,
        credentials,
        sshKey: sshKey.value,
        githubJiveKeys: existingReadState.value.githubJiveKeys,
        reusableWriteSession: e.Option.none(),
      });
    }

    return yield* reacquirePreparedAuthState(
      dependencies,
      root.value,
      currentUserState.value,
    );
  });

const reacquirePreparedAuthState = (
  dependencies: AuthServiceDependencies,
  root: string,
  currentUser: CurrentUserState,
): e.Effect.Effect<e.Option.Option<PreparedAuthState>> =>
  e.Effect.gen(function*() {
    const { github, toolState } = dependencies;
    const existingCredentials = yield* loadCredentials(toolState);

    const writeSession = yield* acquireWriteSession(dependencies, existingCredentials);
    if (e.Option.isNone(writeSession)) return e.Option.none<PreparedAuthState>();

    const readOnlyLogin = yield* acquireReadOnlySession(
      github,
      writeSession.value.session,
      writeSession.value.continueInBrowser,
    );
    if (e.Option.isNone(readOnlyLogin)) return e.Option.none<PreparedAuthState>();

    if (!readOnlyLogin.value.verifiedEmails.includes(currentUser.email)) {
      yield* e.Effect.logError(
        `The currently selected email ${currentUser.email} is not a verified email on @${readOnlyLogin.value.session.username}. Run \`${TOOL_NAME} login\` to choose a different email.`,
      );
      return e.Option.none<PreparedAuthState>();
    }

    const githubJiveKeys = yield* github.listJiveKeys(readOnlyLogin.value.session.token);
    if (e.Option.isNone(githubJiveKeys)) {
      yield* e.Effect.logError("Could not list existing Jive keys on GitHub with the refreshed read token.");
      return e.Option.none<PreparedAuthState>();
    }

    const sshKey = yield* resolveSelectedSshKey(
      dependencies,
      root,
      currentUser.email,
      existingCredentials,
    );
    if (e.Option.isNone(sshKey)) return e.Option.none<PreparedAuthState>();

    const credentials = buildCredentials(
      currentUser.email,
      writeSession.value.session,
      readOnlyLogin.value.session,
      sshKey.value,
    );
    yield* persistSelectedAuthState(toolState, currentUser, credentials);
    yield* printKeyNamingConvention(credentials);

    return e.Option.some({
      root,
      currentUser,
      credentials,
      sshKey: sshKey.value,
      githubJiveKeys: githubJiveKeys.value,
      reusableWriteSession: e.Option.some(writeSession.value.session),
    });
  });

const ensureGitHubKeyMaterial = (
  dependencies: AuthServiceDependencies,
  prepared: PreparedAuthState,
  acquireReusableWriteSession: AcquireReusableWriteSession,
): e.Effect.Effect<e.Option.Option<EnsuredGitHubKeyMaterial>> =>
  e.Effect.gen(function*() {
    const { credentials, githubJiveKeys, sshKey } = prepared;
    const { github } = dependencies;
    const keyName = authKeyName(credentials.email, credentials.sshKeyName, credentials.sshKeyFingerprint);
    const signingName = signingKeyName(credentials.email, credentials.sshKeyName, credentials.sshKeyFingerprint);

    const needsAuthRepair = !hasGitHubAuthKey(githubJiveKeys, keyName, sshKey.publicKey);
    const needsSigningRepair = !hasGitHubSigningKey(githubJiveKeys, signingName, sshKey.publicKey);

    let nextCredentials = credentials;
    let nextGitHubJiveKeys = githubJiveKeys;

    if (needsAuthRepair || needsSigningRepair) {
      const writeSession = yield* acquireReusableWriteSession(e.Option.some(nextCredentials));
      if (e.Option.isNone(writeSession)) return e.Option.none<EnsuredGitHubKeyMaterial>();

      nextCredentials = mergeCredentialsWithWriteSession(nextCredentials, writeSession.value);

      if (needsAuthRepair) {
        yield* github.ensureAuthKey(
          writeSession.value.token,
          keyName,
          sshKey.publicKey,
          e.Option.some(githubJiveKeys),
        );
      }

      if (needsSigningRepair) {
        yield* github.ensureSigningKey(
          writeSession.value.token,
          signingName,
          sshKey.publicKey,
          e.Option.some(githubJiveKeys),
        );
      }

      const refreshedInventory = yield* github.listJiveKeys(nextCredentials.readOnlyToken);
      nextGitHubJiveKeys = e.Option.getOrElse(
        refreshedInventory,
        () => upsertGitHubKeys(githubJiveKeys, keyName, signingName, sshKey.publicKey),
      );
    }

    return e.Option.some({
      credentials: nextCredentials,
      sshKey,
      githubJiveKeys: nextGitHubJiveKeys,
    });
  });

const finalizeAuthState = (
  dependencies: AuthServiceDependencies,
  root: string,
  currentUser: CurrentUserState,
  ensured: EnsuredGitHubKeyMaterial,
)=>
  e.Effect.gen(function*() {
    const { git, github, toolState } = dependencies;
    yield* toolState.writeCurrentUserState(currentUser);
    yield* saveCredentials(toolState, ensured.credentials);
    yield* applyStoredIdentityToWorkspace(root, ensured.credentials, ensured.sshKey, git);
    yield* github.checkWorkspaceRepoAccess(root, ensured.credentials.readOnlyToken, git);
  });

const applyStoredIdentityToWorkspace = (
  root: string,
  credentials: Credentials,
  sshKey: SshJiveKey,
  git: AuthGitService,
)=>
  e.Effect.gen(function*() {
    void root;
    const orgs = yield* git.localOrgs;
    for (const org of orgs) {
      const repos = yield* git.localRepos(org);
      for (const repo of repos) {
        const configured = yield* git.configureRepoRemoteAndUser(org, repo, {
          userName: credentials.gitUserName || credentials.email,
          userEmail: credentials.email,
          sshPrivateKeyPath: sshKey.privateKeyPath,
        });
        if (!configured) {
          yield* e.Effect.logWarning(`Could not apply git identity config to @${org}/${repo}.`);
        }
      }
    }
  });

const requireWorkspaceRoot = (
  toolState: ToolStateApi,
): e.Effect.Effect<e.Option.Option<string>> =>
  e.Effect.gen(function*() {
    const root = toolState.workspaceRoot;
    if (e.Option.isNone(root)) {
      yield* e.Effect.logError(`No ${WORKSPACE_DIR} workspace found. Run \`${TOOL_NAME} init\` first.`);
      return e.Option.none<string>();
    }
    return root;
  });

const ensureGitHubOAuthConfigured = (github: GitHubService): e.Effect.Effect<boolean> =>
  e.Effect.gen(function*() {
    if (github.isOAuthConfigured()) return true;

    yield* e.Effect.logError(`${TOOL_NAME} has no GitHub OAuth App configured yet.`);
    yield* e.Effect.logError(
      "Register one at https://github.com/settings/developers and set CLIENT_ID/CLIENT_SECRET in src/modules/github/service.ts.",
    );
    return false;
  });

const loadExistingReadState = (
  github: GitHubService,
  toolState: ToolStateApi,
  selectedEmail: string,
): e.Effect.Effect<e.Option.Option<ExistingReadState>> =>
  e.Effect.gen(function*() {
    const credentials = yield* loadCredentials(toolState);
    if (e.Option.isNone(credentials)) return e.Option.none<ExistingReadState>();
    if (credentials.value.email !== selectedEmail) return e.Option.none<ExistingReadState>();
    if (!credentials.value.sshKeyPath.trim()) return e.Option.none<ExistingReadState>();
    if (!github.isReadScopeSatisfied(credentials.value.readOnlyTokenScope)) return e.Option.none<ExistingReadState>();

    const verifiedEmails = yield* github.getVerifiedEmails(credentials.value.readOnlyToken);
    if (!verifiedEmails.includes(selectedEmail)) return e.Option.none<ExistingReadState>();

    const githubJiveKeys = yield* github.listJiveKeys(credentials.value.readOnlyToken);
    if (e.Option.isNone(githubJiveKeys)) return e.Option.none<ExistingReadState>();

    return e.Option.some({
      credentials: credentials.value,
      githubJiveKeys: githubJiveKeys.value,
    });
  });

const resolveSelectedSshKey = (
  dependencies: AuthServiceDependencies,
  workspaceRoot: string,
  email: string,
  expectedCredentials: e.Option.Option<Credentials>,
): e.Effect.Effect<e.Option.Option<SshJiveKey>> =>
  e.Effect.gen(function*() {
    const { ssh } = dependencies;

    if (e.Option.isSome(expectedCredentials) && expectedCredentials.value.sshKeyPath.trim()) {
      const matching = yield* ssh.resolveStoredSshKey(
        workspaceRoot,
        expectedCredentials.value.sshKeyPath,
        expectedCredentials.value.sshKeySource,
        expectedCredentials.value.yubiKeySerial,
      );
      if (e.Option.isSome(matching)) return matching;

      yield* e.Effect.logWarning(
        `Previously selected SSH key ${expectedCredentials.value.sshKeyPath} is not currently available. Select a different key.`,
      );
    }

    yield* e.Effect.log(
      "Select the SSH key Jive should use for both GitHub auth and commit signing.",
    );

    const source = yield* selectKeySource();
    if (e.Option.isNone(source)) return e.Option.none<SshJiveKey>();

    if (source.value === "local") {
      return yield* ssh.selectOrCreateLocalSshKey(workspaceRoot, email);
    }

    return yield* selectOrCreateYubiKeyBackedSshKey(dependencies, workspaceRoot, email);
  });

const selectOrCreateYubiKeyBackedSshKey = (
  dependencies: AuthServiceDependencies,
  workspaceRoot: string,
  email: string,
): e.Effect.Effect<e.Option.Option<SshJiveKey>> =>
  e.Effect.gen(function*() {
    const { hostShell, ssh, yubiKey } = dependencies;

    const hasYkman = yield* hostShell.hasCommand("ykman");
    if (!hasYkman) {
      yield* e.Effect.logError("YubiKey mode requires `ykman` on PATH.");
      return e.Option.none<SshJiveKey>();
    }

    if (!(yield* ssh.ensureResidentSshSupport)) return e.Option.none<SshJiveKey>();

    const devices = yield* yubiKey.listConnectedDevices;
    if (devices.length === 0) {
      yield* e.Effect.logError("No YubiKeys were detected. Insert one and try again.");
      return e.Option.none<SshJiveKey>();
    }

    const selectedDevice = yield* selectConnectedYubiKey(devices);
    if (e.Option.isNone(selectedDevice)) return e.Option.none<SshJiveKey>();

    const pinConfigured = yield* yubiKey.ensurePinConfigured(selectedDevice.value.serial);
    if (!pinConfigured) return e.Option.none<SshJiveKey>();

    return yield* ssh.selectOrCreateYubiKeySshKey(
      workspaceRoot,
      selectedDevice.value.serial,
      email,
    );
  });

const selectKeySource = (): e.Effect.Effect<e.Option.Option<"local" | "yubikey">> =>
  selectOne(
    "Choose the SSH key source Jive should use:",
    [
      { id: "local" as const, label: "Local key stored in this workspace" },
      { id: "yubikey" as const, label: "Resident key stored on a YubiKey" },
    ],
    (option) => option.id,
    (option, index) => `${index + 1}. ${option.label}`,
  ).pipe(
    e.Effect.map((selected) => e.Option.map(selected, (option) => option.id)),
  );

const selectConnectedYubiKey = (
  devices: readonly ConnectedYubiKey[],
): e.Effect.Effect<e.Option.Option<ConnectedYubiKey>> =>
  selectOne(
    "Select the YubiKey Jive should use:",
    [...devices],
    (device) => device.serial,
    (device, index) => `${index + 1}. ${device.label} (${device.serial})`,
  );

const acquireWriteSession = (
  dependencies: AuthServiceDependencies,
  expectedCredentials: e.Option.Option<Credentials>,
): e.Effect.Effect<e.Option.Option<WriteSessionResult>> =>
  e.Effect.gen(function*() {
    const { github } = dependencies;

    if (e.Option.isSome(expectedCredentials) && expectedCredentials.value.writeRefreshToken) {
      const refreshed = yield* github.renewWriteTokenFromRefresh(expectedCredentials.value.writeRefreshToken);
      if (e.Option.isSome(refreshed) && github.isWriteCapableScope(refreshed.value.tokenScope)) {
        if (!matchesExpectedAccount(expectedCredentials, refreshed.value)) {
          yield* e.Effect.logError(
            `Refreshed write token belongs to @${refreshed.value.username}, expected @${expectedCredentials.value.githubUsername || "unknown"}. Run \`${TOOL_NAME} login\` to switch users.`,
          );
          return e.Option.none<WriteSessionResult>();
        }

        return e.Option.some({
          session: refreshed.value,
          continueInBrowser: e.Option.none(),
        });
      }
    }

    const writeLogin = github.beginWriteLogin();
    const session = yield* writeLogin.waitForSession;
    if (e.Option.isNone(session)) return e.Option.none<WriteSessionResult>();

    if (!matchesExpectedAccount(expectedCredentials, session.value)) {
      yield* e.Effect.logError(
        `Signed in to @${session.value.username}, but the current user belongs to @${e.Option.isSome(expectedCredentials) ? expectedCredentials.value.githubUsername || "unknown" : "unknown"}. Run \`${TOOL_NAME} login\` to switch users.`,
      );
      return e.Option.none<WriteSessionResult>();
    }

    return e.Option.some({
      session: session.value,
      continueInBrowser: e.Option.some(writeLogin.continueInBrowser),
    });
  });

const createReusableWriteSessionAcquirer = (
  dependencies: AuthServiceDependencies,
  initialSession: e.Option.Option<GitHubSession>,
): AcquireReusableWriteSession => {
  let cachedSession = initialSession;

  return (expectedCredentials) =>
    e.Effect.gen(function*() {
      if (e.Option.isSome(cachedSession) && matchesExpectedAccount(expectedCredentials, cachedSession.value)) {
        return cachedSession;
      }

      const acquired = yield* acquireWriteSession(dependencies, expectedCredentials);
      if (e.Option.isNone(acquired)) return e.Option.none<GitHubSession>();

      cachedSession = e.Option.some(acquired.value.session);
      return cachedSession;
    });
};

const persistSelectedAuthState = (
  toolState: ToolStateApi,
  currentUser: CurrentUserState,
  credentials: Credentials,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* toolState.writeCurrentUserState(currentUser);
    yield* saveUserTokenState(toolState, {
      email: currentUser.email,
      gitUserName: credentials.gitUserName,
      githubAccountId: credentials.githubAccountId,
      githubUsername: credentials.githubUsername,
      sshKeySource: credentials.sshKeySource,
      sshKeyFingerprint: credentials.sshKeyFingerprint,
      sshKeyName: credentials.sshKeyName,
      sshKeyPath: credentials.sshKeyPath,
      yubiKeySerial: credentials.yubiKeySerial,
      readOnlyToken: credentials.readOnlyToken,
      readOnlyTokenScope: credentials.readOnlyTokenScope,
      readOnlyTokenType: credentials.readOnlyTokenType,
      writeRefreshToken: credentials.writeRefreshToken,
    });
  });

const acquireReadOnlySession = (
  github: GitHubService,
  writeSession: GitHubSession,
  continueWriteBrowser: e.Option.Option<(action: OAuthBrowserAction) => void>,
): e.Effect.Effect<e.Option.Option<ReadOnlyLoginResult>> =>
  e.Effect.gen(function*() {
    const readLogin = github.beginReadOnlyLogin({ openBrowser: e.Option.isNone(continueWriteBrowser) });
    if (e.Option.isSome(continueWriteBrowser)) {
      yield* e.Effect.log("Continuing in browser for explicit read-token login...");
      continueWriteBrowser.value(redirectOAuthBrowserAction(readLogin.authorizeUrl.toString()));
    }

    const readSession = yield* readLogin.waitForSession;
    if (e.Option.isNone(readSession)) return e.Option.none<ReadOnlyLoginResult>();

    if (!sameGitHubAccount(writeSession, readSession.value)) {
      readLogin.continueInBrowser(displayOAuthBrowserAction(
        "GitHub authorization failed",
        `Read-token login returned @${readSession.value.username}, expected @${writeSession.username}. You may close this tab now.`,
      ));
      yield* e.Effect.logError(
        `Read-token login returned @${readSession.value.username}, expected @${writeSession.username}.`,
      );
      return e.Option.none<ReadOnlyLoginResult>();
    }

    const verifiedEmails = yield* github.getVerifiedEmails(readSession.value.token);

    yield* e.Effect.log(`Read-token login scope: ${readSession.value.tokenScope || "(none reported)"}`);
    if (!github.isReadScopeSatisfied(readSession.value.tokenScope)) {
      yield* e.Effect.logWarning(
        `Read token is missing the expected scope set: ${readSession.value.tokenScope || "(none reported)"}.`,
      );
    }
    if (github.isWriteCapableScope(readSession.value.tokenScope)) {
      yield* e.Effect.logWarning("Read-token login still includes key-write scopes on GitHub.");
    }

    readLogin.continueInBrowser(displayAutoClosingOAuthBrowserAction(
      "GitHub authorization complete",
      formatCompletedAuthorizationBody(readSession.value.username, verifiedEmails),
    ));

    return e.Option.some({
      session: readSession.value,
      verifiedEmails,
    });
  });

function buildCredentials(
  email: string,
  writeSession: GitHubSession,
  readSession: GitHubSession,
  sshKey: SshJiveKey,
): Credentials {
  return {
    email,
    gitUserName: writeSession.name || readSession.name || email,
    githubAccountId: writeSession.accountId,
    githubUsername: writeSession.username,
    readOnlyToken: readSession.token,
    readOnlyTokenScope: readSession.tokenScope,
    readOnlyTokenType: readSession.tokenType,
    sshKeySource: sshKey.source,
    sshKeyFingerprint: sshKey.fingerprint,
    sshKeyName: sshKey.name,
    sshKeyPath: sshKey.relativePrivateKeyPath,
    yubiKeySerial: sshKey.yubiKeySerial,
    writeRefreshToken: writeSession.refreshToken,
  };
}

const printKeyNamingConvention = (credentials: Credentials): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log(`Jive auth key name: ${authKeyName(credentials.email, credentials.sshKeyName, credentials.sshKeyFingerprint)}`);
    yield* e.Effect.log(`Jive SSH signing key name: ${signingKeyName(credentials.email, credentials.sshKeyName, credentials.sshKeyFingerprint)}`);
  });

function hasGitHubAuthKey(
  inventory: GitHubJiveKeyInventory,
  keyName: string,
  publicKey: string,
): boolean {
  const normalizedKeyBody = normalizeKeyBody(publicKey);
  return inventory.auth.some((entry) =>
    entry.title === keyName && normalizeKeyBody(entry.key) === normalizedKeyBody
  );
}

function hasGitHubSigningKey(
  inventory: GitHubJiveKeyInventory,
  keyName: string,
  publicKey: string,
): boolean {
  const normalizedKeyBody = normalizeKeyBody(publicKey);
  return inventory.signing.some((entry) =>
    entry.title === keyName && normalizeKeyBody(entry.key) === normalizedKeyBody
  );
}

function normalizeKeyBody(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key.trim();
  return `${parts[0]} ${parts[1]}`;
}

function matchesExpectedAccount(
  expectedCredentials: e.Option.Option<Credentials>,
  session: GitHubSession,
): boolean {
  if (e.Option.isNone(expectedCredentials)) return true;

  const expected = expectedCredentials.value;
  if (expected.githubAccountId > 0 && session.accountId > 0) {
    return expected.githubAccountId === session.accountId;
  }

  if (!expected.githubUsername.trim()) return true;
  return expected.githubUsername.trim().toLowerCase() === session.username.trim().toLowerCase();
}

function sameGitHubAccount(left: GitHubSession, right: GitHubSession): boolean {
  if (left.accountId > 0 && right.accountId > 0) {
    return left.accountId === right.accountId;
  }

  return left.username.trim().toLowerCase() === right.username.trim().toLowerCase();
}

function formatCompletedAuthorizationBody(username: string, verifiedEmails: readonly string[]): string {
  const lines = [
    `Write and read tokens obtained for @${username}.`,
    "",
    "Verified emails:",
    ...(verifiedEmails.length > 0 ? verifiedEmails.map((email) => `- ${email}`) : ["- (none reported)"]),
    "",
    "You may close this tab now.",
  ];

  return lines.join("\n");
}

function mergeCredentialsWithWriteSession(credentials: Credentials, session: GitHubSession): Credentials {
  return {
    ...credentials,
    gitUserName: session.name || credentials.gitUserName,
    githubAccountId: session.accountId || credentials.githubAccountId,
    githubUsername: session.username || credentials.githubUsername,
    writeRefreshToken: session.refreshToken || credentials.writeRefreshToken,
  };
}

function mergeCredentialsWithSshKey(credentials: Credentials, sshKey: SshJiveKey): Credentials {
  return {
    ...credentials,
    sshKeySource: sshKey.source,
    sshKeyFingerprint: sshKey.fingerprint,
    sshKeyName: sshKey.name,
    sshKeyPath: sshKey.relativePrivateKeyPath,
    yubiKeySerial: sshKey.yubiKeySerial,
  };
}

function upsertGitHubKeys(
  inventory: GitHubJiveKeyInventory,
  authName: string,
  signingName: string,
  publicKey: string,
): GitHubJiveKeyInventory {
  const nextAuth = replaceNamedKey(inventory.auth, authName, publicKey);
  const nextSigning = replaceNamedKey(inventory.signing, signingName, publicKey);

  return {
    auth: nextAuth,
    signing: nextSigning,
  };
}

function replaceNamedKey(
  existing: readonly GitHubUserKey[],
  title: string,
  key: string,
): GitHubUserKey[] {
  const next = existing.filter((entry) => entry.title !== title);
  next.push({
    id: 0,
    title,
    key,
  });
  return next;
}
