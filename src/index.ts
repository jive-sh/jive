import { Effect } from "effect";
import * as path from "path";
import { CLI } from "./cli";
import { localOrgs, localRepos, remoteRepos, findWorkspaceRootSync } from "./config";
import { login } from "./auth";

// Available jive template packages from npm
const availableTemplates = Effect.gen(function *() {
  // TODO: query npm for jive-templates-* packages
  return [] as string[];
});

CLI.new("jive", CLI.DiscreteOptions({
  load: CLI.AsyncOptions(
    localOrgs,
    (org) => CLI.AsyncOptions(
      remoteRepos(org),
      (repo) => CLI.Handle((_) => {
        // TODO: clone repo, link to workspace, bun install
        console.log(`Loading ${org}/${repo}...`);
      })
    )
  ),

  unload: CLI.AsyncOptions(
    localOrgs,
    (org) => CLI.AsyncOptions(
      localRepos(org),
      (repo) => CLI.Handle((_) => {
        // TODO: unlink repo from workspace
        console.log(`Unloading ${org}/${repo}...`);
      })
    )
  ),

  on: CLI.AsyncOptions(
    localOrgs,
    (org) => CLI.AsyncOptions(
      localRepos(org),
      (repo) => CLI.Handle((remaining) => {
        const root = findWorkspaceRootSync();
        if (!root) { console.error("No .jive workspace found."); return; }
        Bun.spawnSync(remaining, {
          cwd: path.join(root, `@${org}`, repo),
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        });
      })
    )
  ),

  create: CLI.AsyncOptions(
    availableTemplates,
    (template) => CLI.Handle(([repo]) => {
      // TODO: scaffold repo from template, create on GitHub, link to workspace
      console.log(`Creating ${repo} from template ${template}...`);
    })
  ),

  templatize: CLI.AsyncOptions(
    localOrgs,
    (org) => CLI.AsyncOptions(
      localRepos(org),
      (repo) => CLI.Handle(([templateName]) => {
        // TODO: extract template definition from existing repo instance
        console.log(`Templatizing ${org}/${repo} as ${templateName}...`);
      })
    )
  ),

  login: CLI.Handle(async (_) => {
    await login();
  }),

  init: CLI.Handle((_) => {
    // TODO: initialize jive in current repo (tsconfig, renovate.json, gitignore, GitHub workflow)
    console.log("Initializing jive...");
  }),

  daemon: CLI.Handle((_) => {
    // TODO: start background daemon that keeps loaded repos on mainline up-to-date
    console.log("Daemon not yet implemented.");
  }),
}));
