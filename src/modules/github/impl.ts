import * as e from "effect";
import * as modules from "@/modules";
import type { OAuthBrowserHost } from "./oauth";
import {
  canReadFromRemote,
  getVerifiedEmails,
  oauthLogin,
  remoteRepos,
  resolveAccessToken,
  setSshKey,
  sshKeyExists,
} from "./service";

export const GitHubImpl = e.Layer.effect(modules.IGitHub, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;

  const browserHost: OAuthBrowserHost = {
    openUrl: hostShell.openUrl,
  };

  return {
    resolveAccessToken: e.Effect.fn(function*(tokenState) {
      return yield* resolveAccessToken(tokenState);
    }),
    oauthLogin: e.Effect.fn(function*(username?: string) {
      return yield* oauthLogin(browserHost, username);
    }),
    getVerifiedEmails: e.Effect.fn(function*(accessToken) {
      return yield* getVerifiedEmails(accessToken);
    }),
    sshKeyExists: e.Effect.fn(function*(accessToken, key) {
      return yield* sshKeyExists(accessToken, key);
    }),
    setSshKey: e.Effect.fn(function*(writeToken, key) {
      yield* setSshKey(writeToken, key);
    }),
    setupOrgs: e.Effect.fn(function*() {
      return yield* e.Effect.dieMessage("github.setupOrgs is not implemented");
    }),
    remoteRepos: e.Effect.fn(function*(org, accessToken) {
      return yield* remoteRepos(org, accessToken);
    }),
    canReadFromRemote: e.Effect.fn(function*(repo, accessToken) {
      return yield* canReadFromRemote(repo, accessToken);
    }),
    setupRepo: e.Effect.fn(function*() {
      return yield* e.Effect.dieMessage("github.setupRepo is not implemented");
    }),
  };
}));
