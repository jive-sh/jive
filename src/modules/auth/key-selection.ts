import * as e from "effect";
import { selectOne } from "@/prompts";

interface GitHubNamedKey {
  readonly title: string;
}

interface SelectVerifiedEmailInput {
  readonly verifiedEmails: readonly string[];
  readonly discoveredEmail: string;
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

export const printGitHubJiveKeyList = (
  auth: readonly GitHubNamedKey[],
  signing: readonly GitHubNamedKey[],
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* printNamedKeySection("Jive auth keys on GitHub:", auth);
    yield* printNamedKeySection("Jive SSH signing keys on GitHub:", signing);
  });

function printNamedKeySection(
  header: string,
  keys: readonly GitHubNamedKey[],
): e.Effect.Effect<void> {
  return e.Effect.gen(function*() {
    yield* e.Effect.log(header);
    if (keys.length === 0) {
      yield* e.Effect.log("- (none)");
      return;
    }

    for (const key of keys) {
      yield* e.Effect.log(`- ${key.title}`);
    }
  });
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
