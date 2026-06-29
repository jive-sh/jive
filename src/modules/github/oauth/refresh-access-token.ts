import * as e from "effect";
import { BadArgumentError } from "@/modules";
import { decodeGitHubTokenResponse } from "../token-response";
import { createGitHubOAuthClient } from "./oauth";

const readRequiredTokenString = (
  value: string | undefined,
  reason: string,
): e.Effect.Effect<string, BadArgumentError> => {
  if (typeof value === "string" && value.length > 0) {
    return e.Effect.succeed(value);
  }
  return new BadArgumentError({
    argument: "refreshed access token",
    reason,
  });
};

export const refreshAccessToken = e.Effect.fn(function*(refreshToken: string, requestedScope: string) {
  const requestStartedAt = Date.now();
  const { client } = yield* createGitHubOAuthClient({
    scope: requestedScope,
    refreshToken,
  });
  // `isAuthorized()` attempts refresh using configured storage and returns
  // `false` instead of falling through to interactive browser auth.
  const refreshed = yield* e.pipe(
    e.Effect.tryPromise(() => client.isAuthorized()),
    e.Effect.catchAll(error =>
      e.Effect.fail(new BadArgumentError({
        argument: "refresh token",
        reason: `Failed to refresh token due to ${error instanceof Error ? error.message : String(error)}`,
      })),
    ),
  );
  if (!refreshed) {
    return yield* new BadArgumentError({
      argument: "refresh token",
      reason: "Refresh token was missing, expired, or rejected.",
    });
  }

  const response = yield* e.pipe(
    e.Effect.tryPromise(() => client.getToken()),
    e.Effect.catchAll(error =>
      e.Effect.fail(new BadArgumentError({
        argument: "refreshed access token",
        reason: `Failed to load refreshed token due to ${error instanceof Error ? error.message : String(error)}`,
      })),
    ),
  );
  const tokenResponse = yield* e.pipe(
    decodeGitHubTokenResponse(response),
    e.Effect.catchTag("ParseError", error =>
      new BadArgumentError({
        argument: "refreshed access token",
        reason: error.message,
      }),
    ),
  );

  const accessToken = yield* readRequiredTokenString(
    tokenResponse.access_token,
    "GitHub did not return an access token.",
  );
  const nextRefreshToken = yield* readRequiredTokenString(
    tokenResponse.refresh_token,
    "GitHub did not return a refresh token.",
  );
  const accessTokenExpiresIn = tokenResponse.expires_in ?? 0;
  const refreshTokenExpiresIn = tokenResponse.refresh_token_expires_in ?? 0;
  if (accessTokenExpiresIn <= 0 || refreshTokenExpiresIn <= 0) {
    return yield* new BadArgumentError({
      argument: "refreshed access token",
      reason: "GitHub did not return usable access token expiration metadata.",
    });
  }

  return {
    scope: tokenResponse.scope ?? requestedScope,
    accessToken,
    accessTokenExpiration: requestStartedAt + (accessTokenExpiresIn * 1000),
    refreshToken: nextRefreshToken,
    refreshTokenExpiration: requestStartedAt + (refreshTokenExpiresIn * 1000),
  };
}) satisfies (refreshToken: string, requestedScope: string) =>
  e.Effect.Effect<{
    scope: string;
    accessToken: string;
    accessTokenExpiration: number;
    refreshToken: string;
    refreshTokenExpiration: number;
  }, BadArgumentError>;
