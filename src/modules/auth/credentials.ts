import * as fs from "fs";
import * as path from "path";
import * as e from "effect";
import { ModuleDependenciesLive } from "../runtime";
import { IToolState } from "../tool-state/interface";
import { TOOL_NAME } from "../../constants";
import type { Credentials } from "./types";

const USERS_DIR = `.${TOOL_NAME}/users`;
const READ_ONLY_AUTHN_KEY_FILE = "read-only-authn-key";

const runSyncWithModules = <A, E>(effect: e.Effect.Effect<A, E, unknown>) =>
  e.Effect.runSync(
    e.Effect.provide(effect, ModuleDependenciesLive) as e.Effect.Effect<A, E, never>,
  );

type ToolStateApi = {
  readonly workspaceRoot: e.Option.Option<string>;
  readonly inWorkspace: e.Effect.Effect<boolean>;
  readonly readActiveUserEmail: e.Effect.Effect<e.Option.Option<string>>;
  readonly writeActiveUserEmail: (email: string) => e.Effect.Effect<void>;
  readonly readLegacyCredentialState: e.Effect.Effect<e.Option.Option<{ token: string; email: string; gitUserName: string }>>;
  readonly readReadOnlyTokenState: (
    email: string,
  ) => e.Effect.Effect<e.Option.Option<{ token: string; scope: string; tokenType: string; gitUserName: string }>>;
  readonly writeReadOnlyTokenState: (
    email: string,
    state: { token: string; scope: string; tokenType: string; gitUserName: string },
  ) => e.Effect.Effect<void>;
  readonly readWriteRefreshToken: (email: string) => e.Effect.Effect<string>;
  readonly writeWriteRefreshToken: (email: string, token: string) => e.Effect.Effect<void>;
  readonly clearWriteRefreshToken: (email: string) => e.Effect.Effect<void>;
};

const withToolStateSync = <A>(fn: (toolState: ToolStateApi) => e.Effect.Effect<A>): A =>
  runSyncWithModules(
    e.Effect.gen(function*() {
      const toolState = yield* IToolState;
      return yield* fn(toolState);
    }),
  );

const inWorkspace = () => withToolStateSync((toolState) => toolState.inWorkspace);
const readActiveUserEmail = () => withToolStateSync((toolState) => toolState.readActiveUserEmail);
const writeActiveUserEmail = (email: string) =>
  withToolStateSync((toolState) => toolState.writeActiveUserEmail(email));
const readLegacyCredentialState = () =>
  withToolStateSync((toolState) => toolState.readLegacyCredentialState);
const readReadOnlyTokenState = (email: string) =>
  withToolStateSync((toolState) => toolState.readReadOnlyTokenState(email));
const writeReadOnlyTokenState = (
  email: string,
  tokenState: { token: string; scope: string; tokenType: string; gitUserName: string },
) => withToolStateSync((toolState) => toolState.writeReadOnlyTokenState(email, tokenState));
const readWriteRefreshToken = (email: string) =>
  withToolStateSync((toolState) => toolState.readWriteRefreshToken(email));
const writeWriteRefreshToken = (email: string, token: string) =>
  withToolStateSync((toolState) => toolState.writeWriteRefreshToken(email, token));
const clearWriteRefreshToken = (email: string) =>
  withToolStateSync((toolState) => toolState.clearWriteRefreshToken(email));
const workspaceRoot = () =>
  withToolStateSync((toolState) => e.Effect.sync(() => toolState.workspaceRoot));

export function loadCredentials(): e.Option.Option<Credentials> {
  if (!inWorkspace()) return e.Option.none();

  const activeUserEmail = resolveActiveUserEmail();
  if (e.Option.isNone(activeUserEmail)) return e.Option.none();

  return loadCredentialsForUser(activeUserEmail.value);
}

