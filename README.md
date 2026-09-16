# Jive

Jive is a workspace orchestration CLI for teams that want polyrepo ownership with monorepo-like local development ergonomics.

## Current TODOs

Resume TODOs:
- [ ] startup and k8s

Tooling TODOs:
- [ ] Latest ozy/cli in
- [ ] @jive-sh/dev-utils library with stuff like npm, git, github, etc
- [ ] @jive-sh/cli-builder library
- [ ] Publish jive-template-library
- [ ] Switch ozy/cli and jive-template-library to jive-template-library
- [ ] Switch @jive-sh/jive to jive-template-library
- [ ] Move commands to @jive-sh/jive with updated logic
- [ ] Background agent registration logic
- [ ] Jive server deployed
- [ ] Discord app and Github app accepting webhooks
- [ ] Software factory online without packages
- [ ] Software factory with packages

## What It Does

- Loads repos into a shared workspace and wires local development across them
- Automates GitHub auth/browser login and workspace-scoped credential state
- Uses one selected SSH key for both GitHub auth and SSH commit signing
- Provides reusable GitHub Actions build/deploy/test conventions for package repos

## Current Command Surface

Commands with substantive behavior in the current codebase:

- `jive pkg load [github package]`
- `jive pkg unload [npm package]`
- `jive pkg on *npm`
= `jive pkg save *`
- `jive user login`
- `jive user whoami`
- `jive daemon` # we don't want this anymore it should be a separate entrypoint
- `jive self version`

Commands that are exposed but still mostly stub/TODO-shaped:

- `jive init`
- `jive pkg create [template] [github package]`
- `jive pkg templatize [npm package] [template]`
- `jive pkg update *`
- `jive self update`
- `jive pkg rename [npm package] [npm package]`

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

Jive's [reusable pipeline](.github/workflows/reusable-pipeline.yml) invokes package-owned
scripts for configuration, build, audit, artifact upload, URL resolution, and deployment.
All hooks consume the same `JIVE_CICD_INPUT` JSON environment variable.

See [CI/CD Script API](CICD_API.md) for every hook's input, output, execution conditions,
and examples, and the [input schema](.github/cicd-input.schema.json) for the shared boundary.

## Direction

Jive’s broader direction is to automate more of the cross-repo coordination burden:

- workspace composition and linking
- semver/version propagation
- template-driven repo creation
- coordinated release and dependency update flows
