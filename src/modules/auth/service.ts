import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import { authKeyName, signingKeyName } from "./constants";
import {
  getReadOnlyAuthKeyPaths,
  loadCredentials,
  saveCredentials,
  saveUserTokenState,
  type ToolStateApi,
} from "./credentials";
import type { AuthHostShell } from "./host-shell";
import {
  printGitHubJiveKeyList,
  printYubiKeyList,
  selectConnectedYubiKey,
  selectOrCreateJiveKey,
  selectVerifiedEmail,
} from "./key-selection";
import { createReadOnlyAuthKey, loadReadOnlyAuthKey } from "./local-auth-key";
import {
  displayAutoClosingOAuthBrowserAction,
  displayOAuthBrowserAction,
  redirectOAuthBrowserAction,
  type OAuthBrowserAction,
} from "./oauth";
import { promptYesNo } from "./prompts";
import type { ConnectedYubiKeyDevice, Credentials, GitHubJiveKeyInventory, GitHubSession, LocalAuthKey, YubiKeyJiveKey } from "./types";
import type { GitService } from "../git/interface";
import type { GitHubService } from "../github/interface";
import { WORKSPACE_DIR } from "../tool-state/constants";
import type { CurrentUserState } from "../tool-state/interface";

interface AuthServiceDependencies {
  readonly toolState: ToolStateApi;
  readonly git: GitService;
  readonly github: GitHubService;
  readonly hostShell: AuthHostShell;
  readonly yubiKey: YubiKeyApi;
}

interface YubiKeyApi {
  readonly listConnectedDevices: e.Effect.Effect<e.Option.Option<ConnectedYubiKeyDevice[]>>;
  readonly listResidentJiveKeys: e.Effect.Effect<e.Option.Option<YubiKeyJiveKey[]>>;
  readonly createResidentJiveKey: (name: string) => e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>>;
  readonly loadResidentJiveKeyIntoAgent: (target: YubiKeyJiveKey) => e.Effect.Effect<void>;
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
  readonly githubJiveKeys: GitHubJiveKeyInventory;
  readonly reusableWriteSession: e.Option.Option<GitHubSession>;
}

interface EnsuredReadOnlyMaterial {
  readonly credentials: Credentials;
  readonly githubJiveKeys: GitHubJiveKeyInventory;
}

interface EnsuredSigningMaterial {
  readonly credentials: Credentials;
  readonly signingKey: e.Option.Option<YubiKeyJiveKey>;
}

interface ExistingReadState {
  readonly credentials: Credentials;
  readonly githubJiveKeys: GitHubJiveKeyInventory;
}

type AcquireReusableWriteSession = (
  expectedCredentials: e.Option.Option<Credentials>,
) => e.Effect.Effect<e.Option.Option<GitHubSession>>;

export const login = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* dependencies.toolState.clearCurrentUserState;
    yield* runLoginFlow(dependencies, "Logged in as");
  });

export const ensureLoggedIn = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<void> => runLoginFlow(dependencies, "Ensured login for");

const runLoginFlow = (
  dependencies: AuthServiceDependencies,
  successPrefix: string,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const prepared = yield* prepareExistingOrFreshAuthState(dependencies);
    if (e.Option.isNone(prepared)) return;

    const acquireReusableWriteSession = createReusableWriteSessionAcquirer(
      dependencies,
      prepared.value.reusableWriteSession,
    );

    const ensuredReadOnly = yield* ensureReadOnlyAuthMaterial(
      dependencies,
      prepared.value,
      acquireReusableWriteSession,
    );
    if (e.Option.isNone(ensuredReadOnly)) return;

    yield* finalizeReadOnlyAuthState(dependencies, prepared.value.root, prepared.value.currentUser, ensuredReadOnly.value);

    const ensuredSigning = yield* ensureSigningMaterial(
      dependencies,
      prepared.value.currentUser,
      ensuredReadOnly.value,
      acquireReusableWriteSession,
    );
    yield* finalizeSigningAuthState(dependencies, prepared.value.root, ensuredSigning);
    yield* logSigningStatus(ensuredSigning.signingKey);
    yield* e.Effect.log(`${successPrefix} @${ensuredSigning.credentials.githubUsername} (${prepared.value.currentUser.email})`);
  });

