import * as e from "effect";

export interface CurrentUserState {
  readonly email: string;
  readonly yubiKeyId: string;
  readonly yubiKeyLabel: string;
}

export interface IReadOnlyTokenState {
  readonly token: string;
  readonly scope: string;
  readonly tokenType: string;
  readonly gitUserName: string;
  readonly githubAccountId: number;
  readonly githubUsername: string;
}

export class IToolState extends e.Context.Tag("IToolState")<IToolState, {
  readonly requiredCLICommands: readonly string[];
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readCurrentUserState: e.Effect.Effect<e.Option.Option<CurrentUserState>>;
  readonly clearCurrentUserState: e.Effect.Effect<void>;
  readonly writeCurrentUserState: (state: CurrentUserState) => e.Effect.Effect<void>;
  readonly readReadOnlyTokenState: (email: string) => e.Effect.Effect<e.Option.Option<IReadOnlyTokenState>>;
  readonly writeReadOnlyTokenState: (email: string, state: IReadOnlyTokenState) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (email: string, token: string) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
}>() {}
