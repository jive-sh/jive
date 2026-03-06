import * as e from "effect";
import {
  applyGitHubIdentityToWorkspace,
  checkWorkspaceRepoAccess,
  ensureGitHubAuthKey,
  ensureGitHubSigningJiveKey,
  getVerifiedGitHubEmails,
  isReadScopeSatisfied,
  isWriteCapableScope,
  isGitHubOAuthConfigured,
  listGitHubJiveKeys,
  loginToGitHubReadOnly,
  loginToGitHubWrite,
  renewReadOnlyTokenFromRefresh,
  renewWriteTokenFromRefresh,
} from "./github";
import { getReadOnlyAuthKeyPaths, loadCredentials, saveCredentials } from "./credentials";
import { printGitHubJiveKeyList, printYubiKeyList, selectOrCreateJiveKey } from "./key-selection";
import { createReadOnlyAuthKey } from "./local-auth-key";
import { selectOne } from "./prompts";
import { ensureOpenSshForLogin } from "./openssh";
import {
  createResidentJiveKey,
  listConnectedYubiKeys,
  listResidentJiveKeys,
  loadResidentJiveKeyIntoAgent,
} from "./yubikey";
import { GITHUB_KEY_PREFIX } from "./constants";
import type { ConnectedYubiKeyDevice, Credentials, GitHubSession } from "./types";
import { ModuleDependenciesLive } from "../runtime";
import { WORKSPACE_DIR } from "../tool-state/constants";
import { IToolState } from "../tool-state/interface";
import { TOOL_NAME } from "../../constants";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const logInfoSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.log(...message));
};
const logWarningSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logWarning(...message));
};
const logErrorSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logError(...message));
};
const runSyncWithModules = <A, E>(effect: e.Effect.Effect<A, E, unknown>) =>
  e.Effect.runSync(
    e.Effect.provide(effect, ModuleDependenciesLive) as e.Effect.Effect<A, E, never>,
  );
const withToolStateSync = <A>(fn: (toolState: { readonly workspaceRoot: e.Option.Option<string> }) => A): A =>
  runSyncWithModules(
    e.Effect.gen(function*() {
      const toolState = yield* IToolState;
      return fn(toolState);
    }),
  );
const workspaceRoot = () => withToolStateSync((toolState) => toolState.workspaceRoot);