export const whoami = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const { git, github, toolState } = dependencies;
    const root = toolState.workspaceRoot;
    if (e.Option.isNone(root)) {
      yield* e.Effect.logError(`You're not in a ${TOOL_NAME} workspace.`);
      return;
    }

    const credentials = yield* loadCredentials(toolState);
    if (e.Option.isNone(credentials)) {
      yield* e.Effect.logError(`Not logged in. Run \`${TOOL_NAME} login\` first.`);
      return;
    }

    yield* e.Effect.log(credentials.value.email);
    yield* github.checkWorkspaceRepoAccess(root.value, credentials.value.readOnlyToken, git);
  });

const prepareFreshLoginState = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<e.Option.Option<PreparedAuthState>> =>
  e.Effect.gen(function*() {
    const { github, toolState, yubiKey } = dependencies;
    const root = yield* requireWorkspaceRoot(toolState);
    if (e.Option.isNone(root)) return e.Option.none<PreparedAuthState>();
    if (!(yield* ensureGitHubOAuthConfigured(github))) return e.Option.none<PreparedAuthState>();

    const selectedYubiKey = yield* resolveSelectedYubiKey(yubiKey, e.Option.none());
    if (e.Option.isNone(selectedYubiKey)) return e.Option.none<PreparedAuthState>();

    const writeLogin = github.beginWriteLogin();
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
      yield* e.Effect.logError("Could not list existing jive keys on GitHub with the read token.");
      return e.Option.none<PreparedAuthState>();
    }

    yield* printGitHubJiveKeyList(githubJiveKeys.value.auth, githubJiveKeys.value.signing);

    const selectedEmail = yield* selectVerifiedEmail({
      verifiedEmails: Array.from(readOnlyLogin.value.verifiedEmails),
      discoveredEmail: readOnlyLogin.value.session.discoveredEmail,
    });
    if (e.Option.isNone(selectedEmail)) return e.Option.none<PreparedAuthState>();

    const currentUser: CurrentUserState = {
      email: selectedEmail.value,
      yubiKeyId: selectedYubiKey.value.id,
      yubiKeyLabel: selectedYubiKey.value.label,
    };
    yield* printKeyNamingConvention(currentUser);

    const credentials = buildCredentials(
      root.value,
      currentUser.email,
      writeSession.value,
      readOnlyLogin.value.session,
    );
    yield* persistSelectedAuthState(toolState, currentUser, credentials);

    return e.Option.some({
      root: root.value,
      currentUser,
      credentials,
      githubJiveKeys: githubJiveKeys.value,
      reusableWriteSession: e.Option.some(writeSession.value),
    });
  });

const prepareExistingOrFreshAuthState = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<e.Option.Option<PreparedAuthState>> =>
  e.Effect.gen(function*() {
    const { github, toolState, yubiKey } = dependencies;
    const root = yield* requireWorkspaceRoot(toolState);
    if (e.Option.isNone(root)) return e.Option.none<PreparedAuthState>();
    if (!(yield* ensureGitHubOAuthConfigured(github))) return e.Option.none<PreparedAuthState>();

    const currentUserState = yield* toolState.readCurrentUserState;
    if (e.Option.isNone(currentUserState)) {
      return yield* prepareFreshLoginState(dependencies);
    }

    const selectedYubiKey = yield* resolveSelectedYubiKey(yubiKey, currentUserState);
    if (e.Option.isNone(selectedYubiKey)) return e.Option.none<PreparedAuthState>();

    const currentUser: CurrentUserState = {
      email: currentUserState.value.email,
      yubiKeyId: selectedYubiKey.value.id,
      yubiKeyLabel: selectedYubiKey.value.label,
    };

    const existingReadState = yield* loadExistingReadState(github, toolState, currentUser.email);
    if (e.Option.isSome(existingReadState)) {
      yield* toolState.writeCurrentUserState(currentUser);
      yield* printKeyNamingConvention(currentUser);
      return e.Option.some({
        root: root.value,
        currentUser,
        credentials: existingReadState.value.credentials,
        githubJiveKeys: existingReadState.value.githubJiveKeys,
        reusableWriteSession: e.Option.none(),
      });
    }

    return yield* reacquirePreparedAuthState(
      dependencies,
      root.value,
      currentUser,
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
      yield* e.Effect.logError("Could not list existing jive keys on GitHub with the refreshed read token.");
      return e.Option.none<PreparedAuthState>();
    }

    const credentials = buildCredentials(
      root,
      currentUser.email,
      writeSession.value.session,
      readOnlyLogin.value.session,
    );
    yield* persistSelectedAuthState(toolState, currentUser, credentials);
    yield* printKeyNamingConvention(currentUser);

    return e.Option.some({
      root,
      currentUser,
      credentials,
      githubJiveKeys: githubJiveKeys.value,
      reusableWriteSession: e.Option.some(writeSession.value.session),
    });
  });