export function saveCredentials(credentials: Credentials): void {
  writeReadOnlyTokenState(credentials.email, {
    token: credentials.readOnlyToken,
    scope: credentials.readOnlyTokenScope,
    tokenType: credentials.readOnlyTokenType,
    gitUserName: credentials.gitUserName,
  });

  if (credentials.writeRefreshToken) {
    writeWriteRefreshToken(credentials.email, credentials.writeRefreshToken);
  } else {
    clearWriteRefreshToken(credentials.email);
  }

  writeActiveUserEmail(credentials.email);
}

export function loadWriteRefreshToken(email: string): string {
  return readWriteRefreshToken(email);
}

export function getReadOnlyAuthKeyPaths(email: string): { privateKeyPath: string; publicKeyPath: string } {
  const root = workspaceRoot();
  if (e.Option.isNone(root)) {
    return { privateKeyPath: "", publicKeyPath: "" };
  }

  const privateKeyPath = path.join(userDirectory(root.value, email), READ_ONLY_AUTHN_KEY_FILE);
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
  };
}

export function loadReadOnlyToken(): string {
  const credentials = loadCredentials();
  if (e.Option.isNone(credentials)) return "";
  return credentials.value.readOnlyToken;
}

function loadCredentialsForUser(email: string): e.Option.Option<Credentials> {
  const tokenState = readReadOnlyTokenState(email);
  if (e.Option.isNone(tokenState)) return e.Option.none();

  const { privateKeyPath, publicKeyPath } = getReadOnlyAuthKeyPaths(email);
  if (!privateKeyPath || !publicKeyPath) return e.Option.none();

  return e.Option.some({
    email,
    readOnlyToken: tokenState.value.token,
    readOnlyTokenScope: tokenState.value.scope,
    readOnlyTokenType: tokenState.value.tokenType,
    readOnlyAuthPrivateKeyPath: privateKeyPath,
    readOnlyAuthPublicKeyPath: publicKeyPath,
    writeRefreshToken: loadWriteRefreshToken(email),
    gitUserName: tokenState.value.gitUserName,
  });
}

function resolveActiveUserEmail(): e.Option.Option<string> {
  const fromActiveFile = readActiveUserEmail();
  if (e.Option.isSome(fromActiveFile)) return fromActiveFile;

  const legacyMigrated = migrateLegacyCredentials();
  if (e.Option.isNone(legacyMigrated)) return e.Option.none();

  return e.Option.some(legacyMigrated.value.email);
}

function migrateLegacyCredentials(): e.Option.Option<Credentials> {
  const legacy = readLegacyCredentialState();
  if (e.Option.isNone(legacy)) return e.Option.none();

  const { privateKeyPath, publicKeyPath } = getReadOnlyAuthKeyPaths(legacy.value.email);
  if (!privateKeyPath || !publicKeyPath) return e.Option.none();

  const migrated: Credentials = {
    email: legacy.value.email,
    readOnlyToken: legacy.value.token,
    readOnlyTokenScope: "repo user read:org",
    readOnlyTokenType: "bearer",
    readOnlyAuthPrivateKeyPath: privateKeyPath,
    readOnlyAuthPublicKeyPath: publicKeyPath,
    writeRefreshToken: "",
    gitUserName: legacy.value.gitUserName,
  };

  saveCredentials(migrated);
  return e.Option.some(migrated);
}

function userDirectory(root: string, email: string): string {
  const canonicalName = sanitizeEmailDirectoryName(email);
  const canonicalPath = path.join(root, USERS_DIR, canonicalName);

  const legacyEncodedName = encodeURIComponent(email.trim().toLowerCase());
  const legacyEncodedPath = path.join(root, USERS_DIR, legacyEncodedName);

  if (canonicalPath !== legacyEncodedPath && fs.existsSync(legacyEncodedPath) && !fs.existsSync(canonicalPath)) {
    try {
      fs.renameSync(legacyEncodedPath, canonicalPath);
    } catch {
      // Keep using canonical path; read/write calls will surface errors if migration cannot complete.
    }
  }

  return canonicalPath;
}

function sanitizeEmailDirectoryName(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[\/\\]/g, "_");
}