export async function login(): Promise<void> {
  const root = workspaceRoot();
  if (e.Option.isNone(root)) {
    logErrorSync(`No ${WORKSPACE_DIR} workspace found. Run \`${TOOL_NAME} init\` first.`);
    return;
  }

  if (!isGitHubOAuthConfigured()) {
    logErrorSync(`${TOOL_NAME} has no GitHub OAuth App configured yet.`);
    logErrorSync("Register one at https://github.com/settings/developers and set CLIENT_ID/CLIENT_SECRET in src/modules/auth/github.ts.");
    return;
  }

  if (!ensureOpenSshForLogin()) {
    return;
  }

  const writeSession = await loginToGitHubWrite();
  if (e.Option.isNone(writeSession)) return;
  if (!writeSession.value.email) {
    logErrorSync("No verified email found on this GitHub account.");
    return;
  }

  const readSession = await acquireReadOnlySession(writeSession.value);
  if (e.Option.isNone(readSession)) return;

  const connectedYubiKeys = await listConnectedYubiKeys();
  if (e.Option.isNone(connectedYubiKeys) || connectedYubiKeys.value.length === 0) {
    logErrorSync("No yubikey detected. Please connect then try again");
    return;
  }

  if (connectedYubiKeys.value.length > 1) {
    logInfoSync("Multiple yubikeys detected. Which one would you like to use?");
    const selectedYubiKey = await promptForConnectedYubiKeySelection(connectedYubiKeys.value);
    if (e.Option.isNone(selectedYubiKey)) return;
  }

  const verifiedEmails = await getVerifiedGitHubEmails(writeSession.value.token);

  const yubiKeys = await listResidentJiveKeys();
  if (e.Option.isNone(yubiKeys)) {
    logErrorSync("No yubikey detected. Please connect then try again");
    return;
  }

  const githubJiveKeys = await listGitHubJiveKeys(writeSession.value.token);

  logInfoSync(`Jive key naming convention: ${GITHUB_KEY_PREFIX}<email>`);
  printYubiKeyList(yubiKeys.value);
  if (e.Option.isSome(githubJiveKeys)) {
    printGitHubJiveKeyList(githubJiveKeys.value.auth, githubJiveKeys.value.signing);
  } else {
    logErrorSync("Could not list existing jive keys on GitHub.");
  }

  const selectedKey = await selectOrCreateJiveKey(
    {
      yubiKeys: yubiKeys.value,
      githubJiveKeys,
      verifiedEmails,
      githubEmail: writeSession.value.email,
      createResidentJiveKey,
    },
  );
  if (e.Option.isNone(selectedKey)) return;

  const authKeyPaths = getReadOnlyAuthKeyPaths(writeSession.value.email);
  logInfoSync(`Creating local read-only auth key: ${GITHUB_KEY_PREFIX}${writeSession.value.email}`);
  const localReadOnlyAuthKey = createReadOnlyAuthKey(
    authKeyPaths.privateKeyPath,
    authKeyPaths.publicKeyPath,
    writeSession.value.email,
  );
  if (e.Option.isNone(localReadOnlyAuthKey)) return;

  await ensureGitHubSigningJiveKey(writeSession.value.token, selectedKey.value, githubJiveKeys);
  await ensureGitHubAuthKey(
    writeSession.value.token,
    localReadOnlyAuthKey.value.name,
    localReadOnlyAuthKey.value.publicKey,
    githubJiveKeys,
  );
  await loadResidentJiveKeyIntoAgent(selectedKey.value);

  const credentials: Credentials = {
    email: writeSession.value.email,
    gitUserName: writeSession.value.name,
    readOnlyToken: readSession.value.token,
    readOnlyTokenScope: readSession.value.tokenScope,
    readOnlyTokenType: readSession.value.tokenType,
    readOnlyAuthPrivateKeyPath: localReadOnlyAuthKey.value.privateKeyPath,
    readOnlyAuthPublicKeyPath: localReadOnlyAuthKey.value.publicKeyPath,
    writeRefreshToken: writeSession.value.refreshToken,
  };
  saveCredentials(credentials);

  logInfoSync(`Logged in as @${writeSession.value.username} (${writeSession.value.email})`);
  await applyGitHubIdentityToWorkspace(
    root.value,
    writeSession.value,
    selectedKey.value.publicKey,
    localReadOnlyAuthKey.value.privateKeyPath,
    credentials.readOnlyToken,
  );
}

export async function whoami(): Promise<void> {
  const root = workspaceRoot();
  if (e.Option.isNone(root)) {
    logErrorSync(`You're not in a ${TOOL_NAME} workspace`);
    return;
  }

  const credentials = loadCredentials();
  if (e.Option.isNone(credentials)) {
    logErrorSync(`Not logged in. Run \`${TOOL_NAME} login\` first.`);
    return;
  }

  if (!credentials.value.email) {
    logErrorSync(`No email found in credentials. Run \`${TOOL_NAME} login\` again.`);
    return;
  }

  logInfoSync(credentials.value.email);
  await checkWorkspaceRepoAccess(root.value, credentials.value.readOnlyToken);
}

