import * as e from "effect";
import * as modules from "../index";
import type { OAuthBrowserHost } from "../auth/oauth";
import {
  beginGitHubReadOnlyLogin,
  beginGitHubWriteLogin,
  checkWorkspaceRepoAccess,
  ensureGitHubAuthKey,
  ensureGitHubSigningKey,
  getVerifiedGitHubEmails,
  isGitHubOAuthConfigured,
  isReadScopeSatisfied,
  isWriteCapableScope,
  listGitHubJiveKeys,
  remoteRepos,
  renewWriteTokenFromRefresh,
  repoDefaultBranch,
} from "./service";

export const GitHubImpl = e.Layer.effect(modules.IGitHub, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;

  const githubHostShell: OAuthBrowserHost = {
    openUrl: hostShell.openUrl,
  };

  return {
    requiredCLICommands: [],
    isOAuthConfigured: isGitHubOAuthConfigured,
    beginReadOnlyLogin: (options) => beginGitHubReadOnlyLogin(githubHostShell, options),
    beginWriteLogin: (options) => beginGitHubWriteLogin(githubHostShell, options),
    renewWriteTokenFromRefresh,
    isWriteCapableScope,
    isReadScopeSatisfied,
    getVerifiedEmails: getVerifiedGitHubEmails,
    listJiveKeys: listGitHubJiveKeys,
    ensureAuthKey: (githubToken, keyName, publicKey, knownJiveInventory = e.Option.none()) =>
      ensureGitHubAuthKey(githubToken, keyName, publicKey, knownJiveInventory),
    ensureSigningKey: (githubToken, keyName, publicKey, knownJiveInventory = e.Option.none()) =>
      ensureGitHubSigningKey(githubToken, keyName, publicKey, knownJiveInventory),
    remoteRepos,
    repoDefaultBranch,
    checkWorkspaceRepoAccess,
  };
}));