const ensureReadOnlyAuthMaterial = (
  dependencies: AuthServiceDependencies,
  prepared: PreparedAuthState,
  acquireReusableWriteSession: AcquireReusableWriteSession,
): e.Effect.Effect<e.Option.Option<EnsuredReadOnlyMaterial>> =>
  e.Effect.gen(function*() {
    const { currentUser, credentials, githubJiveKeys } = prepared;
    const { github, hostShell, toolState } = dependencies;

    const authKeyPaths = getReadOnlyAuthKeyPaths(toolState.workspaceRoot, currentUser.email);
    const localAuthKey = yield* ensureLocalAuthKey(
      hostShell,
      authKeyPaths.privateKeyPath,
      authKeyPaths.publicKeyPath,
      currentUser.email,
    );
    if (e.Option.isNone(localAuthKey)) return e.Option.none<EnsuredReadOnlyMaterial>();

    const needsAuthRepair = !hasGitHubAuthKey(githubJiveKeys, localAuthKey.value);

    let nextCredentials: Credentials = {
      ...credentials,
      readOnlyAuthPrivateKeyPath: localAuthKey.value.privateKeyPath,
      readOnlyAuthPublicKeyPath: localAuthKey.value.publicKeyPath,
    };
    let nextGitHubJiveKeys = githubJiveKeys;

    if (needsAuthRepair) {
      const writeSession = yield* acquireReusableWriteSession(e.Option.some(nextCredentials));
      if (e.Option.isNone(writeSession)) return e.Option.none<EnsuredReadOnlyMaterial>();

      nextCredentials = mergeCredentialsWithWriteSession(nextCredentials, writeSession.value);
      yield* github.ensureAuthKey(
        writeSession.value.token,
        localAuthKey.value.name,
        localAuthKey.value.publicKey,
        e.Option.some(githubJiveKeys),
      );

      const refreshedInventory = yield* github.listJiveKeys(nextCredentials.readOnlyToken);
      nextGitHubJiveKeys = e.Option.getOrElse(
        refreshedInventory,
        () => upsertGitHubAuthKey(githubJiveKeys, localAuthKey.value),
      );
    }

    return e.Option.some({
      credentials: nextCredentials,
      githubJiveKeys: nextGitHubJiveKeys,
    } satisfies EnsuredReadOnlyMaterial);
  });

const finalizeReadOnlyAuthState = (
  dependencies: AuthServiceDependencies,
  root: string,
  currentUser: CurrentUserState,
  ensured: EnsuredReadOnlyMaterial,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const { git, github, toolState } = dependencies;
    yield* toolState.writeCurrentUserState(currentUser);
    yield* saveCredentials(toolState, ensured.credentials);
    yield* applyStoredIdentityToWorkspace(root, ensured.credentials, e.Option.none(), git);
    yield* github.checkWorkspaceRepoAccess(root, ensured.credentials.readOnlyToken, git);
  });

