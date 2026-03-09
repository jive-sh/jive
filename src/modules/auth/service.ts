import * as e from "effect";
import {
  applyGitHubIdentityToWorkspace,
  beginGitHubReadOnlyLogin,
  beginGitHubWriteLogin,
  checkWorkspaceRepoAccess,
  ensureGitHubAuthKey,
  ensureGitHubSigningJiveKey,
  getVerifiedGitHubEmails,
  isReadScopeSatisfied,
  isWriteCapableScope,
  isGitHubOAuthConfigured,
  listGitHubJiveKeys,
  renewWriteTokenFromRefresh,
  type GitApi,
} from "@/modules/auth/github";
import {
  getReadOnlyAuthKeyPaths,
  loadCredentials,
  saveCredentials,
  saveUserTokenState,
  type ToolStateApi,
} from "@/modules/auth/credentials";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import { printGitHubJiveKeyList, printYubiKeyList, selectOrCreateJiveKey, selectVerifiedEmail } from "@/modules/auth/key-selection";
import { createReadOnlyAuthKey } from "@/modules/auth/local-auth-key";
import {
  displayAutoClosingOAuthBrowserAction,
  displayOAuthBrowserAction,
  redirectOAuthBrowserAction,
  type OAuthBrowserAction,
} from "@/modules/auth/oauth";
import { GITHUB_KEY_PREFIX } from "@/modules/auth/constants";
import type { ConnectedYubiKeyDevice, Credentials, GitHubSession, YubiKeyJiveKey } from "@/modules/auth/types";
import { WORKSPACE_DIR } from "@/modules/tool-state/constants";
import { TOOL_NAME } from "@/constants";

interface AuthServiceDependencies {
  readonly toolState: ToolStateApi;
  readonly git: GitApi;
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

export const login = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const { git, hostShell, toolState, yubiKey } = dependencies;
    const root = toolState.workspaceRoot;
    if (e.Option.isNone(root)) {
      yield* e.Effect.logError(`No ${WORKSPACE_DIR} workspace found. Run \`${TOOL_NAME} init\` first.`);
      return;
    }

    if (!isGitHubOAuthConfigured()) {
      yield* e.Effect.logError(`${TOOL_NAME} has no GitHub OAuth App configured yet.`);
      yield* e.Effect.logError(
        "Register one at https://github.com/settings/developers and set CLIENT_ID/CLIENT_SECRET in src/modules/auth/github.ts.",
      );
      return;
    }

    const connectedYubiKeys = yield* yubiKey.listConnectedDevices;
    if (e.Option.isNone(connectedYubiKeys) || connectedYubiKeys.value.length === 0) {
      yield* e.Effect.logError("No YubiKey detected. Please connect one before running login.");
      return;
    }

    if (connectedYubiKeys.value.length === 1) {
      yield* e.Effect.log(`Connected YubiKey: ${connectedYubiKeys.value[0]!.label}`);
    } else {
      yield* e.Effect.log("Connected YubiKeys:");
      for (const device of connectedYubiKeys.value) {
        yield* e.Effect.log(`- ${device.label}`);
      }
    }

    if (connectedYubiKeys.value.length > 1) {
      yield* e.Effect.logWarning("Multiple YubiKeys detected. Continuing with the device OpenSSH selects.");
    }

    const writeLogin = beginGitHubWriteLogin(hostShell);
    const writeSession = yield* writeLogin.waitForSession;
    if (e.Option.isNone(writeSession)) return;

    const readOnlyLogin = yield* acquireReadOnlySession(hostShell, writeSession.value, writeLogin.continueInBrowser);
    if (e.Option.isNone(readOnlyLogin)) return;

    const readSession = readOnlyLogin.value.session;
    const verifiedEmails = Array.from(readOnlyLogin.value.verifiedEmails);

    const yubiKeys = yield* yubiKey.listResidentJiveKeys;
    if (e.Option.isNone(yubiKeys)) {
      yield* e.Effect.logError("No YubiKey detected. Please connect one before running login.");
      return;
    }

    const githubJiveKeys = yield* listGitHubJiveKeys(writeSession.value.token);

