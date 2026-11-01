# Jive: Architecture, Package Model, Workflows, and Product Vision

**Conversation record and evolving design notes**  
**Through:** October 26, 2026  
**Scope:** An extensive synthesis of our Jive conversations, especially the sequence from agent sessions/channels through the universal npm package model, dependency injection, resource instances, and visual organization builder.

> **Status of this document:** This is a design-history and working-specification document, **not** an assertion that all features exist in the codebase or that all design suggestions were accepted. It deliberately distinguishes ideas explicitly raised by you, directions you appeared to favor, and alternatives suggested during our discussion. Code is illustrative unless stated otherwise.

## Contents

1. [Executive framing](#1-executive-framing)
2. [How the architecture evolved](#2-how-the-architecture-evolved)
3. [Jive's intended capability surface](#3-jives-intended-capability-surface)
4. [The universal npm package model](#4-the-universal-npm-package-model)
5. [Interface specialization, implementations, and initialization](#5-interface-specialization-implementations-and-initialization)
6. [Two dependency maps: interfaces and instances](#6-two-dependency-maps-interfaces-and-instances)
7. [Worked example: a library and an npm package registry](#7-worked-example-a-library-and-an-npm-package-registry)
8. [Runtime boundary: local/CI scripts and Convex-backed connectors](#8-runtime-boundary-localci-scripts-and-convex-backed-connectors)
9. [Organizations, resources, resource IDs, and projects](#9-organizations-resources-resource-ids-and-projects)
10. [Visual organization and workforce builder](#10-visual-organization-and-workforce-builder)
11. [Workflow engine and agent orchestration](#11-workflow-engine-and-agent-orchestration)
12. [Agent context: resuming sessions versus reconstructing memory](#12-agent-context-resuming-sessions-versus-reconstructing-memory)
13. [Compute, inference, communication, and isolation](#13-compute-inference-communication-and-isolation)
14. [Knowledge graph, event-driven updates, and dashboards](#14-knowledge-graph-event-driven-updates-and-dashboards)
15. [Jive's original software-development platform](#15-jives-original-software-development-platform)
16. [Self-improvement and evaluation](#16-self-improvement-and-evaluation)
17. [Example end-to-end experiences](#17-example-end-to-end-experiences)
18. [Design principles and tradeoffs](#18-design-principles-and-tradeoffs)
19. [Current decisions, inclinations, and open questions](#19-current-decisions-inclinations-and-open-questions)
20. [Suggested next design exercise](#20-suggested-next-design-exercise)
21. [Glossary](#21-glossary)
22. [Decisions: package model and naming (2026-10-22)](#22-decisions-package-model-and-naming-2026-10-22)
23. [Decisions: central server and local servers (2026-10-26)](#23-decisions-central-server-and-local-servers-2026-10-26)
24. [Decisions: credentials on the server, CI by OIDC (2026-10-26)](#24-decisions-credentials-on-the-server-ci-by-oidc-2026-10-26)
25. [Decisions: the first connector, a three-layer stack (2026-10-26)](#25-decisions-the-first-connector-a-three-layer-stack-2026-10-26)

---

## 1. Executive framing

Jive began as a way to make a collection of independent repositories behave more like a monorepo: local linking, coordinated versioning, compatible version sets, publishing, CI/CD, and deployment orchestration. It has expanded into a proposed **open and programmable platform for creating, operating, and improving agentic workforces**.

An **agentic workforce** is the general primitive. A **software factory** is one specialization, not the platform's universal abstraction. Other workforces may handle reverse engineering, customer support, operational incidents, research, documentation, or broader business processes.

A central ambition is to make Jive accessible from three equivalent surfaces:

- **Visual UI:** Create an organization, choose or assemble workforces, add workflows, connect resources, see live dashboards, and edit configurations.
- **CLI:** Perform the same operations from commands such as `jive create library` or `jive create agentic software factory`.
- **Code/agents:** Manage the same system through real npm packages, TypeScript, manifests, repositories, Git commits, and automated changes.

The important aspiration is **not** a separate no-code system that stores opaque behavior in a database. Visual operations should generate actual, version-controlled code/configuration changes in repositories, and code changes should in turn be reflected in the UI where representation is supported.

Underpinning this is a reusable package ecosystem. Rather than maintaining entirely separate concepts for *templates*, *interfaces*, *connectors*, and *implementations*, the discussion is converging on **one Jive package model**, with optional abilities to declare contracts, extend other packages, depend on other interfaces or already-created instances, and initialize new resources.

A second key abstraction is the distinction between:

- **Package/interface dependencies:** Other code capabilities needed to implement or execute this package.
- **Resource-instance dependencies:** Specific already-created, configured resources to which a project or component must be connected.

These requirements are related but not interchangeable.

---

## 2. How the architecture evolved

This is a history of how the concepts emerged rather than a statement that each intermediate design remains current.

### A. Workflows versus long-lived Claude channels

The initial question was how much Jive should run persistent channels versus simply invoking Claude within a durable workflow. The proposed separation was:

1. **Workflow:** Owns orchestration, triggers, durable progress, retry/recovery, and success criteria.
2. **Agent runtime:** Executes Claude, Codex, or another agent; manages tools and sessions.
3. **Channel:** Delivers messages/events to active agent sessions when live interaction is valuable.

The emerging default: **call agents for bounded tasks**; don't require an always-running conversational session for every long-running business workflow. Channels are optional when an active session truly needs incoming messages or coordination.

A related question was whether an agent resumed with its original session history necessarily outperforms a fresh agent given reconstructed workflow context. The answer was that neither strategy universally wins, and Jive should support and evaluate both.

### B. Broadening the definition of Jive

We consolidated Jive as more than a build tool: agentic workforce creation, arbitrary workflows, reusable integrations, durable knowledge, observability, managed execution, security/isolation, multi-repo development, version sets, automated deployment, and ultimately workflows that improve other workflows.

### C. Templates became concrete npm packages

The original package-discovery idea included packages such as:

```text
jive-template-library                       # Said to already be built
jive-template-agentic-skill                 # Planned
jive-template-agentic-workflow              # Planned
jive-template-agentic-workforce             # Planned
```

The CLI would discover package names in the relevant npm naming scheme and use them to populate `jive create` options. Templates would declare the connector/interface requirements for the projects they create.

### D. Templates, interfaces, and implementations began to merge

You observed that an interface and a template might be aspects of the same package, because each describes the kind of thing that can be created or composed. Various naming possibilities came up:

- `jive-template-*`
- `jive-package-type-*`
- `jive-type-*`
- `jive-interface-*`
- `jive-scaffold-*`
- Plain `jive-*`

You explicitly wanted **few package types**, resisting separate formal categories for template, connector, implementation, and so on.

The proposed simplification was **a single package primitive** with metadata describing what it provides, what it extends/implements, what it depends on, and whether it can initialize something.

### E. Even concrete provider packages can be interfaces

You pointed out that not only broad abstractions, but concrete-looking packages should fit the same model:

```text
jive-chat-slack
jive-chat-discord
jive-agentic-workforce-software-factory
```

The intended command should be as intuitive as:

```bash
jive create agentic software factory
```

That led to describing a concrete provider or specialized workforce as a package that itself **extends/specializes** another interface, rather than belonging to a wholly different package class.

### F. The library exposed the package-versus-instance distinction

The example moved from theoretical workforce composition to an already-built, familiar use case: **a library's deploy script needs access to a package-registry connector**.

Your explicit proposed naming was:

```text
jive-interface-library
jive-interface-connector-package-registry
jive-interface-connector-package-registry-npm
```

This raised a real question: does the library depend on the registry's interface package, or on a particular configured registry instance, and how does a script executing locally/in CI call a connector that may execute in Convex?

### G. Two dependency maps

Your emerging answer was to define two maps on an interface:

```ts
// Conceptual shape; property names are part of the discussion,
// not a finalized released API.
dependsOn: {
  interfaces: {
    // Named requirements for other interface implementations/code
  },
  instances: {
    // Named requirements for specific configured resources
  },
}
```

**In each map, keys are consumer-defined names/roles and values identify interface packages.** At the implementation/configuration level:

- `interfaces` slots are satisfied by packages implementing those interfaces.
- `instances` slots are satisfied by **specific resource GUIDs** that already exist in the project/organization.

Deploy should validate that a referenced GUID **literally exists**; compatibility and access checks were additionally recommended.

### H. Organization-first resource registry

You suggested a common `resources` table with at least `id`, `name`, `interface`, and `impl`, with names unique within an **organization**.

You were leaning toward **organization as the top-level container**, with projects potentially represented as tags/groupings on resources rather than hard ownership boundaries. An earlier alternative was one Convex deployment per project, which introduces unresolved cross-project resource coordination questions.

### I. Visual UI and resource initialization

You described a visual system where someone can initialize an organization, create an agentic workforce, start from a template or from scratch, add workflows, configure connectors, and have these changes produce real code changes behind the scenes.

Then you proposed adding an **`initializable`** field to interfaces, so `jive create` can discover the packages that offer a creation flow without introducing a separate “template” package category.

### J. Final naming discussion in this sequence

You asked whether `jive-scaffold-*` would better describe packages than `jive-interface-*`. The discussion concluded:

- `scaffold` is too narrow for packages that also define behavior/contracts.
- `interface` describes compatibility but arguably under-describes creation and implementation.
- A plain **`jive-*`** naming scheme might best reflect the unified package model.

That was a recommendation, **not a confirmed naming decision**. Your most recently explicit examples still used `jive-interface-*`.

---

## 3. Jive's intended capability surface

### 3.1 Creating and operating organizations

Jive should let users create an organization and manage a network of named resources: workforces, workflows, connectors, knowledge stores, and other capabilities. An organization can reuse a configured connector across multiple consumers instead of creating and authenticating a separate integration for each.

### 3.2 Agentic workforces

An agentic workforce is a programmable collection of roles, skills, agents, workflows, integrations, and operating goals. A software factory is one concrete workforce; another could be an AoE2 decompilation factory or a customer-support organization.

Workforces should be extensible through published npm packages, combinable with multiple implementations of the same interface, and visible through custom real-time dashboards.

### 3.3 Arbitrary durable workflows

Workflows are defined in code, not restricted to a short menu of hard-coded automations. They may:

- Start on a schedule, data change, commit, message, meeting transcript, metric threshold, or manual trigger.
- Invoke agents and deterministic code, sequentially or concurrently.
- Wait for approvals, external messages, or the results of other steps.
- Write intermediate status, metrics, artifacts, and state to Convex. *Settled in [§23](#23-decisions-central-server-and-local-servers-2026-10-26): this is each machine's local Convex; the central Convex syncs workflow definitions.*
- Recover from failed agents, interrupted compute, or deployment changes.
- Interact through reusable connectors and generate new code or resources.

The basic Jive philosophy is that a business process should be a running, inspectable, maintainable workflow instead of a fragile chain of manual procedures.

### 3.4 Extensible external integrations

Planned contract families have included:

- Messaging/chat channels (Slack, Discord, etc.).
- Source-control hosts (GitHub, GitLab, etc.).
- Package registries (npm, GitHub Packages, etc.).
- Ticket/issue systems (GitHub Issues, Linear, etc.).
- Agentic subscriptions and inference-related providers.
- Agent runtimes (Claude, Codex, etc.).
- Compute runtimes (Fly.io Sprites/Machines, local runtimes).
- Knowledge bases and memory systems.

The precise boundaries of “agentic subscription” remain an open design topic. It may represent a subscription-backed model/agent capability rather than merely a raw model API. In any event, one workforce might depend on **multiple** such subscriptions.

### 3.5 Data, knowledge, and evaluation

The system should accumulate and update operational knowledge; use execution histories and verification outcomes as evidence; and potentially improve workflows through a meta-workflow that analyzes organizational goals and actual outcomes.

### 3.6 Software development and deployment

Jive retains its roots: coordinated polyrepo development, package discovery, local linking, semantic versioning, compatible version sets, CI, npm publication, preview environments, staged deployment, and reusable deployment adapters/scripts.

---

## 4. The universal npm package model

### 4.1 The design goal: very few categories

You explicitly said you do **not** want too many types of packages. The strongest direction from the conversation is:

> **Every Jive package is the same general kind of package.** It may describe an interface contract, implement or specialize another interface, define named requirements, expose executable behavior, and optionally supply an initialization/scaffolding flow.

This is a unified **package mechanism**, even if particular packages have different roles.

Thus a library, Slack channel, npm registry connector, agentic workflow, and software factory do not each need bespoke package infrastructure.

### 4.2 Naming options explored

> **Superseded by [§22](#22-decisions-package-model-and-naming-2026-10-22):** the ecosystem prefixes are `jive-abstract-`, `jive-connector-` and `jive-agentic-` (§22.6), and `jive-template-*`, `jive-interface-*` and plain `jive-*` were rejected for the reasons in §22.11.

| Scheme | What it emphasizes | Concern discussed |
| --- | --- | --- |
| `jive-template-*` | Creating starter code/projects | Too narrow for connectors and contracts |
| `jive-scaffold-*` | Code generation | Still too narrow for operational components |
| `jive-package-type-*` | Generic type definitions | Verbose; ambiguous distinction from implementations |
| `jive-type-*` | Types with optional scaffolding | Potentially a good description, but still categorical |
| `jive-interface-*` | Compatibility and API contracts | Concrete provider packages also need to participate |
| `jive-*` | Universal Jive package | Shortest; requires manifest metadata for meaning |

An illustrative plain-name family would be:

```text
jive-library
jive-agentic-skill
jive-agentic-workflow
jive-agentic-workforce
jive-agentic-workforce-software-factory
jive-connector-package-registry
jive-connector-package-registry-npm
jive-connector-chat-slack
jive-connector-chat-discord
```

Your explicit `jive-interface-*` family remains valid as an alternative:

```text
jive-interface-library
jive-interface-connector-package-registry
jive-interface-connector-package-registry-npm
jive-interface-agentic-workforce
jive-interface-agentic-workforce-software-factory
```

**Undecided:** final prefix, reserved namespace policy, and discovery/catalog design.

### 4.3 A package may be both a provider and a consumer

For example, an npm registry connector:

- Specializes/implements the package-registry contract.
- Might declare its own dependencies (credentials, transport, external provider configuration).
- Can include runtime code and initialization/configuration support.

A software factory:

- Specializes the agentic-workforce contract.
- Declares requirements for source control, messaging, agent subscriptions, knowledge, workflows, etc.
- May initialize a repository and generate workflow code.

There is no reason for these to require distinct fundamental package systems.

### 4.4 Specialization is distinct from composition

A key clarification from our conversation was:

- **Extends/implements:** Says a package satisfies or specializes a compatible contract.
- **Depends on:** Says a package needs other code or resources to operate.

For example:

```text
jive-agentic-workforce-software-factory
  extends → jive-agentic-workforce
  depends on → source-control connector
  depends on → chat connector
  depends on → coding-agent subscription
```

The software factory **is a kind of** workforce, while its connector bindings **are dependencies of** the workforce. Treating both edges as one generic relation would lose important validation semantics.

### 4.5 The manifest is the real abstraction

A possible high-level shape, combining the ideas raised, is:

```ts
// Illustrative only: not a settled API.
defineJivePackage({
  name: "jive-agentic-workforce-software-factory",

  extends: "jive-agentic-workforce",

  initializable: true,

  dependsOn: {
    interfaces: {
      // code-level capabilities
    },
    instances: {
      // configured resource requirements
    },
  },

  // Optional creation/scaffolding logic
  create: async (context) => {
    // ...
  },

  // Optional scripts, runtime APIs, and configuration schemas
});
```

Important: whether `extends` permits exactly one parent, multiple parents, or a separate `implements` set **has not been decided**. The examples illustrate the intent, not a firm type-system commitment.

---

## 5. Interface specialization, implementations, and initialization

### 5.1 A concrete implementation is still an interface package

You challenged the initial division where `jive-interface-chat-channel` was an interface and `jive-chat-slack` was an entirely different class of implementation package. Your preference was that the latter should **also be an interface package** (or, more generally, an ordinary Jive package):

```text
chat-channel
  ├── chat-slack
  └── chat-discord

agentic-workforce
  └── agentic-workforce-software-factory
```

This supports a browsable hierarchy of progressively more specialized packages. In an interface hierarchy, compatibility is transitive when the specialization truly satisfies the parent's contract.

### 5.2 `initializable` replaces the separate template concept

> **Superseded by [§22](#22-decisions-package-model-and-naming-2026-10-22):** `jive create` lists every package named `jive-abstract-*` (§22.5), so no `initializable` flag is needed.

Your proposal:

```ts
initializable: true
```

means the interface/package advertises a creation experience. `jive create` discovers initializable choices instead of looking only for a separate `jive-template-*` category.

For example:

```bash
jive create library
jive create agentic workflow
jive create agentic software factory
```

The CLI can resolve the words to an appropriate package, ask for configuration, resolve dependencies, run initialization logic, generate code and/or provision a resource, and register the created item.

One subtlety remains open: **creation eligibility versus concreteness**. An abstract package-registry contract could offer `initializable: true` to initiate a wizard that chooses npm or GitHub Packages; that does not necessarily mean the abstract contract itself can run as a concrete connector.

### 5.3 What exactly is initialized?

Different packages might initialize different things:

- `library`: repository, package metadata, build scripts, deploy script, and registry dependency binding.
- `agentic-workflow`: source files, entry points, Convex workflow definitions, metrics, and tests.
- `agentic-workforce-software-factory`: a collection of workflows, agent roles, repository bindings, and dashboards.
- `connector-package-registry-npm`: a configured resource with provider-specific settings/permissions, potentially no new application repository.

This suggests `initializable` describes a **capability of the package**; it does not imply that all initialization procedures result in the same artifact type.

### 5.4 How the CLI gets creation options

> **Superseded by [§22](#22-decisions-package-model-and-naming-2026-10-22):** `jive create` queries npm for names starting with `jive-abstract-` and splits them on hyphens into an autocomplete tree (§22.5).

The original discovery idea was searching npm for `jive-template-*`. Later, we discussed deriving the `jive create` catalog from packages with initialization metadata and their specialization hierarchy.

**Not settled:** Direct public-npm lookup versus a curated/registered catalog, how package metadata gets indexed, how to establish trust, or how to map user-friendly phrases to package names. But the desired UX is explicit: `jive create agentic software factory` should work.

---

## 6. Two dependency maps: interfaces and instances

This is the most concrete new modeling decision from the latest exchanges.

### 6.1 Both maps are named slots

An interface package declares two different sets of requirements:

```ts
// Shape proposed during discussion.
dependsOn: {
  interfaces: {
    customSlotName: "other-jive-interface-package",
  },
  instances: {
    anotherCustomSlotName: "required-resource-interface-package",
  },
}
```

The **key** is chosen by the consuming package, giving meaning to the role. The **value** is an interface package/contract that an implementation or configured resource must satisfy.

This is more flexible than having a package simply depend on one hard-coded vendor name. For example:

```ts
dependsOn: {
  interfaces: {
    compiler: "jive-interface-build-tool",
  },
  instances: {
    engineeringChat: "jive-interface-connector-chat",
    customerChat: "jive-interface-connector-chat",
    primaryAgent: "jive-interface-agentic-subscription",
    backupAgent: "jive-interface-agentic-subscription",
  },
}
```

Two different slots can require the same interface because they serve different purposes.

### 6.2 `dependsOn.interfaces`: select a package implementation

At configuration/implementation time, the `interfaces` map can be satisfied by concrete **npm packages** that implement/specialize the required interface.

Illustration:

```ts
// Requirement
interfaces: {
  compiler: "jive-interface-build-tool",
}

// Resolution
interfaces: {
  compiler: "jive-build-bun",
}
```

This is a code-level dependency. The consuming code may import or execute functionality provided by the chosen package.

An important open question is exactly what is meant by `implements` in a world where every package can itself be an interface/specialization, and how package versions are selected.

### 6.3 `dependsOn.instances`: select a specific configured resource

At configuration/implementation time, the `instances` map should resolve to **actual resource IDs**, not merely npm package names.

Illustration:

```ts
// Requirement
instances: {
  registry: "jive-interface-connector-package-registry",
}

// Binding
instances: {
  registry: "550e8400-e29b-41d4-a716-446655440000",
}
```

That GUID represents something already created/configured within the organization/project: for example, an npm package-registry connector using a particular account, registry URL, and authentication mechanism.

You specifically said deploy should validate that these GUIDs **actually exist**. Additional sensible validation discussed included confirming the referenced resource satisfies the required interface and that the current project has permission to use it.

### 6.4 Declared dependencies versus resolved dependencies

| Dimension | Declared on interface/package | Resolved on consuming implementation/configuration |
| --- | --- | --- |
| `interfaces` | Named slot → required interface package | Named slot → selected implementation package |
| `instances` | Named slot → required interface package | Named slot → specific resource GUID |

The **same slot names** bridge the two levels. This makes it possible for a generic package to describe its needs before knowing a provider, tenant, or resource ID.

### 6.5 A single type may appear repeatedly

This structure explicitly accommodates:

- Two Slack channels, configured differently.
- Slack for engineering and Discord for customers.
- Primary and backup agent subscriptions.
- A knowledge base that compares two or more stores.
- The same connector instance reused in more than one slot, if appropriate.

The choice of whether to provide one or several resources belongs to the **consumer's dependency slots and their bindings**, not to an intrinsic limitation of the interface package.

### 6.6 Composite implementations and fan-out

You highlighted a particularly useful pattern: a package implementing a contract can itself depend on one or more instances of that same contract.

For example, a composite knowledge base could satisfy `knowledge-base` while depending on:

```ts
dependsOn: {
  instances: {
    primary: "jive-interface-knowledge-base",
    comparison: "jive-interface-knowledge-base",
  },
}
```

Its implementation could write to both stores, compare quality, fall back when one fails, or benchmark retrieval behavior.

No special “fan-out connector” package category is needed. It is simply a composite ordinary Jive package implementing a contract and binding resources.

However, resource/package dependency graph validation must detect **cycles**. A composite may implement the same contract that it consumes without being allowed to bind itself as its own dependency (directly or through a cycle).

### 6.7 Is a dependency always an instance?

Earlier we debated whether all dependencies should point to configured component instances. The latest proposed split resolves much of that confusion: **some dependencies are package/code selections; others are instance/resource bindings**.

Still open: some selected code packages themselves may need configuration or runtime deployment. It may become useful to have a universal resolution mechanism behind both maps, but this should not erase the semantically important distinction between a package dependency and an existing resource identity.

---

## 7. Worked example: a library and an npm package registry

This was the example that made the design concrete.

### 7.1 Proposed package names

You explicitly suggested:

```text
jive-interface-library
jive-interface-connector-package-registry
jive-interface-connector-package-registry-npm
```

The first is a library-project interface/scaffold; the second specifies a package registry's callable contract; the third specializes/implements that contract for npm.

These names are used in this section to preserve the discussion even if the final ecosystem uses unprefixed `jive-*` names.

### 7.2 Requirement defined by the library

The library's deploy behavior needs a registry resource. An illustrative manifest is:

```ts
// jive-interface-library

defineJivePackage({
  name: "jive-interface-library",
  initializable: true,

  dependsOn: {
    interfaces: {
      buildTool: "jive-interface-build-tool", // illustrative optional example
    },
    instances: {
      registry: "jive-interface-connector-package-registry",
    },
  },
});
```

A crucial distinction: the **package registry** requirement is most naturally in `instances`, because publishing needs a configured registry connection (not merely knowledge that npm code exists).

### 7.3 A registry implementation package

```ts
// jive-interface-connector-package-registry-npm

defineJivePackage({
  name: "jive-interface-connector-package-registry-npm",
  extends: "jive-interface-connector-package-registry",
  initializable: true,

  // npm-specific configuration, methods, and initialization omitted
});
```

The package provides the npm-specific behavior; a **created registry resource** provides a reusable configured instance of that behavior.

### 7.4 Created resource record

Example organization resource:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "organizationId": "org-acme",
  "name": "npm",
  "interface": "jive-interface-connector-package-registry",
  "implementation": "jive-interface-connector-package-registry-npm"
}
```

The UUID is illustrative. The example omits actual credentials, environment settings, ownership metadata, and version pins.

### 7.5 A library's instance binding

```ts
// One possible representation in the created library/project config
const dependencies = {
  interfaces: {
    buildTool: "jive-build-bun",
  },
  instances: {
    registry: "550e8400-e29b-41d4-a716-446655440000",
  },
};
```

Validation should ensure:

1. The package named for `buildTool` exists and satisfies the required build-tool contract.
2. The registry UUID actually exists.
3. The registry resource is compatible with `connector-package-registry`.
4. Its implementation package exists and can provide the required operations.
5. The library's project/principal is allowed to use the resource.
6. The configured environment has the necessary publishing access.

The last three are natural extensions of the existence check, but the design of permissions, versioning, and credential handling remains open.

### 7.6 Deployment script

```ts
// Illustrative local or CI code (not an actual published Jive SDK API)
export async function deploy(ctx: DeployContext) {
  await ctx.dependencies.registry.publish({
    directory: ctx.buildOutput,
  });
}
```

The elegant developer experience is that `deploy` sees a typed **package-registry API**, not provider-specific npm or GitHub Packages implementation details. It should not need to manually look up the registry GUID, decrypt credentials, or dispatch provider-specific behavior.

### 7.7 What `jive create library` should do

One possible end-to-end flow:

1. Resolve an initializable `library` interface package.
2. Ask for library name and creation destination.
3. Resolve code-interface slots such as build tool.
4. Find compatible existing package-registry resources in the organization.
5. Offer to select an existing resource or initialize a new compatible registry connector (e.g. npm).
6. Write resolved bindings and generated source/configuration to a repository.
7. Register relevant resource records.
8. Validate resolution and permissions.
9. Later, run build/deploy in the correct environment using these bindings.

Exactly when resources are created, how they are shared between repositories, and which files hold their IDs have yet to be specified.

*For npm, settled in [§25.6](#256-provisioning-a-new-npm-package-2026-10-26): provisioning a new package publishes a blank placeholder as the user's npm account, registers trusted publishing for the package's repository and `pipeline.yml`, and from then on CI publishes every real version through OIDC. So in step 9 the `registry.publish` of §7.6 runs in CI with no npm credential.*

---

## 8. Runtime boundary: local/CI scripts and Convex-backed connectors

You identified a subtle mismatch: **the library's deploy code runs locally or in CI, while a connector may be code running inside Convex**.

This is not just a naming question. The dependency graph needs a concrete execution and transport story.

### 8.1 The environments involved

| Kind of code | Likely environment | Example |
| --- | --- | --- |
| Library build/deploy script | Developer machine or CI runner | Build tarball, publish package |
| Workflow orchestration/state | Convex | Persist task progress, trigger jobs |
| Connector service methods | Potentially Convex component | Query/configure integration, manage credentials |
| Agent process | Isolated compute environment | Claude/Codex tool calls, code edits |
| Provider-native operations | Provider API or CI | npm publication via trusted publishing |

A package's public API need not mandate that every method executes in the same environment. That was an architectural suggestion, **not yet a committed mechanism**.

*Placement settled in [§23](#23-decisions-central-server-and-local-servers-2026-10-26): "Convex" in this table means two servers, a local Convex on each machine running work and showing tasks, and one central Convex syncing workflow definitions and skill-sync data.*

### 8.2 Option considered: typed handles with location-transparent calls

A local deployment script could receive a resolved `registry` handle. Internally:

- Some methods might call an authenticated Convex endpoint/component function.
- Some may execute locally via a provider-specific adapter.
- Some may coordinate setup in Convex and actual publication in CI.

Example:

```ts
await registry.ensurePublisherConfigured({
  repository: ctx.repository,
}); // potentially Convex-backed

await registry.publish({
  directory: ctx.dist,
}); // potentially CI-local
```

This avoids forcing a built artifact to pass through Convex unnecessarily. In npm's trusted-publishing model, direct CI publication with OIDC can be preferable to a connector server proxying the tarball.

### 8.3 What must be resolved in the implementation

An abstract “location-transparent API” is not enough on its own. Jive will need explicit mechanics for:

- Transport: local function import versus authenticated remote request.
- Identity: which user, organization, project, agent, or CI job is calling. *For CI jobs, settled in [§24](#24-decisions-credentials-on-the-server-ci-by-oidc-2026-10-26): a job proves itself to `@jive-sh/server` with its GitHub OIDC id token.*
- Authorization: access to resource instance and particular operations.
- Secrets: where credentials are stored and which execution environments may read/use them. *Settled in [§24](#24-decisions-credentials-on-the-server-ci-by-oidc-2026-10-26): every credential lives in `@jive-sh/server`; CI holds none and asks the server to act through connectors.*
- Serialization: which arguments/results can cross the process boundary.
- Error handling: retries, idempotency, timeouts, cancellation, and partial failure.
- Version compatibility: the caller's installed package version versus deployed connector API version.

These were not finalized. They are the concrete questions raised by the local-deploy/Convex-connector example.

### 8.4 Connector versus agent channel

Two related but distinct concepts appeared in our conversations:

1. **Chat connector:** An external communication provider (Slack, Discord) that a workflow or workforce uses.
2. **Agent channel:** A way of feeding asynchronous external events into a live agent session (for instance, Claude Code Channels).

A Slack connector could potentially provide messages to an agent channel, but these are not automatically the same Jive interface.

---

## 9. Organizations, resources, resource IDs, and projects

### 9.1 Organization-first model

You suggested that Jive have a dedicated resource registry, and questioned whether its top-level container should be a *project* or *organization*.

Your preference was leaning toward **organization** with optional **project tags** attached to resources.

The proposed core is:

```text
Organization
  └── Resources
       ├── workforces
       ├── workflows
       ├── registry connectors
       ├── chat connectors
       ├── knowledge bases
       └── other configured capabilities
```

The motivation is shared resources. One configured npm registry, GitHub connection, or chat service could be reused by multiple libraries/workforces/projects inside the same organization.

### 9.2 Dedicated resources table

At minimum:

```ts
resources: {
  id: string;
  organizationId: string;
  name: string;
  interface: string;
  implementation: string;
}
```

Your stated uniqueness idea: **a resource's `name` is unique per organization**. Its immutable `id` is used for references, so a resource may be renamed without requiring dependents to rewrite all their bindings.

A concrete database may also need implementation version, configuration reference, lifecycle state, creator, environment, timestamps, and access policy. Those were not part of the minimal proposal.

### 9.3 Instance dependencies as resource IDs

The current model implies:

```text
consumer resource/project
  instances.registry = <resource ID for org's npm registry>
  instances.chat     = <resource ID for org's Slack connector>
```

The reference should bind to the stable resource **instance**, not merely the npm package that implements it.

One important distinction is between a *resource instance* and the *npm package implementation* behind it:

- `jive-interface-connector-package-registry-npm`: reusable code/contract package.
- `npm`: a specific organization-scoped resource created from that package, with a stable ID and particular settings.

### 9.4 Optional normalized dependency edges

An earlier suggestion was a table such as:

```ts
resourceDependencies: {
  resourceId: string;
  slot: string;
  dependencyResourceId: string;
}
```

That provides easy reverse-dependency lookup and graph inspection. Whether the actual system stores these bindings in a separate table, in resource config documents, or both is unresolved.

### 9.5 Projects as groupings rather than owners

You considered projects as tags on resources, so the same resource can participate in several projects. This avoids requiring every shared connector to “belong” to exactly one project.

Variants discussed:

1. **Simple tags:** Resources contain project tags/labels.
2. **First-class projects:** Project IDs and memberships are stored explicitly; resources may belong to multiple projects.
3. **A project is itself a Jive resource:** A specialized `jive-project` package groups other resources.

The simplest initial preference was organization as the sole mandatory container; which project representation is ultimately best remains undecided.

### 9.6 Tension with one Convex deployment per project

An earlier idea was to create **one Convex deployment per project**, motivated by isolation and cost attribution.

Organization-global resources introduce a question: a library or workforce in Project A may depend on a registry or messaging resource deployed under Project B, or on a shared organization service. If Convex instances/deployments are not globally addressable, Jive needs a registry, routing, and access mechanism across deployments.

Possible approaches (alternatives, not a chosen design):

- Organization control plane owns the resource registry; workload deployments host their own components.
- Shared connectors live at organization scope; workload deployments call them via authenticated APIs.
- Store logical resource identities separately from deployment-local Convex component IDs.

This is a key unresolved boundary between **logical ownership** (organization/resource) and **physical runtime placement** (Convex deployment/component).

### 9.7 How far this resembles Terraform

You observed that specifying declarative interfaces, concrete instances, dependency graphs, and GUID validations starts to resemble Terraform.

The response distinguished the scope:

- Terraform predominantly reconciles declared infrastructure resources toward desired state.
- Jive is modeling runnable capabilities, executable code, and configured dependencies, with some infrastructure lifecycle implications.

However, if Jive automatically provisions, updates, reconciles, destroys, imports, and detects drift across many external resources, it **will** be taking on substantial Terraform-like responsibility. That may be appropriate eventually, but it is worth deliberately delimiting the v1 lifecycle.

---

## 10. Visual organization and workforce builder

You described a visual experience that would allow someone to:

1. Initialize a new organization.
2. Initialize a new agentic workforce.
3. Choose a template/initializable interface or start from scratch.
4. Add workflows.
5. Connect connectors and choose existing resource instances.
6. Configure roles, dependencies, and other options.
7. Deploy and observe the system.
8. Make later changes through the visual interface, CLI, or agents.

**Behind the scenes, these actions should generate actual code changes in repositories.**

### 10.1 UI, CLI, and agents should share a model

The intended high-level pipeline is:

```text
Visual UI / CLI / Agent
          |
          v
Jive package + resource + dependency model
          |
          v
Generated/updated repository code and configuration
          |
          v
Validation, CI/CD, deployment, resource registration
          |
          v
Running Convex workflows, connectors, and agents
          |
          v
Live dashboards and editable system state
```

This makes Jive a **programmable visual organization builder**, rather than a no-code platform with an opaque custom runtime definition.

### 10.2 Automatic UI generation from packages

A possible benefit of the unified package model is deriving UI directly from package metadata:

- `initializable` → creation catalog entry.
- Specialization/extends → categorized/hierarchical creation choices.
- `dependsOn.interfaces` → implementation-package selectors.
- `dependsOn.instances` → existing-resource selectors, with “create a new one” where supported.
- Config schemas → editable forms.
- Workflow queries/metrics → live dashboards.

This is a design opportunity suggested during the discussion. The exact schema, runtime metadata, and UI-rendering protocol remain unspecified.

### 10.3 Round-trip editing is hard

The largest issue identified was **round-trip editing**:

- GUI operations need to produce code changes.
- Manually written TypeScript/agent-written code may include arbitrary custom logic.
- The GUI should not destroy or misinterpret that custom logic.

A practical design direction was to make **package declarations and dependency graphs** fully structured and round-trippable first, while treating arbitrary workflow logic as code that can be inspected or edited separately.

That is more credible than promising perfect bidirectional visual editing of all JavaScript/TypeScript constructs.

### 10.4 Source of truth split

One proposed separation was:

| Source | Owns |
| --- | --- |
| **Git repositories** | Package and workflow definitions, TypeScript code, intended dependencies, code configuration |
| **Convex / resource registry** | Actual configured resource identities, secret-backed connections, execution state, workflow histories, live data |

Because repo configuration can contain IDs that point to live Convex resources, Jive must check bindings during validation/deploy. Git being source-of-truth for **desired code** does not imply secrets or transient execution state should be committed to Git.

---

## 11. Workflow engine and agent orchestration

### 11.1 Durable workflows are the governing primitive

The strongest general principle from our channels discussion was:

> **A long-running workflow does not require a long-running agent session.**

A workflow may run for months while individual agents execute short tasks and terminate. Convex preserves progress and can trigger new executions when there is new work. *Per [§23](#23-decisions-central-server-and-local-servers-2026-10-26), that is the machine's local Convex; whether Convex's workflow component runs there is not yet verified ([plan §2.4](convex_migration_plan.md#24-does-the-workflow-component-run-on-self-hosted-convex-the-local-servers)).*

The workflow decides when to invoke an agent, what the task is, how to validate its results, when to retry, and what to persist.

### 11.2 Direct invocation is usually the default

Examples of bounded tasks:

- Select an assembly function, produce C/C++, compile, compare, and record result.
- Reproduce a bug, develop a fix, run tests, open a PR.
- Summarize a meeting, post a message, update knowledge state.
- Investigate a production alert, propose a patch, observe deployment results.

For these, the workflow can call the agent runtime with an explicit task and context, then advance the state graph when the agent returns.

### 11.3 Channels for live asynchronous interaction

Persistent/live channels are appropriate where preserving an active session's context and continuously delivering events is useful:

- Ongoing customer conversation.
- A coding agent receiving feedback as it works.
- Operations agent reacting to live alerts.
- Collaboration between agents and humans through messaging.

The channel transports an event/message; it need not be responsible for the durable workflow's business state.

### 11.4 Role of the AgentRuntime interface

An agent runtime adapter might expose the ability to:

- Start a task.
- Resume or continue a previous session where supported.
- Provide tools, context, and environment.
- Consume streamed progress/messages.
- Return outputs and artifacts.
- Cancel or interrupt execution.

Whether these are a single `AgentRuntime`, separate `AgentSession`/`Channel` contracts, or other interfaces is open.

### 11.5 Progress is arbitrary, not prescriptive

You rejected overly fixed “progress” models. A reverse-engineering task may track hundreds of specialized metrics, while another workflow tracks entirely different outcomes.

The goal is for each workflow package to define its own reactive getters/data contract, so a custom page in the Jive web/mobile UI can subscribe through Convex and display domain-specific progress.

---

## 12. Agent context: resuming sessions versus reconstructing memory

You asked whether a durable workflow can supply a fresh agent with enough history—including prior LLM sessions—that it effectively continues where the last agent stopped, and whether this will be cheaper than maintaining an ongoing session.

### 12.1 Strategies considered

| Strategy | Main strength | Main risk |
| --- | --- | --- |
| **Resume old session** | Maximum access to original conversational context and tool history | Context bloat, cache constraints, inherited bad assumptions |
| **Fresh agent + reconstructed memory** | Focused, relevant state with less extraneous history | Missing subtle discoveries or important negative evidence |
| **Fresh agent + full transcript** | Retains most history while starting a new process/session | Cost/context limits; may offer little advantage over resume |
| **Automatic selection** | Can optimize by task and measured performance | Requires instrumentation and evaluation |

An important point from our discussion: the session process and the logical conversation history are not identical. Where a runtime supports persisted session data, resumption may be possible without keeping a process running continuously. **Do not equate an always-running channel with the ability to resume an agent.**

### 12.2 Why reconstruction can match or beat session continuation

A new agent with high-quality state could receive:

- Current workflow objective and expected outputs.
- Current code snapshot and repository references.
- Prior decisions and their rationale.
- Completed and failed attempts.
- Verification traces and known constraints.
- Relevant original transcript excerpts, retrieved on demand.
- Current metrics and next recommended actions.

This can be more effective than blindly supplying a huge conversation polluted by obsolete assumptions and repeated tool outputs. It can also be worse if compression loses a non-obvious observation, so this is an empirical question.

For your AoE2 decompilation workflow, you specifically wanted memory that preserves **failed hypotheses, traces, decisions, and evidence**, not just a high-level “what was done” summary.

### 12.3 Cost discussion

We used a **purely illustrative** Claude Sonnet-style rate example to reason about input costs:

| Input scenario | Illustrative input-token cost |
| --- | ---: |
| Resume 100K tokens, all charged as cache reads at $0.30/M | $0.03 |
| Resume 100K tokens, all charged as uncached input at $3/M | $0.30 |
| Fresh agent with 10K uncached tokens at $3/M | $0.03 |

These were **examples from the earlier discussion, not current verified provider quotes**, and do not include cache writes, output tokens, tool costs, compute, or cache-expiration effects.

The key insight is that **prompt caching can make reusing a large prior context substantially cheaper than naïve “100K tokens each time” arithmetic suggests**. Conversely, a compact reconstructed prompt can be competitive even without cached history.

There is no reason to assume the same strategy wins for every workflow, model, or invocation interval.

### 12.4 Suggested runtime choice

An illustrative config discussed was:

```ts
type ContextStrategy = "resume" | "reconstruct" | "auto";
```

For `auto`, Jive could examine context volume, elapsed time since last use, task similarity, provider cache availability, reconstruction size, and prior eval outcomes.

### 12.5 Evaluate on outcomes, not token count alone

The suggestion was to run comparable AoE2 tasks with resumed and reconstructed contexts, then measure:

- Verified-function success rate.
- Time and retries per verified function.
- Input/output token costs.
- Total cost per successful verification.
- Divergence/regression rate.
- Operator interventions and failure modes.

This is aligned with your broader interest in automatically generated evaluation data from actual workflow execution.

---

## 13. Compute, inference, communication, and isolation

### 13.1 Separate computation from agent orchestration

You've explored keeping **ComputeRuntime** and **AgentRuntime** as independent replaceable contracts.

The agent runtime handles model/agent sessions, tools, and instructions. The compute runtime handles the process, filesystem, isolation, sleep/resume, and lifecycle of the machine/container on which that agent runs.

### 13.2 Fly.io Sprites as tentative v1

You tentatively preferred Fly.io Sprites for agent sessions because of persistent filesystems, sleep/resume, and straightforward isolated runtime semantics. This was a **v1 direction**, not permanent provider lock-in.

Earlier alternatives included Fly.io Machines, local execution, and other sandbox/compute solutions.

### 13.3 Local inference proxy concept

You also explored a Jive background service on a user's own computer that acts as an inference proxy while agent processes/workspaces run remotely.

This raises a potentially third contract family: **InferenceProvider/InferenceGateway**, independent from the compute platform and the agent runtime.

The concept was exploratory. Open design questions include authentication, locality, availability when the home computer sleeps, latency, security, and whether subscription terms permit the intended use.

### 13.4 Secrets and authorization

Relevant ideas discussed across Jive design included:

- A control plane storing encrypted connector credentials.
- Agent-scoped permissions (an agent should access only assigned work and approved integrations).
- Separate per-task workspaces/sandboxes.
- Auditable external operations and code changes.
- Isolation between different organizations' or projects' components.
- Convex components for data encapsulation, subject to correct authorization of exposed functions.

The earlier Cloudflare-layer concept included Workers, D1/KV/Durable Objects, and KEK/DEK credential-encryption techniques. Convex later became the preferred database/workflow foundation, so the final control-plane hosting split is **not** decided by these discussions alone. *Decided in [§23](#23-decisions-central-server-and-local-servers-2026-10-26): the central server is Convex, not Cloudflare. Where credentials live and how CI reaches them: [§24](#24-decisions-credentials-on-the-server-ci-by-oidc-2026-10-26).*

---

## 14. Knowledge graph, event-driven updates, and dashboards

### 14.1 Knowledge as a durable shared asset

Jive's workforce should accumulate knowledge across runs and contributors, including:

- Source code and relationships.
- Repositories, commits, issues, and PRs.
- Meetings, decisions, documentation, and business facts.
- Historical agent sessions and tool results.
- Failed attempts and verification evidence.
- Workflow-specific metrics and state.

The knowledge graph or memory should be usable to build context for fresh agents, not just for search.

### 14.2 Event-driven updates

Examples you've given:

```text
Commit created
  → Update repository knowledge graph

Meeting transcription created
  → Summarize
  → Post to Slack
  → Update knowledge graph

Operational metric crosses threshold
  → Investigate root cause
  → Generate and test fix
  → Approval
  → Deploy
  → Evaluate outcome
```

You have emphasized that the “update documentation/knowledge” activity is itself a Jive workflow rather than a hidden special-case feature of a particular knowledge store.

### 14.3 Storage engines are replaceable

You've considered:

- Convex-native storage/graph representations.
- Qdrant for retrieval/vector indexing.
- TencentDB Agent Memory.
- Other combinations where storage backends can be compared or mirrored.

The final knowledge implementation is not set. Your composite-interface idea directly enables comparing two knowledge stores behind one contract.

### 14.4 Reactive workflow dashboards

Your preferred model resembles Convex components with custom queries and React subscriptions. A workflow defines what data to expose; the Jive frontend renders a workflow-specific interface.

For AoE2, this could include:

- Number/percentage of functions recovered.
- Byte-exact or behaviorally verified equivalence metrics.
- Windows API shims still to implement.
- Decompilation backlog and throughput.
- Regression/differential test failures.

Other workflows would expose different schemas and pages. No fixed generic `percentComplete` is enough.

---

## 15. Jive's original software-development platform

This older functionality remains relevant to the broader workforce architecture.

### 15.1 Polyrepo orchestration

The original vision used Git submodules and local linking to give developers a monorepo-like experience across separately versioned and published packages. Example responsibilities:

- Build packages in dependency order.
- Use local builds of sibling packages during development.
- Publish and install the correct artifacts.
- Handle a package that builds into multiple distributable outputs.
- Keep repositories independent while coordinating updates.

You have emphasized that local linking should test **what is actually shipped**, e.g. built output in `dist/local`, rather than an alternate source-only path that might behave differently from the published package.

### 15.2 Versioning and version sets

Jive's version-management ambitions include:

- Automatic semantic version detection from TypeScript API changes.
- Coordinating multi-repository changes as a logical version set.
- Updating dependent packages when dependencies publish.
- Running tests across the compatible ecosystem before promoting versions.
- Rollback and release-channel/environment management.
- A Renovate-like workflow that intelligently ingests new package versions.

One architectural question raised earlier was whether this version-set ingestion belongs in Jive's minimal core or is itself a package/workflow. Since Jive must understand package dependencies to install interfaces/components, some package-awareness likely belongs in core; higher-order update automation may remain extensible.

### 15.3 CI and release automation

The planned platform can coordinate GitHub Actions and environment-specific workflows for:

- Build, test, and package validation.
- Publishing through npm trusted publishing.
- Preview deployments and branch/PR environments.
- Staging/beta/production promotion and approvals.
- Automated retries as dependent packages become available.
- Provider-specific deployment adapters (Expo, Convex, GitHub Pages, and others were previously discussed).

You preferred letting templates/packages provide ordinary CLIs and scripts rather than insisting all work must happen through custom Jive tool calls.

### 15.4 Creation flow for developer projects

Earlier ideas included:

- `jive create` creates a repository, standard environment/configuration, and metadata.
- Templates declare required provider connections.
- Jive prompts for OAuth/provider binding as needed.
- CI authenticates with short-lived identity where possible (such as GitHub Actions OIDC), potentially deferring external package-registry setup until deployment.

The latest unified `initializable` and `dependsOn` package model should subsume that flow rather than creating a separate template engine.

---

## 16. Self-improvement and evaluation

You have described a higher-order **graph engineer** skill/workflow whose job is to examine the organization's existing workflows, compare results against company goals, and propose or implement changes.

Conceptually:

```text
Organization goals + workflow graph + execution metrics
    → Analyze missing/inefficient behaviors
    → Propose workflow changes
    → Implement/test changes
    → Measure whether objectives improved
    → Repeat
```

For ordinary tasks, Jive can often generate evaluation labels directly from execution: tests pass, binary equivalence holds, an issue stays resolved, a release succeeds.

For meta-workflows (e.g., whether a new workflow organization improves the business), causality is harder. You noted that changes in ultimate company goals may be difficult to attribute to a specific graph-engineering action.

You also explored whether aggregated experience across many Jive installations could improve these higher-order skills, with appropriate data access and privacy considerations still to define.

---

## 17. Example end-to-end experiences

### Example A: Create and publish a library

```bash
jive create library
```

Possible behavior:

1. Discover initializable library package.
2. Generate a repository/package skeleton.
3. Resolve the package's code-level tool requirements.
4. Request a configured package-registry resource.
5. Bind `dependsOn.instances.registry` to an existing npm registry resource ID or offer to create one.
6. Generate deploy code that calls the abstract package-registry contract.
7. Commit repository code/configuration.
8. Build in local/CI and validate referenced resource GUIDs.
9. Publish using the selected registry's supported mechanism.

### Example B: Initialize an agentic software factory

```bash
jive create agentic software factory
```

Possible behavior:

1. Resolve the specialized software-factory package, extending agentic workforce.
2. Show/accept a creation configuration (organization, name, workflows/roles).
3. Resolve source-control host, messaging, model subscriptions, knowledge-base and other named dependency slots.
4. Select existing resource instances or initialize new ones.
5. Create a workforce resource with its own stable ID.
6. Generate/revise repo code for workflow definitions, agent roles, schemas, and dashboards.
7. Commit/deploy, then show live state and controls in Jive.
8. Let the workforce handle tickets through implementation, testing, review, deployment, and monitoring.

No assumption is made here that an entire workforce must run as one permanently active Claude session; that was a central topic in our channel discussion.

### Example C: Composite knowledge-base interface

An implementation of `knowledge-base` declares two resource-instance slots of type `knowledge-base`:

```text
composite-knowledge-base
  primary    → convex-knowledge-resource-id
  comparison → qdrant-knowledge-resource-id
```

It can mirror writes, compare retrieval results, measure differences, and provide a common caller API. This is a normal instance of the same package/dependency model; it doesn't require a separate category of “comparison service.”

### Example D: AoE2 decompilation workforce

```text
Choose function(s)
  → Inspect original assembly and traces
  → Generate/recover C or C++
  → Compile and link
  → Compare output and runtime behavior
  → Save evidence and failure hypotheses
  → Update Convex metrics/dashboard
  → Select next task
```

An individual agent may stop after a task. A later agent can either resume an available session or reconstruct its working context from saved workflow state and memory.

### Example E: Visual modification of a running organization

A user opens the organization UI, adds a second chat connector, binds it to a workforce's customer-support slot, and enables a new workflow.

Intended effect:

1. Create/configure the new connector resource (if needed).
2. Update the relevant dependency instance GUID in generated project configuration.
3. Add the workflow's package/code and configuration.
4. Generate a repository change/commit/PR as appropriate.
5. Validate interfaces, resource existence, permissions, and build/deploy.
6. Surface newly available workflow-specific queries and dashboards.

The exact point at which the UI writes immediately to Git versus opens a PR is still an open product decision.

---

## 18. Design principles and tradeoffs

### 18.1 One fundamental Jive package mechanism

Avoid splitting the ecosystem into numerous noninteroperable types. Describe capabilities, contracts, specialization, dependencies, and initialization in one extensible manifest/API.

### 18.2 Separate code selection from configured resource identity

A dependency on a package implementing a contract is different from a dependency on a **particular configured instance**. Both can be expressed as named slots requiring an interface, but their resolution differs.

### 18.3 Interfaces can be specialized recursively

A specialized software factory or Slack connector is still an ordinary package extending another interface. A composite can itself consume resources of the type it provides.

### 18.4 Organization is the natural sharing boundary

Shared credentials/connections and workforces often span projects. Organization-scoped resource identities with project labels/memberships avoid rigid ownership decisions, but deployment isolation still needs design.

### 18.5 Git for designed behavior; runtime for operational state

Keep workflows and project configuration version-controlled while storing sensitive credentials, live resource metadata, execution progress, and transient state in the appropriate runtime/control plane.

### 18.6 Workflow durability outranks agent session longevity

Don't maintain a running LLM merely to preserve workflow state. Store state durably, and choose session continuation only where it improves results or economics.

### 18.7 Arbitrary workflows demand arbitrary dashboards

Allow packages to expose domain-specific Convex-backed getters, metrics, and custom UI, rather than imposing a fixed workflow dashboard schema.

### 18.8 Infrastructure should be replaceable

Agents, compute providers, knowledge stores, registries, chat platforms, and source-control hosts should be swappable behind interfaces where their semantics truly fit the contracts.

### 18.9 Visual operations must remain software engineering operations

A GUI should create meaningful code/configuration diffs that can be reviewed, tested, and deployed through normal version control, not bypass it with opaque generated state.

---

## 19. Current decisions, inclinations, and open questions

### 19.1 Fairly established direction from the conversation

- Jive is a broad agentic-workforce platform, not only a polyrepo tool.
- **Agentic workforce** is the general abstraction; **software factory** is a specialization.
- Jive should have a highly extensible npm-based component ecosystem.
- Avoid many distinct package categories.
- Packages should declare named dependency slots against other interface contracts.
- Code-level interface requirements and existing resource-instance requirements should be distinguishable.
- Concrete package implementations can themselves extend/specialize other packages.
- Instances are identified by stable IDs and should be validated before deployment/use.
- Workflows own durable execution state; agents can execute task-by-task.
- Jive's web/mobile UI should surface reactive, workflow-specific data.
- Visual creation/editing should result in real repository code/configuration changes.
- `jive create agentic software factory` is a target UX. *Changed in [§22](#22-decisions-package-model-and-naming-2026-10-22): the command is `jive create agentic workforce software factory`, resolving to `jive-abstract-agentic-workforce-software-factory`.*
- You already reported implementing `jive-template-library` before the naming/unification discussions.

### 19.2 Strong preferences or emerging proposals, not fully settled

- A universal package manifest with `extends`, `dependsOn`, and `initializable`.
- `initializable: true` as the creation-catalog indicator. *Superseded by [§22](#22-decisions-package-model-and-naming-2026-10-22): the `jive-abstract-` name prefix marks what `jive create` can create.*
- Plain `jive-*` as the eventual naming convention (recommended, not explicitly accepted). *Rejected in [§22](#22-decisions-package-model-and-naming-2026-10-22): it collides with Jive's own packages, e.g. `jive-app` against `@jive-sh/app`.*
- An organization-owned `resources` table with `id`, `name`, `interface`, and `implementation`.
- Uniqueness of resource names within each organization.
- Projects as optional tags/groupings, potentially multi-membership.
- Convex as the primary orchestration/database foundation. *Settled in [§23](#23-decisions-central-server-and-local-servers-2026-10-26).*
- Fly.io Sprites as an initial agent compute backend.
- Separate AgentRuntime, ComputeRuntime, and perhaps an inference gateway/provider.
- Typed runtime handles that make local and Convex-backed operations accessible behind one connector interface.
- Git and Convex owning different categories of state.

### 19.3 Specific unresolved questions

**Package semantics and discovery**

1. Final package prefix: `jive-interface-*` or plain `jive-*`? *Settled in [§22](#22-decisions-package-model-and-naming-2026-10-22): neither; the prefixes are `jive-abstract-`, `jive-connector-` and `jive-agentic-`.*
2. What exactly does `extends` guarantee? Structural type compatibility, shared code, metadata inheritance, or all of these?
3. Can a package extend multiple interfaces, or does it have a single primary parent?
4. How are compatible packages discovered: npm name queries, metadata indexing, curated catalog, local registry, or hybrid? *Settled in [§22](#22-decisions-package-model-and-naming-2026-10-22): npm name queries on the three ecosystem prefixes; `jive create` lists `jive-abstract-*`.*
5. How do users discover package capabilities and trust unknown third-party code?
6. What is the exact difference between declaring an interface, implementing it, and being “initializable,” if all are one package kind? *Settled in [§22](#22-decisions-package-model-and-naming-2026-10-22): an abstract holds the contract plus shared implementation, other packages extend it, and being an abstract is what makes a kind creatable.*
7. Does `initializable` require a `create()` function, declarative scaffolding instructions, or either?
8. How will dependencies reference **versions**, and how does that interact with Jive version sets?

**Dependency binding**

9. Where do resolved `dependsOn.interfaces` and `dependsOn.instances` mappings live: repo config, resource DB, generated source, or more than one with defined precedence?
10. Are bindings fixed at create time, deploy time, or dynamically replaceable at runtime?
11. How does an interface instance expose methods when its implementation runs remotely?
12. How should configuration of a code-level dependency differ from configuration of a resource-instance dependency?
13. Which resources can be shared across projects/environments? What permissions are required?
14. How are dependency cycles detected across packages and resource instances?
15. Does deleting a resource with dependents fail, cascade, or require migration?

**Resource and deployment model**

16. Organization vs project as the primary namespace/security boundary; organization is currently favored.
17. Are project tags enough, or are first-class project entities needed?
18. Is a project itself an initializable Jive resource?
19. Does each project/workforce get a separate Convex deployment, and if so, where do organization-global connectors live?
20. How are resource GUIDs routed to physical implementations/deployments?
21. How much provisioning/reconciliation does Jive own versus delegate to existing infrastructure tooling?
22. What are the exact resource lifecycle states and operations (create, configure, attach, deploy, upgrade, destroy)?

**Execution, sessions, and UX**

23. What methods belong to AgentRuntime, ComputeRuntime, Channel, or InferenceGateway?
24. Under what conditions should Jive resume a previous agent session, reconstruct context, or keep a live channel active?
25. How are original transcripts, traces, failures, and decisions stored/retrieved?
26. What are the evals and cost measurements used for automatic context selection?
27. How much UI/code editing can be safely round-tripped?
28. Should UI changes directly commit, propose PRs, or respect approval policies per resource?
29. What controls whether a generated workflow is automatically deployed?
30. How is per-workflow arbitrary UI code packaged and securely rendered?

**Knowledge and product strategy**

31. Which knowledge/memory engine(s) are the default, and how is provider comparison implemented?
32. Which graph-engineer self-improvement actions may be automatically committed/deployed?
33. What is the v1 boundary: library creation + registry connector + resource instances, or a larger initial workforce feature set?
34. What is implemented today beyond the already-existing `jive-template-library` and earlier Jive CLI functionality?

---

## 20. Suggested next design exercise

The highest-value next specification is a **single fully runnable vertical slice**:

```text
jive create library
    |
    +-- select the library's code-level dependencies
    |
    +-- find or create an npm registry resource
    |      |
    |      +-- register resource ID, interface, and concrete impl
    |
    +-- write a repository with resolved dependency bindings
    |
    +-- run local build
    |
    +-- run CI deploy
           |
           +-- validate the registry instance ID exists
           +-- validate contract compatibility and permissions
           +-- resolve the connector API across the runtime boundary
           +-- publish package using provider-appropriate credentials
```

This one use case forces the answers to the most confusing questions without needing to design every possible workforce operation at once:

1. Define a package manifest containing `extends`, `initializable`, and both dependency maps.
2. Define the exact format of a resolved dependency configuration.
3. Define a resource record and instance GUID validation.
4. Define how local/CI code receives a typed connector handle.
5. Define which parts are committed to Git and which live in the control plane.
6. Define the UX for selecting an existing resource or creating a new one.

After that, the same abstractions can be tested on a **composite knowledge base** and an **agentic software factory**. Those cover self-referential/fan-out dependencies, multiple provider instances, long-running workflows, and visual organization creation.

This is a proposed validation sequence, not a claim that it has been selected as Jive's implementation roadmap.

---

## 21. Glossary

**Agentic workforce** — The top-level programmable unit of organized agentic work. A software factory is one specialization.

**Workflow** — Durable, inspectable orchestration logic that invokes agents and other operations while persisting progress and outcomes.

**AgentRuntime** — Proposed abstraction over executing an agent implementation such as Claude or Codex and managing its sessions/tools.

**ComputeRuntime** — Proposed abstraction over machines/sandboxes/process execution, independent of the selected model/agent.

**Channel (agent)** — Messaging/event delivery into a running agent session; distinct from the workflow's persistent state.

**Chat connector** — Integration with an external communication system such as Slack or Discord; not necessarily an agent-session channel. Under §22 this is a connector package such as `jive-connector-slack`; under [§25](#25-decisions-the-first-connector-a-three-layer-stack-2026-10-26), `jive-connector-<kind path>-slack`.

**Jive package** — The proposed universal npm-distributed unit that may specify contracts, specialization, dependencies, initialization, runtime APIs, and code.

**Interface** — A contract/capability named by a Jive package and satisfied by specialized/implementing packages and resources.

**Implementation** — A package that provides compatible behavior for an interface. Under the proposed unified model, it is still an ordinary Jive package.

**`extends` / `implements`** — Relationship expressing specialization/compatibility; exact semantics remain open.

**`initializable`** — Proposed package flag indicating that Jive can offer a creation/initialization flow for it (possibly requiring provider selection). Superseded by the `jive-abstract-` name prefix (§22.5).

**`dependsOn.interfaces`** — Named map of package/code-level dependency slots; each slot requires a specified interface package and resolves to a compatible package implementation.

**`dependsOn.instances`** — Named map of resource dependency slots; each slot requires a specified interface package and resolves to a stable ID of an actual configured resource instance.

**Resource** — A named, configured instance in Jive's organization-level registry, carrying an ID, interface, and implementation reference.

**Organization** — Favored top-level namespace for resources and reusable connectors.

**Project** — Proposed optional grouping/tag or first-class resource that organizes subsets of an organization's resources; precise semantics unresolved.

**Version set** — Coordinated collection of mutually compatible versions across independent packages/repos, managed as part of Jive's original development platform.

**Knowledge graph / memory** — Persisted facts, decisions, relationships, task history, and evidence used to drive workflows and reconstruct agent context.

**Graph engineer** — Proposed higher-order agent/skill/workflow that optimizes the workflow graph against organizational goals.

**Abstract** — A package named `jive-abstract-<kind>` that holds one kind's contract (manifest schema, CI/CD hooks, `dependsOn` slots), shared behavior, and build/deploy toolchain, like an abstract class. Other packages extend it, and an abstract can extend another abstract (§22.2).

**`jive-abstract-abstraction`** — The abstract whose CLI, `jive-abstraction`, creates new abstracts. Replaces `jive-template-template` (§22.4).

**Connector** — A package that links Jive to an outside system, used by both pipelines and agents. An implementation is a Convex component named `jive-connector-<abstract kind path>-<system>`, e.g. `jive-connector-package-registry-npm`; the contract it implements is an abstract such as `jive-abstract-connector-package-registry` ([§25](#25-decisions-the-first-connector-a-three-layer-stack-2026-10-26)). Compute runtimes are connectors too (§22.6, §22.8).

**Ecosystem package** — A public, reusable package carrying one of the prefixes `jive-abstract-`, `jive-connector-` or `jive-agentic-` so it can be found on npm (§22.7).

**Usage package** — Someone's private use of the platform, such as `@jive-sh/app` or `@ozyman42/ozy-cli`. It extends an abstract and can be named anything (§22.7).

---

## 22. Decisions: package model and naming (2026-10-22)

These decisions are settled. They replace the naming options in §4.2, the `initializable` flag in §5.2, the discovery question in §5.4, and §19.3 questions 1, 4 and 6. The earlier sections stay as history.

### 22.1 Guiding principle

Jive's vocabulary should teach real computer science. Where a precise CS term exists, Jive uses it instead of a friendlier, vaguer word. "Abstract" and "connector" below were both chosen this way.

### 22.2 Abstracts

An abstract is one npm package per kind of thing, named `jive-abstract-<kind>`. Like an abstract class, it holds both a contract and a shared implementation:

- The contract: the manifest schema, the CI/CD hooks, and the `dependsOn` slots.
- The shared behavior every package of that kind gets.
- The build and deploy toolchain.

Packages extend an abstract, and an abstract can extend another abstract.

A kind is never split into a separate interface package and template package. That split would make the author of every kind keep two packages in sync.

Examples:

- `jive-abstract-library`, renamed from `jive-template-library` and now published on npm.
- `jive-abstract-app`.
- `jive-abstract-agentic-workforce-software-factory`, which extends `jive-abstract-agentic-workforce`. A software factory is a kind of workforce you create, so it is an abstract, not a shared `jive-agentic-` package.

### 22.3 CLI names

An abstract's CLI drops "abstract-" from the package name. `jive-abstract-library` ships the `jive-library` CLI.

### 22.4 Abstracts of abstracts

`jive-abstract-abstraction`, whose CLI is `jive-abstraction`, creates new abstracts. It replaces `jive-template-template`.

### 22.5 `jive create`

`jive create` lists every npm package whose name starts with `jive-abstract-` and splits the rest of each name on hyphens into an autocomplete tree. `jive-abstract-agentic-workflow` is typed `jive create agentic workflow`.

A hyphen is always a menu level and never part of a word. A kind for SpacetimeDB is therefore spelled `spacetimedb`, not `spacetime-db`.

Target UX, with the abstract each command resolves to:

```bash
jive create library            # jive-abstract-library
jive create abstraction        # jive-abstract-abstraction
jive create connector          # jive-abstract-connector
jive create agentic workflow   # jive-abstract-agentic-workflow
jive create agentic skill      # jive-abstract-agentic-skill
jive create agentic workforce  # jive-abstract-agentic-workforce
jive create agentic workforce software factory  # jive-abstract-agentic-workforce-software-factory
```

The last line replaces the earlier target `jive create agentic software factory` (§1, §5.2, §17, §19.1), because the hyphen rule makes every word of the package name a menu level.

Because the name prefix marks what `jive create` can create, packages need no `initializable` flag (§5.2).

### 22.6 Ecosystem prefixes

Three top-level prefixes make the public ecosystem searchable on npm:

| Prefix | Holds | Examples |
| --- | --- | --- |
| `jive-abstract-<kind>` | Kinds you create | `jive-abstract-library`, `jive-abstract-app` |
| `jive-connector-<system>` | A link from Jive to an outside system, used by both pipelines and agents | `jive-connector-npm`, `jive-connector-slack`, `jive-connector-tencentdb` |

*Amended in [§25](#25-decisions-the-first-connector-a-three-layer-stack-2026-10-26): a connector implementation is named `jive-connector-<abstract kind path>-<system>`, so `jive-connector-npm` becomes `jive-connector-package-registry-npm`.*
| `jive-agentic-` | Shared agentic packages: workflows, skills and workforces | `jive-agentic-workflow-meeting-summary`, `jive-agentic-skill-code-review` |

### 22.7 Ecosystem packages and usage packages

An ecosystem package is a contribution to the public, reusable, composable ecosystem. It carries one of the three prefixes in §22.6 so people can find it.

A usage package is someone's private use of the platform. It extends an abstract and can be named anything, with no prefix. Examples are `@jive-sh/app`, `@jive-sh/skill-sync`, `effective-modules` and `@ozyman42/ozy-cli`. `@jive-sh/app`, for instance, is an implementation of the app abstract, `jive-abstract-app`.

### 22.8 Compute runtimes are connectors

Compute runtimes such as Fly.io Sprites and the local machine are outside systems, so they are connectors. They need no separate package family.

### 22.9 Rebuilding `@jive-sh/app`'s integrations on connectors

`@jive-sh/app` currently hardcodes its own integration concept in `packages/@jive-sh/app/docs/db-model.md`, as the tables `external_system_types`, `external_system_integrations` and `external_system_integration_connections`. That concept should be rebuilt on connectors. An org's configured TencentDB, for example, would be an instance of `jive-connector-tencentdb`. *Under [§25](#25-decisions-the-first-connector-a-three-layer-stack-2026-10-26) the name carries its abstract's kind path, `jive-connector-<kind path>-tencentdb`; that kind is not yet chosen.*

### 22.10 Why "connector" and not "integration"

The choice followed a survey of what comparable tools and the CS literature call these packages:

| Source | Term | Evidence |
| --- | --- | --- |
| Claude | "connectors", with 950+ MCP servers in its directory | [Anthropic blog](https://claude.com/fr/blog/bringing-mcp-2026-07-28-to-claude) |
| ChatGPT | "connectors", until it renamed them "apps" on 2025-12-17 | [OpenAI help](https://help.openai.com/en/articles/11487775-apps-in-chatgpt?gn=1) |
| Microsoft Copilot Studio / Power Platform | "connectors" | [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-graph-vs-power-platform-connectors) |
| Vercel | "connectors" | [Vercel](https://vercel.com/connect/n8n) |
| Google Gemini | "apps", formerly "extensions" | [Google Workspace Updates](https://workspaceupdates.googleblog.com/2025/05/google-workspace-apps-are-now-generally-available-for-the-gemini-app.html) |
| Zapier, Make and n8n | apps, integrations or nodes | [IONOS on n8n](https://www.ionos.com/digitalguide/server/know-how/n8n.md) |
| T3 Code | "Integrations" are capabilities given to its agents (browser, devices, simulators); "Connections" are environments and network links | T3 Code settings |
| CS literature | Shaw and Garlan's components-and-connectors model of software architecture | [UCI ICS 221 slides](https://ics.uci.edu/~taylor/ICS221/slides/architecture) |

Connector leads in AI agent tooling, in data infrastructure, and in CS. Consumer tools are moving to "apps", which would collide with `jive-abstract-app`.

### 22.11 Rejected names

A name for an abstract has four jobs: creating a project, building and deploying it from then on, defining its shape, and being implemented by others. These names were rejected:

- `jive-template-*`: implies a one-time copy, when the package keeps building and deploying the project.
- `jive-interface-*`: jargon, and it covers only the contract.
- `jive-impl-*` and `jive-concrete-*`: they force names on users' own packages, which §22.7 leaves free.
- Plain `jive-<kind>`: collides with Jive's own packages, e.g. `jive-app` against `@jive-sh/app`.
- "framework": too easily confused with app frameworks like React.
- "factory": collides with "software factory".
- "foundation", "chassis", "blueprint", "trait" and "kit": each fails at least one of the four jobs.

### 22.12 Not decided here

- The other questions in §19.3 stay open, including what `extends` guarantees (2), whether a package can have more than one parent (3), and how users trust third-party packages (5).
- What a shared `jive-agentic-workforce-*` package would hold, now that the software factory is an abstract and not one of them.

---

## 23. Decisions: central server and local servers (2026-10-26)

These decisions are settled. They answer the hosting split §13.4 left open and settle "Convex as the primary orchestration/database foundation" in §19.2. The earlier sections stay as history.

### 23.1 The central server is Convex, not Cloudflare

Jive's central server is a Convex deployment. The Cloudflare-layer concept in §13.4 (Workers, D1, KV, Durable Objects) is not the direction. The two services on Cloudflare today, `@jive-sh/skill-sync-service` and `@jive-sh/app`, move to it.

### 23.2 Two kinds of Convex server

| Server | Runs where | Holds |
| --- | --- | --- |
| **Local Convex** | Every machine, one each | Running work and visualizing tasks |
| **Central Convex** | One deployment | Syncs workflow definitions, and today's skill-sync data |

### 23.3 Hosting choices made with it

- The central server lives in the Convex team `jive`, which is on Pro. Custom domains require Pro.
- `api.jive.sh` is the API domain, separate from the app at `jive.sh`.
- Convex backends, the central server's included, deploy through a new abstract, `jive-abstract-backend-convex` (CLI `jive-backend-convex`), which supplies their deployment and CI/CD the way `jive-abstract-library` does for libraries.
- `@jive-sh/app` splits in two. `@jive-sh/server` (new) is only the backend: it extends `jive-abstract-backend-convex`, and its build publishes the generated Convex client to npm and deploys the functions, both from one commit. `@jive-sh/app` is only the frontend at `jive.sh`: it extends `jive-abstract-app-expo` (new) and imports `@jive-sh/server`'s client, which replaces `@jive-sh/app-client`.

### 23.4 Migration plan

[`convex_migration_plan.md`](convex_migration_plan.md) maps each Cloudflare piece of both services to its Convex equivalent with the Convex documentation it rests on, lists what Convex cannot do, and lists the decisions still open. It is designed, not built.

### 23.5 Not decided here

- Whether the central copy of workflow definitions is synced from git, which §10.4 makes their source, or is itself the source.
- The open questions in [plan §8](convex_migration_plan.md#8-decisions-for-alex).
- §9.6 and §19.3 question 19 (one Convex deployment per project) remain open for workload deployments; this section fixes only the central server.

---

## 24. Decisions: credentials on the server, CI by OIDC (2026-10-26)

These decisions are settled, except §24.4, which records an open design. They settle §8.3's identity and secrets questions for CI, and say where §13.4's control-plane credentials live. The earlier sections stay as history.

### 24.1 Package roles

- **`@jive-sh/app`** is only the frontend: the website at `jive.sh`.
- **`@jive-sh/server`** is the Convex backend, Jive's database, and the one place every credential lives.

Today the credential store is code in `@jive-sh/app` (the connections described in `packages/@jive-sh/app/docs/db-model.md`). The [migration plan §5](convex_migration_plan.md#5-jive-shapp-splits-into-jive-shserver-and-jive-shapp) moves it into `@jive-sh/server`.

### 24.2 CI holds no provider secrets

A GitHub Actions job authenticates to `@jive-sh/server` with its GitHub OIDC id token. The server then uses the credentials it stores to act on the job's behalf, through connectors (§22.6).

The secrets CI holds today, such as `CONVEX_TEAM_ACCESS_TOKEN` and `NPM_TOKEN` in `@jive-sh/server`'s planned `requiredSecrets` ([migration plan §3.1](convex_migration_plan.md#31-deployment-through-the-two-abstracts)), are scaffolding until this exists.

Open:

- **Bootstrapping.** `@jive-sh/server`'s own deploy cannot ask `@jive-sh/server` for credentials before the server exists.
- **What the server checks.** Which claims of the id token (repository, workflow, environment, branch) decide what a job may do.

### 24.3 Next sprint

A working Jive CLI, website and connectors, all on this model.

### 24.4 Open design: automating npm's second factor

npm guards some actions with a second factor that a token cannot satisfy, so taking every npm credential out of CI means the server must be able to pass that check itself.

What the sources say:

- npm's two-factor authentication prompts "with a security-key", and the security-key flow covers biometrics and physical keys ([npm 2FA](https://docs.npmjs.com/about-two-factor-authentication)).
- `npm trust`, which creates the trusted publishers that let CI publish without a token, requires 2FA enabled on the account. It does not accept granular access tokens with the bypass-2FA option, and its first request requires two-factor authentication (`npm help trust`, npm 11.12.1).
- Chrome DevTools Protocol's `WebAuthn` domain creates a virtual authenticator (`addVirtualAuthenticator`) and loads a credential into it (`addCredential`). The credential carries an `rpId` and a `privateKey`, "the ECDSA P-256 private key in PKCS#8 format" ([WebAuthn domain](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/), [protocol definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/WebAuthn.pdl)).
- `ozy-cli`'s `ozy-virtual-security-key` is a stub: it registers a virtual HID device, logs the bytes it receives and replies with 64 zero bytes ([source](https://github.com/ozyman42/ozy-cli/blob/aa4326d2c2d14c41faf40e0f289cb83a0982a92b/src/entrypoints/ozy-virtual-security-key.ts#L8-L17)).

**Proposed mechanism.** A software security key registered on the npm account, whose P-256 private key `@jive-sh/server` stores. When npm asks for the second factor, a browser driven over the DevTools Protocol adds a virtual authenticator holding that credential and completes the ceremony.

**Risk.** A breach of the server then hands over the account's second factor along with every other credential it stores. How to secure a user's stored npm credentials and second factor is **open**, deferred to a later in-depth security discussion with Alex ([§25.5](#255-an-instance-is-the-users-own-npm-account-2026-10-26)).

**Rejected for now ([§25.5](#255-an-instance-is-the-users-own-npm-account-2026-10-26)).** A dedicated npm bot account that only maintains Jive's packages, with its own revocable key, so a breach reaches those packages and nothing else. An instance is the user's own npm account instead.

Not yet worked out:

- Where the browser runs. Convex's documentation does not describe running a browser inside a function (my inference from its [runtimes page](https://docs.convex.dev/functions/runtimes#supported-apis)), so it is a connector's or a machine's job.
- How the server signs in to the user's npm account before its second factor is asked for.

---

## 25. Decisions: the first connector, a three-layer stack (2026-10-26)

These decisions are settled. They amend §22.6's connector naming; the earlier sections stay as history.

### 25.1 The three layers

| Package | What it is | Holds |
| --- | --- | --- |
| `jive-abstract-connector` | Abstract, a library | The scaffolding and CI/CD that build a connector as a Convex component |
| `jive-abstract-connector-package-registry` | Abstract, a library, extending `jive-abstract-connector` | The package-registry contract |
| `jive-connector-package-registry-npm` | Implementation, a Convex component | The package-registry contract implemented for npm. `@jive-sh/server` installs it |

### 25.2 Only implementations are Convex components

Abstracts are libraries. A connector implementation is a Convex component, which `@jive-sh/server` installs, so it runs beside the credentials it uses (§24.1).

Two Convex limits apply to every implementation:

- A component's functions don't see the installing app's environment variables, and its HTTP actions have no `ctx.auth` ([authoring components](https://docs.convex.dev/components/authoring#http-actions)). The server passes credentials and caller identity to the connector explicitly.
- Components cannot use the Node.js runtime yet ([convex-backend #335](https://github.com/convex/convex-backend/issues/335)), so a connector runs in Convex's default runtime, which has `fetch` in actions ([runtimes](https://docs.convex.dev/functions/runtimes#network-apis)).

### 25.3 Naming

A connector implementation is named `jive-connector-<abstract kind path>-<system>`. The kind path is its abstract's name after `jive-abstract-connector-`, e.g. `jive-connector-package-registry-npm` for npm implementing `jive-abstract-connector-package-registry`. The name says which contract a package implements, which makes implementations discoverable by searching for that kind. It replaces §22.6's example `jive-connector-npm`.

By §22.5's rule that every hyphen is a menu level, `jive create connector package registry` resolves to `jive-abstract-connector-package-registry` (my inference from §22.5).

### 25.4 Where it is built

In the thread "jive-abstract-connector + jive-abstract-connector-package-registry (connector scaffolding)".

### 25.5 An instance is the user's own npm account (2026-10-26)

For now, an instance of `jive-connector-package-registry-npm` is a user's own existing npm account. Jive creates no dedicated bot accounts. This rejects, for now, the bot-account mitigation in §24.4.

Open: the security of storing a user's npm credentials and second factor in `@jive-sh/server` (§24.4's risk). It is deferred to a later in-depth security discussion with Alex.

### 25.6 Provisioning a new npm package (2026-10-26)

Jive's package-registry provisioning creates a new npm package in three steps:

1. **Placeholder.** Publish a blank placeholder tarball as the user's npm account (§25.5).
2. **Trusted publishing.** Register a trusted publisher for the package's repository and its `pipeline.yml` workflow.
3. **Real versions.** CI publishes every real version through OIDC, holding no npm credential (§24.2).

The order follows two npm constraints:

- `npm trust` works only on a package that already exists on the registry, and needs two-factor authentication on its first request (`npm help trust`, npm 11.12.1). Step 1 makes the package exist. Step 2 is where the second factor of §24.4 is asked for.
- A newly created trusted-publisher configuration "must complete its first successful publish within 2 days". Otherwise it "expires and can no longer be used or edited", and must be deleted and created again ([trusted publisher configuration expiry](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)). So step 3's first run has to follow step 2 within two days. Provisioning should trigger it rather than wait for the next change, which is my inference.

The worked example in §7.7 points here.

---

## Closing synthesis

The most consequential shift in the conversation is from thinking about Jive as **templates that create projects plus connectors plugged into them** to thinking about Jive as **one recursive ecosystem of programmable packages and configured resources**.

A package can specialize a contract, describe its code dependencies, require concrete resource instances, and provide its own initialization experience. A resource is the named, organization-scoped realization of a package, with a stable ID. The UI and CLI manipulate the same dependency graph and produce version-controlled source/configuration; Convex and agent runtimes execute the resulting workflows and record their state.

Your latest dependency distinction is especially important:

```ts
dependsOn: {
  interfaces: { /* named slots → interface package contracts */ },
  instances:  { /* named slots → interface package contracts */ },
}
```

At resolution time, the first set gets **compatible implementation packages** and the second gets **existing resource IDs**. That captures both reusable code composition and the real-world need to bind a library's deployment to an actual npm registry connector, a workforce to actual chat channels/subscriptions, or a composite knowledge base to multiple configured stores.

What remains is less about inventing another abstract package concept and more about making **one end-to-end runtime and deployment path concrete**: package discovery → initialization → instance binding → code generation → resource validation → local/CI or Convex-backed execution → durable workflow observation.
