import * as e from "effect";
import type { Credentials } from "./types";
import type {
  CurrentUserState,
  IReadOnlyTokenState,
} from "../tool-state/interface";

export interface ToolStateApi {
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readCurrentUserState: e.Effect.Effect<e.Option.Option<CurrentUserState>>;
  readonly clearCurrentUserState: e.Effect.Effect<void>;
  readonly writeCurrentUserState: (
    state: CurrentUserState,
  ) => e.Effect.Effect<void>;
  readonly readReadOnlyTokenState: (
    email: string,
  ) => e.Effect.Effect<e.Option.Option<IReadOnlyTokenState>>;
  readonly writeReadOnlyTokenState: (
    email: string,
    state: IReadOnlyTokenState,
  ) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (
    email: string,
    token: string,
  ) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
}

export type UserTokenState = Credentials;

export const loadCredentials = (
  toolState: ToolStateApi,
): e.Effect.Effect<e.Option.Option<Credentials>> =>
  e.Effect.gen(function*() {
    if (!(yield* toolState.inWorkspace)) return e.Option.none();

    const currentUserState = yield* toolState.readCurrentUserState;
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
      sshKeySource: state.sshKeySource,
      sshKeyFingerprint: state.sshKeyFingerprint,
      sshKeyName: state.sshKeyName,
      sshKeyPath: state.sshKeyPath,
      yubiKeySerial: state.yubiKeySerial,
    });

    if (state.writeRefreshToken) {
      yield* toolState.writeWriteRefreshToken(
        state.email,
        state.writeRefreshToken,
      );
      return;
    }

    yield* toolState.clearWriteRefreshToken(state.email);
  });

export const loadWriteRefreshToken = (
  toolState: ToolStateApi,
  email: string,
): e.Effect.Effect<string> => toolState.readWriteRefreshToken(email);

export const loadReadOnlyToken = (
  toolState: ToolStateApi,
): e.Effect.Effect<string> =>
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

    return e.Option.some({
      email,
      gitUserName: tokenState.value.gitUserName,
      githubAccountId: tokenState.value.githubAccountId,
      githubUsername: tokenState.value.githubUsername,
      readOnlyToken: tokenState.value.token,
      readOnlyTokenScope: tokenState.value.scope,
      readOnlyTokenType: tokenState.value.tokenType,
      sshKeySource: tokenState.value.sshKeySource,
      sshKeyFingerprint: tokenState.value.sshKeyFingerprint,
      sshKeyName: tokenState.value.sshKeyName,
      sshKeyPath: tokenState.value.sshKeyPath,
      yubiKeySerial: tokenState.value.yubiKeySerial,
      writeRefreshToken: yield* loadWriteRefreshToken(toolState, email),
    });
  });
