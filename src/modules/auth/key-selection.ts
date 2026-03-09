import * as e from "effect";
import { GITHUB_KEY_PREFIX } from "@/modules/auth/constants";
import { selectOne } from "@/modules/auth/prompts";
import type { GitHubJiveKeyInventory, YubiKeyJiveKey } from "@/modules/auth/types";

interface SelectVerifiedEmailInput {
  readonly verifiedEmails: readonly string[];
  readonly discoveredEmail: string;
}

interface SelectOrCreateJiveKeyInput {
  readonly yubiKeys: readonly YubiKeyJiveKey[];
  readonly githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>;
  readonly selectedEmail: string;
  readonly createResidentJiveKey: (name: string) => e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>>;
}

export const selectVerifiedEmail = (
  input: SelectVerifiedEmailInput,
): e.Effect.Effect<e.Option.Option<string>> =>
  e.Effect.gen(function*() {
    const verifiedEmails = dedupeEmails(input.verifiedEmails);
    if (verifiedEmails.length === 0) {
      yield* e.Effect.logError(
        "No verified GitHub emails were returned for this account. Add a verified email on GitHub and run login again.",
      );
      return e.Option.none();
    }

    const preferredEmail = resolvePreferredEmail(verifiedEmails, input.discoveredEmail);
    if (verifiedEmails.length === 1) {
      const only = verifiedEmails[0]!;
      return e.Option.some(only);
    }

    return yield* selectOne(
      "Select the verified GitHub email to use with Jive:",
      verifiedEmails,
      (email) => email.toLowerCase(),
      (email, index) => {
        const suffix = preferredEmail === email ? " (GitHub profile email)" : "";
        return `${index + 1}. ${email}${suffix}`;
      },
    );
  });

export const selectOrCreateJiveKey = (
  input: SelectOrCreateJiveKeyInput,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>> =>
  e.Effect.gen(function*() {
    const { yubiKeys, githubJiveKeys, selectedEmail, createResidentJiveKey } = input;
    const targetName = `${GITHUB_KEY_PREFIX}${selectedEmail}`;
    const matchingKeys = yubiKeys.filter((key) => key.name === targetName);

    if (yubiKeys.length === 0) {
      return yield* createNewJiveKeyForEmail(selectedEmail, createResidentJiveKey);
    }

    if (matchingKeys.length === 0) {
      yield* e.Effect.log(`No resident YubiKey jive key exists yet for ${selectedEmail}.`);
      return yield* createNewJiveKeyForEmail(selectedEmail, createResidentJiveKey);
    }

    const fullyMatched = matchingKeys.filter((key) => {
      const status = getGitHubPresenceForName(key.name, githubJiveKeys);
      return status.hasAuth && status.hasSigning;
    });

    if (fullyMatched.length === 1) {
      const only = fullyMatched[0];
      if (only) return e.Option.some(only);
    }

    if (fullyMatched.length > 1) {
      yield* e.Effect.log(`Multiple resident YubiKey keys already match ${selectedEmail} and GitHub.`);
      return yield* promptForKeySelection(fullyMatched, githubJiveKeys);
    }

    const partiallyMatched = matchingKeys.filter((key) => {
      const status = getGitHubPresenceForName(key.name, githubJiveKeys);
      return status.hasAuth || status.hasSigning;
    });

    if (partiallyMatched.length === 1) {
      const only = partiallyMatched[0];
      if (only) return e.Option.some(only);
    }

    if (matchingKeys.length === 1) {
      const only = matchingKeys[0];
      if (only) return e.Option.some(only);
    }

    yield* e.Effect.log(`Multiple resident YubiKey keys exist for ${selectedEmail}.`);
    return yield* promptForKeySelection(matchingKeys, githubJiveKeys);
  });

export const printYubiKeyList = (keys: YubiKeyJiveKey[]): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log("Jive keys on YubiKey:");
    if (keys.length === 0) {
      yield* e.Effect.log("- (none)");
      return;
    }

    for (const key of keys) {
      yield* e.Effect.log(`- ${key.name}`);
    }
  });

export const printGitHubJiveKeyList = (
  auth: Array<{ title: string }>,
  signing: Array<{ title: string }>,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log("Jive auth keys on GitHub:");
    if (auth.length === 0) {
      yield* e.Effect.log("- (none)");
    } else {
      for (const key of auth) yield* e.Effect.log(`- ${key.title}`);
    }

    yield* e.Effect.log("Jive signing keys on GitHub:");
    if (signing.length === 0) {
      yield* e.Effect.log("- (none)");
    } else {
      for (const key of signing) yield* e.Effect.log(`- ${key.title}`);
    }
  });

const createNewJiveKeyForEmail = (
  selectedEmail: string,
  createResidentJiveKey: (name: string) => e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>>,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>> =>
  e.Effect.gen(function*() {
    const name = `${GITHUB_KEY_PREFIX}${selectedEmail}`;
    yield* e.Effect.log(`Creating key on YubiKey device: ${name}`);
    return yield* createResidentJiveKey(name);
  });

const promptForKeySelection = (
  keys: YubiKeyJiveKey[],
  githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>> => {
  if (keys.length === 0) return e.Effect.succeed(e.Option.none());

  return selectOne(
    "Select a YubiKey jive key:",
    keys,
    (key) => key.keyBody,
    (key, index) => `${index + 1}. ${key.name} (${describeGitHubPresenceForName(key.name, githubJiveKeys)})`,
  );
};

function describeGitHubPresenceForName(
  keyName: string,
  githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>,
): string {
  const { hasAuth, hasSigning, inventoryAvailable } = getGitHubPresenceForName(keyName, githubJiveKeys);
  if (!inventoryAvailable) return "github keys unavailable";

  if (hasAuth && hasSigning) return "auth+signing on github";
  if (hasAuth) return "auth on github";
  if (hasSigning) return "signing on github";
  return "not on github";
}

function getGitHubPresenceForName(
  keyName: string,
  githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>,
): { hasAuth: boolean; hasSigning: boolean; inventoryAvailable: boolean } {
  if (e.Option.isNone(githubJiveKeys)) {
    return { hasAuth: false, hasSigning: false, inventoryAvailable: false };
  }

  const hasAuth = githubJiveKeys.value.auth.some((entry) => entry.title === keyName);
  const hasSigning = githubJiveKeys.value.signing.some((entry) => entry.title === keyName);
  return { hasAuth, hasSigning, inventoryAvailable: true };
}

function dedupeEmails(emails: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const email of emails) {
    const normalized = email.trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function resolvePreferredEmail(verifiedEmails: readonly string[], discoveredEmail: string): string {
  const normalizedDiscovered = discoveredEmail.trim().toLowerCase();
  if (!normalizedDiscovered) return "";

  return verifiedEmails.find((email) => email.trim().toLowerCase() === normalizedDiscovered) ?? "";
}
