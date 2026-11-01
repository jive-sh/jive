import * as e from "effect";
import { GithubAccessTokenType, type GithubWriteToken } from "@/modules/github/interface";
import type { TokenState } from "@/modules/tool-state/interface";
import { createGitHubOAuthClient, WRITE_SCOPES } from "./oauth";
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
      e.Effect.catch(error => e.Effect.die(`${browserLabel} failed: ${getErrorMessage(error.cause)}`)),
    );
    const maybeSession = yield* fetchSessionFromTokenResponse(tokenResponse, scopes);
    if (e.Option.isNone(maybeSession)) {
      return yield* e.Effect.die(`${browserLabel} did not return a usable GitHub session.`);
    }
    if (expectedUsername && maybeSession.value.username !== expectedUsername) {
      return yield* e.Effect.die(
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
    // One sign-in, one consent: the token that registers the SSH key also reads repos for git-credential-jive. A
    // second, read-only pass was one more approval for the person to click (Alex, 2026-11-01: "no manual steps").
    const session = yield* authorizeForScopes(WRITE_SCOPES, "GitHub authorization", username);
    const email = session.email;
    if (!email) {
      return yield* e.Effect.die("GitHub login completed without a usable verified email.");
    }

    return {
      accessTokenState: {
        tokenType: GithubAccessTokenType.OAuthApp(),
        token: session.accessToken,
        scope: session.scope,
        expiration: session.expiration,
      },
      writeToken: {
        writeToken: session.accessToken,
      },
      username: session.username,
      email,
    };
  });