    yield* e.Effect.log(`Jive key naming convention: ${GITHUB_KEY_PREFIX}<email>`);
    yield* printYubiKeyList(yubiKeys.value);
    if (e.Option.isSome(githubJiveKeys)) {
      yield* printGitHubJiveKeyList(githubJiveKeys.value.auth, githubJiveKeys.value.signing);
    } else {
      yield* e.Effect.logError("Could not list existing jive keys on GitHub.");
    }

    const selectedEmail = yield* selectVerifiedEmail({
      verifiedEmails,
      discoveredEmail: readSession.discoveredEmail,
    });
    if (e.Option.isNone(selectedEmail)) return;
    yield* e.Effect.log(`Using verified email: ${selectedEmail.value}`);

    yield* saveUserTokenState(toolState, {
      email: selectedEmail.value,
      gitUserName: writeSession.value.name,
      githubAccountId: writeSession.value.accountId,
      githubUsername: writeSession.value.username,
      readOnlyToken: readSession.token,
      readOnlyTokenScope: readSession.tokenScope,
      readOnlyTokenType: readSession.tokenType,
      writeRefreshToken: writeSession.value.refreshToken,
    });

    const selectedKey = yield* selectOrCreateJiveKey({
      yubiKeys: yubiKeys.value,
      githubJiveKeys,
      selectedEmail: selectedEmail.value,
      createResidentJiveKey: yubiKey.createResidentJiveKey,
    });
    if (e.Option.isNone(selectedKey)) return;

    const authKeyPaths = getReadOnlyAuthKeyPaths(toolState.workspaceRoot, selectedEmail.value);
    yield* e.Effect.log(`Creating local read-only auth key: ${GITHUB_KEY_PREFIX}${selectedEmail.value}`);
    const localReadOnlyAuthKey = yield* createReadOnlyAuthKey(
      hostShell,
      authKeyPaths.privateKeyPath,
      authKeyPaths.publicKeyPath,
      selectedEmail.value,
    );
    if (e.Option.isNone(localReadOnlyAuthKey)) return;

    yield* ensureGitHubSigningJiveKey(writeSession.value.token, selectedKey.value, githubJiveKeys);
    yield* ensureGitHubAuthKey(
      writeSession.value.token,
      localReadOnlyAuthKey.value.name,
      localReadOnlyAuthKey.value.publicKey,
      githubJiveKeys,
    );
    yield* yubiKey.loadResidentJiveKeyIntoAgent(selectedKey.value);

    const credentials: Credentials = {
      email: selectedEmail.value,
      gitUserName: writeSession.value.name,
      githubAccountId: writeSession.value.accountId,
      githubUsername: writeSession.value.username,
      readOnlyToken: readSession.token,
      readOnlyTokenScope: readSession.tokenScope,
      readOnlyTokenType: readSession.tokenType,
      readOnlyAuthPrivateKeyPath: localReadOnlyAuthKey.value.privateKeyPath,
      readOnlyAuthPublicKeyPath: localReadOnlyAuthKey.value.publicKeyPath,
      writeRefreshToken: writeSession.value.refreshToken,
    };
    yield* saveCredentials(toolState, credentials);

    yield* e.Effect.log(`Logged in as @${writeSession.value.username} (${selectedEmail.value})`);
    yield* applyGitHubIdentityToWorkspace(
      root.value,
      writeSession.value,
      selectedEmail.value,
      selectedKey.value.publicKey,
      localReadOnlyAuthKey.value.privateKeyPath,
      credentials.readOnlyToken,
      git,
    );
  });

export const whoami = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const { git, toolState } = dependencies;
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

    if (!credentials.value.email) {
      yield* e.Effect.logError(`No email found in credentials. Run \`${TOOL_NAME} login\` again.`);
      return;
    }

    yield* e.Effect.log(credentials.value.email);
    yield* checkWorkspaceRepoAccess(root.value, credentials.value.readOnlyToken, git);
  });

