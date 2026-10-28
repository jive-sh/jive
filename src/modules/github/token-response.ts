import * as e from "effect";
import { Token } from "oauth2-cli";

const TokenNumberSchema = e.Schema.Union([e.Schema.Number, e.Schema.NumberFromString]);

const GitHubTokenResponseSchema = e.Schema.Struct({
  access_token: e.Schema.optionalKey(e.Schema.String),
  scope: e.Schema.optionalKey(e.Schema.String),
  refresh_token: e.Schema.optionalKey(e.Schema.String),
  expires_in: e.Schema.optionalKey(TokenNumberSchema),
  refresh_token_expires_in: e.Schema.optionalKey(TokenNumberSchema),
});

export const decodeGitHubTokenResponse = (response: Token.Response) =>
  e.Schema.decodeUnknownEffect(GitHubTokenResponseSchema)(response);
