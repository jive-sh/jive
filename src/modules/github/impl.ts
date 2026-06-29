import * as e from "effect";
import { BadArgumentError, BadPreconditionsError, modules } from "@/modules";
import { setSshKey, sshKeyExists } from "./authzn-keys";
import { oauthLogin } from "./oauth/oauth-impl";
import "javascript-time-ago/locale/en";
import TimeAgo from "javascript-time-ago";
import { refreshAccessToken } from "./oauth/refresh-access-token";
import { canReadFromRemote, canWriteToRemote, remoteRepos } from "./repos";
import { getVerifiedEmails } from "./user";
import type { GithubAccessToken, GithubWriteToken, IGitHub } from "./interface";
import { effunct, Implementing, type GenEffect } from "@/temp-libs/effective-modules";
import type { SshKey } from "../ssh/ssh-key";
import type { CurrentUserState } from "../tool-state/interface";
import type { RepoIdentifier } from "../tool-state/repo-identifier";

export class GithubImpl extends Implementing(modules.github).Uses(modules.toolState) implements IGitHub {
  *resolveAccessToken(userState: CurrentUserState): GenEffect<{accessToken: GithubAccessToken}, BadArgumentError> {
    const { toolState } = this.dependencies;
    const tokenState = userState.accessTokenState;
    const existingToken: {accessToken: GithubAccessToken} = {
      accessToken: {
        accessToken: tokenState.token,
        tokenType: tokenState.tokenType,
      }
    };
    if (e.Option.isSome(tokenState.expiration)) {
      const expiration = tokenState.expiration.value;
      const oneMinuteFromNow = Date.now() + (1000 * 60);
      const expired = oneMinuteFromNow > expiration.tokenExpiresAt;
      if (!expired) {
        return existingToken;
      }

      const timeAgo = new TimeAgo("en");
      const accessTokenExpirationStr = timeAgo.format(new Date(expiration.tokenExpiresAt));
      const refreshTokenExpired = oneMinuteFromNow > expiration.refreshTokenExpiresAt;
      if (refreshTokenExpired) {
        const refreshExpirationStr = timeAgo.format(new Date(expiration.refreshTokenExpiresAt));
        return yield* new BadArgumentError({
          argument: "refresh token",
          reason: `refresh token expired ${refreshExpirationStr}, access token expired ${accessTokenExpirationStr}`,
        });
      }

      yield* e.Effect.log("Refreshing access token");
      const refreshed = yield* refreshAccessToken(expiration.refreshToken, tokenState.scope);
      yield* toolState.setUser({
        email: userState.email,
        username: userState.username,
        accessToken: {
          token: refreshed.accessToken,
          tokenType: tokenState.tokenType,
          scope: tokenState.scope,
          expiration: e.Option.some({
            tokenExpiresAt: refreshed.accessTokenExpiration,
            refreshToken: refreshed.refreshToken,
            refreshTokenExpiresAt: refreshed.refreshTokenExpiration,
          }),
        },
      });
      if (e.Option.isSome(userState.sshKey)) {
        // setUser clears the ssh key, so restore the existing workspace-managed key
        yield* toolState.setSshKey(userState.sshKey.value);
      }
      
      return {
        accessToken: {
          accessToken: refreshed.accessToken,
          tokenType: tokenState.tokenType,
        },
      };
    }

    return existingToken;
  }
  *oauthLogin(username?: string): GenEffect<{accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string;}> {
    return yield* oauthLogin(username);
  }
  *getVerifiedEmails(accessToken: GithubAccessToken): GenEffect<string[]> {
    return yield* getVerifiedEmails(accessToken);
  }
  *sshKeyExists(accessToken: GithubAccessToken, key: SshKey): GenEffect<{authn: boolean; signing: boolean}> {
    return yield* sshKeyExists(accessToken, key);
  }
  *setSshKey(writeToken: GithubWriteToken, key: SshKey): GenEffect<void> {
    yield* setSshKey(writeToken, key);
  }
  *remoteRepos(org: string, accessToken: e.Option.Option<GithubAccessToken>): GenEffect<string[]> {
    return []; 
  }
  *canReadFromRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): GenEffect<boolean> {
    return yield* canReadFromRemote(repo, accessToken);
  }
  *canWriteToRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): GenEffect<boolean> {
    return yield* canWriteToRemote(repo, accessToken);
  }
  remoteUrls(repo: RepoIdentifier): { ssh: string; https: string; } {
    return {
      ssh: `git@github.com:${repo.org}/${repo.repo}.git`,
      https: `https://github.com/${repo.org}/${repo.repo}.git`
    };
  }
  *setupOrgs(writeToken: GithubWriteToken): GenEffect<void> {
    return yield* e.Effect.dieMessage("github.setupOrgs is not implemented");
  }
  *setupRemoteRepo(repo: RepoIdentifier, writeToken: GithubWriteToken, cicdSecrets: Record<string, string>): GenEffect<void> {
    return yield* e.Effect.dieMessage("github.setupRepo is not implemented");
  }
}