export const ensureWriteTokenForActiveUser = (
  dependencies: AuthServiceDependencies,
): e.Effect.Effect<e.Option.Option<string>> =>
  e.Effect.gen(function*() {
    const { hostShell, toolState } = dependencies;
    if (!isGitHubOAuthConfigured()) {
      yield* e.Effect.logError(`${TOOL_NAME} has no GitHub OAuth App configured yet.`);
      return e.Option.none();
    }

    const credentials = yield* loadCredentials(toolState);
    if (e.Option.isNone(credentials)) {
      yield* e.Effect.logError(`Not logged in. Run \`${TOOL_NAME} login\` first.`);
      return e.Option.none();
    }

    const root = toolState.workspaceRoot;
    if (e.Option.isNone(root)) {
      yield* e.Effect.logError(`You're not in a ${TOOL_NAME} workspace.`);
      return e.Option.none();
    }

    const refreshed = yield* renewWriteTokenFromRefresh(credentials.value.writeRefreshToken);
    if (e.Option.isSome(refreshed) && isWriteCapableScope(refreshed.value.tokenScope)) {
      const updated: Credentials = {
        ...credentials.value,
        githubAccountId: refreshed.value.accountId || credentials.value.githubAccountId,
        githubUsername: refreshed.value.username || credentials.value.githubUsername,
        writeRefreshToken: refreshed.value.refreshToken || credentials.value.writeRefreshToken,
      };
      yield* saveCredentials(toolState, updated);
      return e.Option.some(refreshed.value.token);
    }

    const writeLogin = beginGitHubWriteLogin(hostShell);
    const session = yield* writeLogin.waitForSession;
    if (e.Option.isNone(session)) return e.Option.none();

    if (
      (credentials.value.githubAccountId > 0 &&
        session.value.accountId > 0 &&
        credentials.value.githubAccountId !== session.value.accountId) ||
      (!credentials.value.githubAccountId &&
        !!credentials.value.githubUsername &&
        credentials.value.githubUsername.trim().toLowerCase() !== session.value.username.trim().toLowerCase())
    ) {
      yield* e.Effect.logError(
        `Signed in to @${session.value.username}, but active user belongs to @${credentials.value.githubUsername || "unknown"}. Run \`${TOOL_NAME} login\` to switch users.`,
      );
      return e.Option.none();
    }

    const updated: Credentials = {
      ...credentials.value,
      githubAccountId: session.value.accountId || credentials.value.githubAccountId,
      githubUsername: session.value.username || credentials.value.githubUsername,
      writeRefreshToken: session.value.refreshToken || credentials.value.writeRefreshToken,
    };
    yield* saveCredentials(toolState, updated);
    return e.Option.some(session.value.token);
  });

const acquireReadOnlySession = (
  hostShell: AuthHostShell,
  writeSession: GitHubSession,
  continueWriteBrowser: (action: OAuthBrowserAction) => void,
): e.Effect.Effect<e.Option.Option<ReadOnlyLoginResult>> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log("Continuing in browser for explicit read-token login...");
    const readLogin = beginGitHubReadOnlyLogin(hostShell, { openBrowser: false });
    continueWriteBrowser(redirectOAuthBrowserAction(readLogin.authorizeUrl.toString()));

    const readSession = yield* readLogin.waitForSession;
    if (e.Option.isNone(readSession)) return e.Option.none();

    if (!sameGitHubAccount(writeSession, readSession.value)) {
      readLogin.continueInBrowser(displayOAuthBrowserAction(
        "GitHub authorization failed",
        `Read-token login returned @${readSession.value.username}, expected @${writeSession.username}. You may close this tab now.`,
      ));
      yield* e.Effect.logError(
        `Read-token login returned @${readSession.value.username}, expected @${writeSession.username}.`,
      );
      return e.Option.none();
    }

    const verifiedEmails = yield* getVerifiedGitHubEmails(readSession.value.token);

    yield* e.Effect.log(`Read-token login scope: ${readSession.value.tokenScope || "(none reported)"}`);
    if (!isReadScopeSatisfied(readSession.value.tokenScope)) {
      yield* e.Effect.logWarning(
        `Read token is missing the expected scope set: ${readSession.value.tokenScope || "(none reported)"}.`,
      );
    }
    if (isWriteCapableScope(readSession.value.tokenScope)) {
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
