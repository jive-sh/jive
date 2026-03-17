# Jive

Jive is a workspace orchestration CLI for teams that want polyrepo ownership with monorepo-like local development ergonomics.

## What It Does

- Loads repos into a shared workspace and wires local development across them
- Automates GitHub auth/browser login and workspace-scoped credential state
- Uses one selected SSH key for both GitHub auth and SSH commit signing
- Provides reusable GitHub Actions build/deploy/test conventions for package repos

## Current Command Surface

Commands with substantive behavior in the current codebase:

- `jive load`
- `jive unload`
- `jive on`
- `jive login`
- `jive whoami`
- `jive daemon`
- `jive version`

Commands that are exposed but still mostly stub/TODO-shaped:

- `jive init`
- `jive create`
- `jive templatize`
- `jive update`

## Workspace Model

Jive treats the presence of `.jive/` as the workspace root. Workspace-managed state stays inside that directory rather than leaking into global user config.

```text
.jive/
  ssh/
    local/
  tmp/
  users/
    current.json
    <email>_yubikey_handle_<id>
    <email>_yubikey_handle_<id>.pub
    <email>/
      readonly-github-clone-token.json
      readonly-org-scoped-@<owner>-repo-token.json
      write-refresh-token.json
  state
```

## Auth Model

- `jive login` uses browser-based GitHub OAuth.
- Fresh auth currently uses two passes: a write-capable token for setup/repair, then a separate persisted read-scope token.
- The user selects a verified GitHub email and then chooses either a workspace-local SSH key or a YubiKey-backed resident key.
- The same SSH public key is uploaded to both the GitHub auth-key and SSH-signing-key registries.
- Local keys live under `.jive/ssh/local/`.
- YubiKey mode requires `ykman`. On macOS, Jive rejects `/usr/bin/ssh-keygen` and expects a full OpenSSH install such as Homebrew’s.

## Repo Transport

- Fetch/pull stays on HTTPS using the local `git-credential-jive` helper.
- Push auth and SSH commit signing use the selected workspace-managed SSH key.

## CI Conventions

Jive ships reusable GitHub Actions pieces for package repos:

- Workflow: `.github/workflows/reusable-pipeline.yml`
- Composite actions: `actions/build`, `actions/deploy`, `actions/unit-tests`

The current reusable pipeline handles build, unit tests, and deploy/integration-test sequencing.

## Direction

Jive’s broader direction is to automate more of the cross-repo coordination burden:

- workspace composition and linking
- semver/version propagation
- template-driven repo creation
- coordinated release and dependency update flows
