import * as e from "effect";

export interface IReadOnlyTokenState {
  readonly token: string;
  readonly scope: string;
  readonly tokenType: string;
  readonly gitUserName: string;
}

export interface ILegacyCredentialState {
  readonly token: string;
  readonly email: string;
  readonly gitUserName: string;
}

export class IToolState extends e.Context.Tag("IToolState")<IToolState, {
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readActiveUserEmail: e.Effect.Effect<e.Option.Option<string>>;
  readonly writeActiveUserEmail: (email: string) => e.Effect.Effect<void>;
  readonly readLegacyCredentialState: e.Effect.Effect<e.Option.Option<ILegacyCredentialState>>;
  readonly readReadOnlyTokenState: (email: string) => e.Effect.Effect<e.Option.Option<IReadOnlyTokenState>>;
  readonly writeReadOnlyTokenState: (email: string, state: IReadOnlyTokenState) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (email: string, token: string) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
}>() {}
