import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { BadArgumentError } from "@/errors";
import { modules } from "@/modules";
import { setSshKey, sshKeyExists } from "./authzn-keys";
import { oauthLogin } from "./oauth/oauth-impl";
import "javascript-time-ago/locale/en";
import TimeAgo from "javascript-time-ago";
import { refreshAccessToken } from "./oauth/refresh-access-token";
import { canReadFromRemote, canWriteToRemote } from "./repos";
import type { GithubAccessToken, GithubWriteToken, IGitHub } from "./interface";
import type { AccountKey } from "../account-key/interface";
import type { CurrentUserState, TokenState } from "../tool-state/interface";
import type { RepoIdentifier } from "../tool-state/repo-identifier";

export class GithubImpl extends implementing(modules.github).uses(modules.toolState) implements IGitHub {
  *resolveAccessToken(userState: CurrentUserState): EffectGen<{accessToken: GithubAccessToken}, BadArgumentError> {
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
      return {
        accessToken: {
          accessToken: refreshed.accessToken,
          tokenType: tokenState.tokenType,
        },
      };
    }

    return existingToken;
  }
  *oauthLogin(username?: string): EffectGen<{accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string;}> {
    return yield* oauthLogin(username);
  }
  *sshKeyExists(accessToken: GithubAccessToken, key: AccountKey): EffectGen<{authn: boolean; signing: boolean}> {
    return yield* sshKeyExists(accessToken, key);
  }
  *setSshKey(writeToken: GithubWriteToken, key: AccountKey): EffectGen<void> {
    yield* setSshKey(writeToken, key);
  }
  *remoteRepos(_org: string, _accessToken: e.Option.Option<GithubAccessToken>): EffectGen<string[]> {
    return []; 
  }
  *canReadFromRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean> {
    return yield* canReadFromRemote(repo, accessToken);
  }
  *canWriteToRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean> {
    return yield* canWriteToRemote(repo, accessToken);
  }
  remoteUrls(repo: RepoIdentifier): { ssh: string; https: string; } {
    return {
      ssh: `git@github.com:${repo.org}/${repo.repo}.git`,
      https: `https://github.com/${repo.org}/${repo.repo}.git`
    };
  }
}