export async function ensureWriteTokenForActiveUser(): Promise<e.Option.Option<string>> {
  if (!isGitHubOAuthConfigured()) {
    logErrorSync(`${TOOL_NAME} has no GitHub OAuth App configured yet.`);
    return e.Option.none();
  }

  const credentials = loadCredentials();
  if (e.Option.isNone(credentials)) {
    logErrorSync(`Not logged in. Run \`${TOOL_NAME} login\` first.`);
    return e.Option.none();
  }

  const root = workspaceRoot();
  if (e.Option.isNone(root)) {
    logErrorSync(`You're not in a ${TOOL_NAME} workspace`);
    return e.Option.none();
  }

  const refreshed = await renewWriteTokenFromRefresh(credentials.value.writeRefreshToken);
  if (e.Option.isSome(refreshed) && isWriteCapableScope(refreshed.value.tokenScope)) {
    const updated: Credentials = {
      ...credentials.value,
      writeRefreshToken: refreshed.value.refreshToken || credentials.value.writeRefreshToken,
    };
    saveCredentials(updated);
    return e.Option.some(refreshed.value.token);
  }

  const writeLogin = await loginToGitHubWrite();
  if (e.Option.isNone(writeLogin)) return e.Option.none();

  const expectedEmail = credentials.value.email.trim().toLowerCase();
  const returnedEmail = writeLogin.value.email.trim().toLowerCase();
  if (expectedEmail && returnedEmail && expectedEmail !== returnedEmail) {
    logErrorSync(`Signed in to ${writeLogin.value.email}, but active user is ${credentials.value.email}. Run \`${TOOL_NAME} login\` to switch users.`);
    return e.Option.none();
  }

  const updated: Credentials = {
    ...credentials.value,
    writeRefreshToken: writeLogin.value.refreshToken || credentials.value.writeRefreshToken,
  };
  saveCredentials(updated);
  return e.Option.some(writeLogin.value.token);
}

async function acquireReadOnlySession(writeSession: GitHubSession): Promise<e.Option.Option<GitHubSession>> {
  logInfoSync("Attempting read-token acquisition via refresh token...");
  const refreshedRead = await renewReadOnlyTokenFromRefresh(writeSession.refreshToken);
  if (e.Option.isSome(refreshedRead)) {
    if (!sameEmail(writeSession.email, refreshedRead.value.email)) {
      logWarningSync(yellow(`WARNING: refresh-token read session email mismatch (${refreshedRead.value.email} vs ${writeSession.email}). Falling back to browser read login.`));
    } else {
      const scope = refreshedRead.value.tokenScope || "(none reported)";
      if (isReadScopeSatisfied(refreshedRead.value.tokenScope) && !isWriteCapableScope(refreshedRead.value.tokenScope)) {
        logInfoSync(`Refresh-token downscope succeeded. Read scope: ${scope}`);
        return refreshedRead;
      }
      logWarningSync(yellow(`WARNING: refresh-token exchange returned non-reduced or insufficient scope: ${scope}`));
      logWarningSync(yellow("WARNING: requesting explicit read token login."));
    }
  } else {
    logWarningSync(yellow("WARNING: refresh-token exchange did not return a read token. Requesting explicit read token login."));
  }

  logInfoSync("Opening browser for explicit read-token login...");
  const readLogin = await loginToGitHubReadOnly();
  if (e.Option.isNone(readLogin)) return e.Option.none();
  if (!sameEmail(writeSession.email, readLogin.value.email)) {
    logErrorSync(`Read-token login returned ${readLogin.value.email}, expected ${writeSession.email}.`);
    return e.Option.none();
  }

  logInfoSync(`Read-token login scope: ${readLogin.value.tokenScope || "(none reported)"}`);
  if (!isReadScopeSatisfied(readLogin.value.tokenScope)) {
    logWarningSync(yellow(`WARNING: read token missing expected scope set: ${readLogin.value.tokenScope || "(none reported)"}`));
  }
  if (isWriteCapableScope(readLogin.value.tokenScope)) {
    logWarningSync(yellow("WARNING: read-token login still includes key-write scopes on GitHub."));
  }

  return readLogin;
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function promptForConnectedYubiKeySelection(
  keys: ConnectedYubiKeyDevice[],
): Promise<e.Option.Option<ConnectedYubiKeyDevice>> {
  return selectOne(
    "Select a yubikey device:",
    keys,
    (key) => key.id,
    (key, index) => `${index + 1}. ${key.label}`,
  );
}
