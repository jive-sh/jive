import * as e from "effect";
import { GITHUB_KEY_PREFIX } from "./constants";
import { promptText, promptYesNo, selectOne } from "./prompts";
import type { GitHubJiveKeyInventory, YubiKeyJiveKey } from "./types";

const logInfoSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.log(...message));
};

interface SelectOrCreateJiveKeyInput {
  yubiKeys: YubiKeyJiveKey[];
  githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>;
  verifiedEmails: string[];
  githubEmail: string;
  createResidentJiveKey: (name: string) => Promise<e.Option.Option<YubiKeyJiveKey>>;
}

export async function selectOrCreateJiveKey(
  input: SelectOrCreateJiveKeyInput,
): Promise<e.Option.Option<YubiKeyJiveKey>> {
  const { yubiKeys, githubJiveKeys, verifiedEmails, githubEmail, createResidentJiveKey } = input;
  const verifiedLower = new Set(verifiedEmails.map((email) => email.toLowerCase()));
  const matchingKeys = yubiKeys.filter((key) => verifiedLower.has(key.email.toLowerCase()));

  if (yubiKeys.length === 0) {
    return createNewJiveKeyForEmail(verifiedEmails, githubEmail, createResidentJiveKey);
  }

  if (matchingKeys.length === 0) {
    logInfoSync("these are the following jive keys on your yubikey");
    for (const key of yubiKeys) {
      logInfoSync(`- ${key.name} (${describeGitHubPresenceForName(key.name, githubJiveKeys)})`);
    }

    logInfoSync("none of these match any verified emails in your github account");
    printVerifiedEmailList(verifiedEmails);

    const shouldReuse = await promptYesNo("do you want to reuse one of these yubikeys? [y/N]: ");
    if (shouldReuse) {
      return promptForKeySelection(yubiKeys, githubJiveKeys);
    }

    return createNewJiveKeyForEmail(verifiedEmails, githubEmail, createResidentJiveKey);
  }

  const preferredName = `${GITHUB_KEY_PREFIX}${githubEmail}`;
  const preferred = matchingKeys.find((key) => key.name === preferredName);
  const fullyMatched = matchingKeys.filter((key) => {
    const status = getGitHubPresenceForName(key.name, githubJiveKeys);
    return status.hasAuth && status.hasSigning;
  });

  if (preferred) {
    const preferredStatus = getGitHubPresenceForName(preferred.name, githubJiveKeys);
    if (preferredStatus.hasAuth && preferredStatus.hasSigning) {
      return e.Option.some(preferred);
    }
  }

  if (fullyMatched.length === 1) {
    const only = fullyMatched[0];
    if (only) return e.Option.some(only);
  }

  if (fullyMatched.length > 1) {
    logInfoSync("Multiple jive keys on your yubikey already exist as auth and signing keys on GitHub.");
    return promptForKeySelection(fullyMatched, githubJiveKeys);
  }

  if (preferred) return e.Option.some(preferred);

  if (matchingKeys.length === 1) {
    const only = matchingKeys[0];
    if (only) return e.Option.some(only);
  }

  logInfoSync("Multiple jive keys on your yubikey match verified GitHub emails.");
  return promptForKeySelection(matchingKeys, githubJiveKeys);
}

export function printYubiKeyList(keys: YubiKeyJiveKey[]): void {
  logInfoSync("Jive keys on YubiKey:");
  if (keys.length === 0) {
    logInfoSync("- (none)");
    return;
  }

  for (const key of keys) {
    logInfoSync(`- ${key.name}`);
  }
}

export function printGitHubJiveKeyList(auth: Array<{ title: string }>, signing: Array<{ title: string }>): void {
  logInfoSync("Jive auth keys on GitHub:");
  if (auth.length === 0) {
    logInfoSync("- (none)");
  } else {
    for (const key of auth) logInfoSync(`- ${key.title}`);
  }

  logInfoSync("Jive signing keys on GitHub:");
  if (signing.length === 0) {
    logInfoSync("- (none)");
  } else {
    for (const key of signing) logInfoSync(`- ${key.title}`);
  }
}

async function createNewJiveKeyForEmail(
  verifiedEmails: string[],
  githubEmail: string,
  createResidentJiveKey: (name: string) => Promise<e.Option.Option<YubiKeyJiveKey>>,
): Promise<e.Option.Option<YubiKeyJiveKey>> {
  const email = await selectEmailForNewKey(verifiedEmails, githubEmail);
  if (e.Option.isNone(email)) return e.Option.none();

  const name = `${GITHUB_KEY_PREFIX}${email.value}`;
  logInfoSync(`Creating key on yubikey device: ${name}`);
  return createResidentJiveKey(name);
}

async function selectEmailForNewKey(
  verifiedEmails: string[],
  githubEmail: string,
): Promise<e.Option.Option<string>> {
  if (verifiedEmails.length === 0 && githubEmail) {
    return e.Option.some(githubEmail);
  }

  if (verifiedEmails.length === 1) {
    const only = verifiedEmails[0];
    if (only) return e.Option.some(only);
  }

  if (verifiedEmails.length > 1) {
    return selectOne(
      "Select a verified GitHub email for the new key:",
      verifiedEmails,
      (email) => email,
      (email, index) => `${index + 1}. ${email}`,
    );
  }

  const entered = await promptText("No verified emails found via API. Enter email for jive key name: ");
  if (!entered) return e.Option.none();

  return e.Option.some(entered);
}

async function promptForKeySelection(
  keys: YubiKeyJiveKey[],
  githubJiveKeys: e.Option.Option<GitHubJiveKeyInventory>,
): Promise<e.Option.Option<YubiKeyJiveKey>> {
  if (keys.length === 0) return e.Option.none();

  return selectOne(
    "Select a yubikey jive key:",
    keys,
    (key) => key.keyBody,
    (key, index) => `${index + 1}. ${key.name} (${describeGitHubPresenceForName(key.name, githubJiveKeys)})`,
  );
}

function printVerifiedEmailList(verifiedEmails: string[]): void {
  logInfoSync("Verified emails:");
  if (verifiedEmails.length === 0) {
    logInfoSync("- (none)");
    return;
  }

  for (const email of verifiedEmails) {
    logInfoSync(`- ${email}`);
  }
}

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
