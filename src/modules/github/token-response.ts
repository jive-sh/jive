import * as e from "effect";
import { Token } from "oauth2-cli";

const TokenNumberSchema = e.Schema.Union(e.Schema.Number, e.Schema.NumberFromString);

const GitHubTokenResponseSchema = e.Schema.Struct({
  access_token: e.Schema.optional(e.Schema.String),
  scope: e.Schema.optional(e.Schema.String),
  refresh_token: e.Schema.optional(e.Schema.String),
  expires_in: e.Schema.optional(TokenNumberSchema),
  refresh_token_expires_in: e.Schema.optional(TokenNumberSchema),
});

export const decodeGitHubTokenResponse = (response: Token.Response) =>
  e.Schema.decodeUnknown(GitHubTokenResponseSchema)(response);
