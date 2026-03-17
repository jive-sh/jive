import * as e from "effect";
import type { SshKeySource } from "@/modules/ssh/types";

export interface CurrentUserState {
  readonly email: string;
}

export interface IReadOnlyTokenState {
  readonly token: string;
  readonly scope: string;
  readonly tokenType: string;
  readonly gitUserName: string;
  readonly githubAccountId: number;
  readonly githubUsername: string;
  readonly sshKeySource: SshKeySource;
  readonly sshKeyFingerprint: string;
  readonly sshKeyName: string;
  readonly sshKeyPath: string;
  readonly yubiKeySerial: string;
}

export interface IOrgScopedCloneTokenState {
  readonly token: string;
  readonly tokenType: string;
}

export class RepoIdentifier {
  public constructor(
    public readonly org: string,
    public readonly repo: string
  ) {}
  public toString() {
    return `@${this.org}/${this.repo}`;
  }
}

export type RepoIntegrityCompromisedReason = e.Data.TaggedEnum<{
  RepoMissing: {},
  SubmoduleMisconfiguration: {},
  NotAPackage: {}
}>;
export const RepoIntegrityCompromisedReason = e.Data.taggedEnum<RepoIntegrityCompromisedReason>();
export class VerifyRepoIntegrityError extends e.Data.TaggedError("VerifyRepoIntegrityError")<{
  reason: RepoIntegrityCompromisedReason
}> {}

export class IToolState extends e.Context.Tag("IToolState")<IToolState, {
  readonly getRepoPath: (repo: RepoIdentifier) => string;
  readonly requiredCLICommands: readonly string[];
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readCurrentUserState: e.Effect.Effect<e.Option.Option<CurrentUserState>>;
  readonly clearCurrentUserState: e.Effect.Effect<void>;
  readonly writeCurrentUserState: (state: CurrentUserState) => e.Effect.Effect<void>;
  readonly readReadOnlyTokenState: (email: string) => e.Effect.Effect<e.Option.Option<IReadOnlyTokenState>>;
  readonly writeReadOnlyTokenState: (email: string, state: IReadOnlyTokenState) => e.Effect.Effect<void>;
  readonly readOrgScopedCloneTokenState: (email: string, owner: string) => e.Effect.Effect<e.Option.Option<IOrgScopedCloneTokenState>>;
  readonly writeOrgScopedCloneTokenState: (email: string, owner: string, state: IOrgScopedCloneTokenState) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (email: string, token: string) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
  readonly verifyRepoIntegrity: (repo: RepoIdentifier) => e.Effect.Effect<{path: string}, VerifyRepoIntegrityError>;
}>() {}
