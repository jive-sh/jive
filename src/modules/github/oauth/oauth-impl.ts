import * as e from "effect";
import { GithubAccessTokenType, type GithubWriteToken } from "@/modules/github/interface";
import type { TokenState } from "@/modules/tool-state/interface";
import { createGitHubOAuthClient, READ_SCOPES, WRITE_SCOPES } from "./oauth";
import { fetchSessionFromTokenResponse, type GitHubSession } from "../user";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const authorizeForScopes = (
  scopes: string,
  browserLabel: string,
  expectedUsername?: string,
): e.Effect.Effect<GitHubSession> =>
  e.Effect.gen(function*() {
    const { client } = yield* createGitHubOAuthClient({
      scope: scopes,
      promptAccountSelection: !expectedUsername,
      preferredUsername: expectedUsername,
    });
    const tokenResponse = yield* e.pipe(
      e.Effect.tryPromise(() => client.authorize()),
      e.Effect.catchAll(error => e.Effect.dieMessage(`${browserLabel} failed: ${getErrorMessage(error)}`)),
    );
    const maybeSession = yield* fetchSessionFromTokenResponse(tokenResponse, scopes);
    if (e.Option.isNone(maybeSession)) {
      return yield* e.Effect.dieMessage(`${browserLabel} did not return a usable GitHub session.`);
    }
    if (expectedUsername && maybeSession.value.username !== expectedUsername) {
      return yield* e.Effect.dieMessage(
        `Expected GitHub user ${expectedUsername} but got ${maybeSession.value.username}.`,
      );
    }

    return maybeSession.value;
  });

export const oauthLogin = (username?: string): e.Effect.Effect<{
  accessTokenState: TokenState;
  writeToken: GithubWriteToken;
  username: string;
  email: string;
}> =>
  e.Effect.gen(function*() {
    const writeSession = yield* authorizeForScopes(WRITE_SCOPES, "GitHub write authorization", username);
    const readSession = yield* authorizeForScopes(READ_SCOPES, "GitHub read authorization", writeSession.username);
    const email = readSession.email || writeSession.email;
    if (!email) {
      return yield* e.Effect.dieMessage("GitHub login completed without a usable verified email.");
    }

    return {
      accessTokenState: {
        tokenType: GithubAccessTokenType.OAuthApp(),
        token: readSession.accessToken,
        scope: readSession.scope,
        expiration: readSession.expiration,
      },
      writeToken: {
        writeToken: writeSession.accessToken,
      },
      username: readSession.username,
      email,
    };
  });
