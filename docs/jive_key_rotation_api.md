# Key rotation: the connector call (draft for agreement, not built)

**Status (2026-11-03):** proposed shape, for the command thread to agree before anything is built. Nothing here exists
in code yet.

**Why (Alex, 2026-11-01):** "when someone signs up, they can create public keys but they don't make new ssh keys.
Jive will manage key rotation. Connectors must expose an API which allows for key rotation".

So each account's key is made at sign-up (`@jive-sh/server` 0.11.0, `auth:register`), and Jive alone replaces it.
An outside system that holds a copy of the public key has to learn about the new key and forget the old one. The
copies live on, for example, GitHub's SSH authentication keys and SSH signing keys. Each connector to such a system
exposes one standard call for that.

## The call: `keys.syncPublicKeys`

A connector whose system holds copies of Jive keys exposes this action in the module `keys`, as every resource
exposes `resource.ensureInstance`. It is declarative: Jive says exactly which of its public keys the system should
hold for one owner, and the connector adds what's missing and removes what Jive put there before and no longer lists.
It never touches a key it didn't add. The design page decided the same pattern for DNS (`setRecords`, open decision
"DNS API shape", option recommended there).

```ts
// args
{
  owner: {
    id: string;          // stable: the Jive account id whose keys these are
    label: string;       // what the outside system shows, e.g. "jive.sh fir-brick-lens"
  };
  keys: Array<{
    publicKey: string;   // OpenSSH line, e.g. "ssh-ed25519 AAAA… fir-brick-lens@jive.sh"
    usages: Array<"authentication" | "signing">;  // GitHub keeps the two as separate lists
  }>;
  account: ConnectorAccount; // the connection's credential, passed on every call as ensureInstance's is
}

// answers
| { status: "synced"; held: Array<{ publicKey: string; usage: "authentication" | "signing"; externalId: string }> }
| { status: "personNeeded"; reason: string; url: string }  // the system wants a person first, e.g. GitHub's sudo prompt
| { status: "refused"; reason: string }                    // e.g. a key type or usage the system doesn't support
```

- **Idempotent.** The same arguments twice change nothing the second time.
- **Owner-scoped.** The component records which keys it added for which owner (its own table, as the npm connector
  records packages), and removes only those. A key a person added by hand stays.
- **`held`** is what the system holds for the owner after the call: one entry per key and usage, with the
  system's own id. Jive checks it before moving on.

## How Jive rotates with it (server side, after this is agreed)

1. Mint the new key in `accountKeys`; the old one keeps signing.
2. For every connection whose system holds this account's keys: `syncPublicKeys` with **both** keys. Both work during
   the overlap.
3. Once every connection answers `synced`, switch `ssh:sign` to the new key. `ssh:publicKey` then returns it.
4. `syncPublicKeys` with **only the new key** on each connection, which removes the old copies.
5. Delete the old private key.

A step that answers `personNeeded` or `refused` stops the rotation at that step: the old key keeps working, and the
rotation resumes from there on the next run. That makes it a durable workflow with one step per connection.

## Where it lives

- **The type:** in `jive-abstract-resource-connector`, exported as `KeyHoldingConnectorApi<Account>`. Kinds of
  connector whose systems hold keys put it in their contract, so the build checks every implementation. An example
  is the code-repository kind, for GitHub.
- **Which connectors implement it:** connectors whose systems hold no copy of a Jive key don't expose it. The npm
  registry connector holds none of the SSH key. It holds the organization's signing passkey, but npm accepts no
  assertion without a browser, so that key isn't covered here (see open question 2).

## Open questions, with defaults in effect

1. **Name.** Default: `keys.syncPublicKeys`, which says what it does (make the system match). The alternative is
   `keys.rotate(old, new)`, an imperative pair of calls that leaves removal to a second call.
2. **Passkeys.** Default: SSH keys only. A WebAuthn credential registered on a site (npm's security key) can't be
   replaced through an API; the site wants a browser ceremony. So its rotation would answer `personNeeded` every time.
3. **Overlap length.** Default: no fixed wait. Step 4 runs as soon as step 3 is done, since nothing outside Jive signs
   with the old key.