const ensureSigningMaterial = (
  dependencies: AuthServiceDependencies,
  currentUser: CurrentUserState,
  ensuredReadOnly: EnsuredReadOnlyMaterial,
  acquireReusableWriteSession: AcquireReusableWriteSession,
): e.Effect.Effect<EnsuredSigningMaterial> =>
  e.Effect.gen(function*() {
    const { github, yubiKey } = dependencies;
    const residentKeys = yield* loadResidentSigningKeys(yubiKey);
    if (e.Option.isNone(residentKeys)) {
      yield* e.Effect.logWarning("Skipping Jive signing-key setup because resident YubiKey keys could not be inspected.");
      return {
        credentials: ensuredReadOnly.credentials,
        signingKey: e.Option.none(),
      } satisfies EnsuredSigningMaterial;
    }

    yield* printYubiKeyList(residentKeys.value);
    yield* printGitHubJiveKeyList(ensuredReadOnly.githubJiveKeys.auth, ensuredReadOnly.githubJiveKeys.signing);

    const selectedSigningKey = yield* selectOrCreateJiveKey({
      yubiKeys: residentKeys.value,
      githubJiveKeys: e.Option.some(ensuredReadOnly.githubJiveKeys),
      selectedEmail: currentUser.email,
      selectedYubiKeyId: currentUser.yubiKeyId,
      createResidentJiveKey: yubiKey.createResidentJiveKey,
    });
    if (e.Option.isNone(selectedSigningKey)) {
      return {
        credentials: ensuredReadOnly.credentials,
        signingKey: e.Option.none(),
      } satisfies EnsuredSigningMaterial;
    }

    let nextCredentials = ensuredReadOnly.credentials;
    const needsSigningRepair = !hasGitHubSigningKey(ensuredReadOnly.githubJiveKeys, selectedSigningKey.value);

    if (needsSigningRepair) {
      const writeSession = yield* acquireReusableWriteSession(e.Option.some(nextCredentials));
      if (e.Option.isNone(writeSession)) {
        yield* e.Effect.logWarning("Skipping GitHub signing-key registration because a write-capable session could not be acquired.");
        return {
          credentials: nextCredentials,
          signingKey: e.Option.none(),
        } satisfies EnsuredSigningMaterial;
      }

      nextCredentials = mergeCredentialsWithWriteSession(nextCredentials, writeSession.value);
      yield* github.ensureSigningJiveKey(
        writeSession.value.token,
        selectedSigningKey.value,
        e.Option.some(ensuredReadOnly.githubJiveKeys),
      );
    }

    yield* yubiKey.loadResidentJiveKeyIntoAgent(selectedSigningKey.value);

    return {
      credentials: nextCredentials,
      signingKey: e.Option.some(selectedSigningKey.value),
    } satisfies EnsuredSigningMaterial;
  });

const finalizeSigningAuthState = (
  dependencies: AuthServiceDependencies,
  root: string,
  ensured: EnsuredSigningMaterial,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const { git, toolState } = dependencies;
    yield* saveCredentials(toolState, ensured.credentials);

    if (e.Option.isSome(ensured.signingKey)) {
      yield* applyStoredIdentityToWorkspace(
        root,
        ensured.credentials,
        e.Option.some(ensured.signingKey.value.publicKey),
        git,
      );
    }
  });

