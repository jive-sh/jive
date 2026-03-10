import * as path from "path";
import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import type { Credentials } from "./types";
import type { CurrentUserState } from "../tool-state/interface";

const USERS_DIR = `.${TOOL_NAME}/users`;
const READ_ONLY_AUTHN_KEY_FILE = "readonly-github-authn-ssh-key";

export type ToolStateApi = {
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readCurrentUserState: e.Effect.Effect<e.Option.Option<CurrentUserState>>;
  readonly clearCurrentUserState: e.Effect.Effect<void>;
  readonly writeCurrentUserState: (state: CurrentUserState) => e.Effect.Effect<void>;
  readonly readReadOnlyTokenState: (
    email: string,
  ) => e.Effect.Effect<e.Option.Option<{
    token: string;
    scope: string;
    tokenType: string;
    gitUserName: string;
    githubAccountId: number;
    githubUsername: string;
  }>>;
  readonly writeReadOnlyTokenState: (
    email: string,
    state: {
      token: string;
      scope: string;
      tokenType: string;
      gitUserName: string;
      githubAccountId: number;
      githubUsername: string;
    },
  ) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (email: string, token: string) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
};

export interface UserTokenState {
  readonly email: string;
  readonly gitUserName: string;
  readonly githubAccountId: number;
  readonly githubUsername: string;
  readonly readOnlyToken: string;
  readonly readOnlyTokenScope: string;
  readonly readOnlyTokenType: string;
  readonly writeRefreshToken: string;
}

export const loadCredentials = (toolState: ToolStateApi): e.Effect.Effect<e.Option.Option<Credentials>> =>
  e.Effect.gen(function*() {
    if (!(yield* toolState.inWorkspace)) return e.Option.none();

    const currentUserState = yield* resolveCurrentUserState(toolState);
    if (e.Option.isNone(currentUserState)) return e.Option.none();

    return yield* loadCredentialsForUser(toolState, currentUserState.value.email);
  });

export const saveCredentials = (
  toolState: ToolStateApi,
  credentials: Credentials,
): e.Effect.Effect<void> =>
  saveUserTokenState(toolState, credentials);

export const saveUserTokenState = (
  toolState: ToolStateApi,
  state: UserTokenState,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* toolState.writeReadOnlyTokenState(state.email, {
      token: state.readOnlyToken,
      scope: state.readOnlyTokenScope,
      tokenType: state.readOnlyTokenType,
      gitUserName: state.gitUserName,
      githubAccountId: state.githubAccountId,
      githubUsername: state.githubUsername,
    });

    if (state.writeRefreshToken) {
      yield* toolState.writeWriteRefreshToken(state.email, state.writeRefreshToken);
    } else {
      yield* toolState.clearWriteRefreshToken(state.email);
    }
  });

export const loadWriteRefreshToken = (
  toolState: ToolStateApi,
  email: string,
): e.Effect.Effect<string> => toolState.readWriteRefreshToken(email);

export function getReadOnlyAuthKeyPaths(
  workspaceRoot: e.Option.Option<string>,
  email: string,
): { privateKeyPath: string; publicKeyPath: string } {
  if (e.Option.isNone(workspaceRoot)) {
    return { privateKeyPath: "", publicKeyPath: "" };
  }

  const privateKeyPath = path.join(userDirectory(workspaceRoot.value, email), READ_ONLY_AUTHN_KEY_FILE);
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
  };
}

export const loadReadOnlyToken = (toolState: ToolStateApi): e.Effect.Effect<string> =>
  e.Effect.gen(function*() {
    const credentials = yield* loadCredentials(toolState);
    if (e.Option.isNone(credentials)) return "";
    return credentials.value.readOnlyToken;
  });

const loadCredentialsForUser = (
  toolState: ToolStateApi,
  email: string,
): e.Effect.Effect<e.Option.Option<Credentials>> =>
  e.Effect.gen(function*() {
    const tokenState = yield* toolState.readReadOnlyTokenState(email);
    if (e.Option.isNone(tokenState)) return e.Option.none();

    const { privateKeyPath, publicKeyPath } = getReadOnlyAuthKeyPaths(toolState.workspaceRoot, email);
    if (!privateKeyPath || !publicKeyPath) return e.Option.none();

    return e.Option.some({
      email,
      githubAccountId: tokenState.value.githubAccountId,
      githubUsername: tokenState.value.githubUsername,
      readOnlyToken: tokenState.value.token,
      readOnlyTokenScope: tokenState.value.scope,
      readOnlyTokenType: tokenState.value.tokenType,
      readOnlyAuthPrivateKeyPath: privateKeyPath,
      readOnlyAuthPublicKeyPath: publicKeyPath,
      writeRefreshToken: yield* loadWriteRefreshToken(toolState, email),
      gitUserName: tokenState.value.gitUserName,
    });
  });

const resolveCurrentUserState = (toolState: ToolStateApi): e.Effect.Effect<e.Option.Option<CurrentUserState>> =>
  e.Effect.gen(function*() {
    return yield* toolState.readCurrentUserState;
  });

function userDirectory(root: string, email: string): string {
  return path.join(root, USERS_DIR, sanitizeEmailDirectoryName(email));
}

function sanitizeEmailDirectoryName(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[\/\\]/g, "_");
}
