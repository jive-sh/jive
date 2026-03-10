import * as e from "effect";
import * as modules from "../index";
import type { AuthHostShell } from "../auth/host-shell";
import { currentBrowserOpenCommand } from "../auth/oauth";
import {
  beginGitHubReadOnlyLogin,
  beginGitHubWriteLogin,
  checkWorkspaceRepoAccess,
  ensureGitHubAuthKey,
  ensureGitHubSigningJiveKey,
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

  const githubHostShell: AuthHostShell = {
    commandExists: hostShell.commandExists,
    missingCommands: hostShell.missingCommands,
    run: (command) =>
      hostShell.run(command).pipe(
        e.Effect.map((result) => e.Option.some(result)),
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
      ),
  };

  return {
    requiredCLICommands: [currentBrowserOpenCommand()],
    isOAuthConfigured: isGitHubOAuthConfigured,
    beginReadOnlyLogin: (options) => beginGitHubReadOnlyLogin(githubHostShell, options),
    beginWriteLogin: (options) => beginGitHubWriteLogin(githubHostShell, options),
    renewWriteTokenFromRefresh,
    isWriteCapableScope,
    isReadScopeSatisfied,
    getVerifiedEmails: getVerifiedGitHubEmails,
    listJiveKeys: listGitHubJiveKeys,
    ensureSigningJiveKey: (githubToken, key, knownJiveInventory = e.Option.none()) =>
      ensureGitHubSigningJiveKey(githubToken, key, knownJiveInventory),
    ensureAuthKey: (githubToken, keyName, publicKey, knownJiveInventory = e.Option.none()) =>
      ensureGitHubAuthKey(githubToken, keyName, publicKey, knownJiveInventory),
    remoteRepos,
    repoDefaultBranch,
    checkWorkspaceRepoAccess,
  };
}));