const applyStoredIdentityToWorkspace = (
  root: string,
  credentials: Credentials,
  signingPublicKey: e.Option.Option<string>,
  git: GitService,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    void root;
    const orgs = yield* git.localOrgs;
    for (const org of orgs) {
      const repos = yield* git.localRepos(org);
      for (const repo of repos) {
        const configured = yield* git.configureRepoRemoteAndUser(org, repo, {
          userName: credentials.gitUserName || credentials.email,
          userEmail: credentials.email,
          authPrivateKeyPath: credentials.readOnlyAuthPrivateKeyPath,
          signingPublicKey: e.Option.getOrElse(signingPublicKey, () => undefined),
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

const resolveSelectedYubiKey = (
  yubiKey: YubiKeyApi,
  currentUserState: e.Option.Option<CurrentUserState>,
): e.Effect.Effect<e.Option.Option<ConnectedYubiKeyDevice>> =>
  e.Effect.gen(function*() {
    const connectedYubiKeys = yield* yubiKey.listConnectedDevices;
    if (e.Option.isNone(connectedYubiKeys) || connectedYubiKeys.value.length === 0) {
      yield* e.Effect.logError("No YubiKey detected. Please connect one before running login.");
      return e.Option.none<ConnectedYubiKeyDevice>();
    }

    if (connectedYubiKeys.value.length > 1) {
      yield* e.Effect.logWarning(
        "Jive cannot yet inspect or target resident keys per YubiKey independently; OpenSSH will still operate on the device you touch.",
      );
    }

    if (e.Option.isSome(currentUserState)) {
      const matching = connectedYubiKeys.value.find((device) => device.id === currentUserState.value.yubiKeyId);
      if (matching) {
        yield* e.Effect.log(`Using connected YubiKey: ${formatConnectedYubiKey(matching)}`);
        return e.Option.some(matching);
      }

      yield* e.Effect.logWarning(
        `Previously selected YubiKey is not connected: ${currentUserState.value.yubiKeyLabel} (${currentUserState.value.yubiKeyId}).`,
      );

      const useDifferent = yield* promptYesNo(
        connectedYubiKeys.value.length === 1
          ? `Use ${connectedYubiKeys.value[0]!.label} instead?`
          : "Use a different connected YubiKey instead?",
      );
      if (!useDifferent) return e.Option.none<ConnectedYubiKeyDevice>();
    }

    const selected = yield* selectConnectedYubiKey(connectedYubiKeys.value);
    if (e.Option.isSome(selected)) {
      yield* e.Effect.log(`Using connected YubiKey: ${formatConnectedYubiKey(selected.value)}`);
      return e.Option.some(selected.value);
    }
    return e.Option.none<ConnectedYubiKeyDevice>();
  });

const loadResidentSigningKeys = (
  yubiKey: YubiKeyApi,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey[]>> =>
  e.Effect.gen(function*() {
    const residentKeys = yield* yubiKey.listResidentJiveKeys;
    if (e.Option.isNone(residentKeys)) {
      yield* e.Effect.logWarning("Could not inspect resident Jive signing keys on the connected YubiKey.");
      return e.Option.none<YubiKeyJiveKey[]>();
    }
    return residentKeys;
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
      readOnlyToken: credentials.readOnlyToken,
      readOnlyTokenScope: credentials.readOnlyTokenScope,
      readOnlyTokenType: credentials.readOnlyTokenType,
      writeRefreshToken: credentials.writeRefreshToken,
    });
  });

const ensureLocalAuthKey = (
  hostShell: AuthHostShell,
  privateKeyPath: string,
  publicKeyPath: string,
  email: string,
): e.Effect.Effect<e.Option.Option<LocalAuthKey>> =>
  e.Effect.gen(function*() {
    const existing = yield* loadReadOnlyAuthKey(privateKeyPath, publicKeyPath);
    if (e.Option.isSome(existing)) return existing;

    yield* e.Effect.log(`Creating local read-only GitHub auth SSH key: ${authKeyName(email)}`);
    return yield* createReadOnlyAuthKey(hostShell, privateKeyPath, publicKeyPath, email);
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
    } satisfies ReadOnlyLoginResult);
  });

function buildCredentials(
  workspaceRoot: string,
  email: string,
  writeSession: GitHubSession,
  readSession: GitHubSession,
): Credentials {
  const authKeyPaths = getReadOnlyAuthKeyPaths(e.Option.some(workspaceRoot), email);
  return {
    email,
    gitUserName: writeSession.name,
    githubAccountId: writeSession.accountId,
    githubUsername: writeSession.username,
    readOnlyToken: readSession.token,
    readOnlyTokenScope: readSession.tokenScope,
    readOnlyTokenType: readSession.tokenType,
    readOnlyAuthPrivateKeyPath: authKeyPaths.privateKeyPath,
    readOnlyAuthPublicKeyPath: authKeyPaths.publicKeyPath,
    writeRefreshToken: writeSession.refreshToken,
  };
}

const printKeyNamingConvention = (currentUser: CurrentUserState): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log(`Jive auth key name: ${authKeyName(currentUser.email)}`);
    yield* e.Effect.log(`Jive signing key name: ${signingKeyName(currentUser.email, currentUser.yubiKeyId)}`);
  });

function hasGitHubAuthKey(
  inventory: GitHubJiveKeyInventory,
  localAuthKey: LocalAuthKey,
): boolean {
  return inventory.auth.some((entry) =>
    entry.title === localAuthKey.name && normalizeKeyBody(entry.key) === localAuthKey.keyBody
  );
}

function hasGitHubSigningKey(
  inventory: GitHubJiveKeyInventory,
  signingKey: YubiKeyJiveKey,
): boolean {
  return inventory.signing.some((entry) =>
    entry.title === signingKey.name && normalizeKeyBody(entry.key) === signingKey.keyBody
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

const logSigningStatus = (
  signingKey: e.Option.Option<YubiKeyJiveKey>,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    if (e.Option.isNone(signingKey)) {
      yield* e.Effect.logWarning("Read-only GitHub auth is ready, but Jive signing-key setup is still incomplete.");
    }
  });

function formatConnectedYubiKey(device: ConnectedYubiKeyDevice): string {
  return `${device.id} (${device.label})`;
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

function upsertGitHubAuthKey(
  inventory: GitHubJiveKeyInventory,
  localAuthKey: LocalAuthKey,
): GitHubJiveKeyInventory {
  const nextAuth = inventory.auth.filter((entry) => entry.title !== localAuthKey.name);
  nextAuth.push({
    id: 0,
    key: localAuthKey.publicKey,
    title: localAuthKey.name,
  });

  return {
    auth: nextAuth,
    signing: inventory.signing,
  };
}
