import { Effect, Equal, Option } from "effect";
import type { DesignData, PackageNote } from "../design-data/interface";
import type { PackageFolder } from "../package-folders/interface";
import { AmbiguousExtends, ExtendsCycle, PackageStatus, type DesignPage, type PackageRow, type PackageToDeleteRow } from "./model";

interface DesignInputs {
  readonly data: DesignData;
  readonly folders: ReadonlyArray<PackageFolder>;
}

export interface DerivedDesignPage {
  /** Everything but the CLI section, which comes from the CLI, not the packages. */
  readonly page: Omit<DesignPage, "cli">;
  /** Design data entries that no longer match the packages, each with what to change. */
  readonly staleNotes: ReadonlyArray<string>;
}

interface PackageNode {
  readonly name: string;
  readonly group: string;
  readonly status: PackageStatus;
  /** The row this one is indented under, when that row is in the same group. */
  readonly parentCandidate: Option.Option<string>;
}

const noteFor = (data: DesignData, name: string): Option.Option<PackageNote> =>
  Option.fromNullishOr(data.packages.find((note) => note.name === name));

const groupFor = (data: DesignData, name: string): string =>
  Option.match(Option.flatMap(noteFor(data, name), (note) => note.group), {
    onSome: (label) => label,
    onNone: () => {
      const prefixGroup = data.groups.find((group) => name.startsWith(group.namePrefix));
      return prefixGroup !== undefined ? prefixGroup.label : data.groupForOtherPackages.label;
    },
  });

/**
 * A folder is on the page when the design data lists it, a group's name prefix claims it, or it is built with
 * Jive (a jive block, or a dependency on a jive-abstract-* package).
 */
const isShown = (data: DesignData, folder: PackageFolder): boolean =>
  Option.isSome(noteFor(data, folder.name)) ||
  data.groups.some((group) => folder.name.startsWith(group.namePrefix)) ||
  (folder.contents._tag === "Manifest" &&
    (folder.contents.hasJiveBlock || folder.contents.abstractDependencies.length > 0));

const generatedClientsOf = (folders: ReadonlyArray<PackageFolder>) =>
  folders.flatMap((folder) =>
    folder.contents._tag === "Manifest" && Option.isSome(folder.contents.generatedClientName)
      ? [{ backend: folder.name, client: folder.contents.generatedClientName.value }]
      : [],
  );

/** Every package name whose npm version the page shows. */
export const packagesToLookUp = ({ data, folders }: DesignInputs): ReadonlyArray<string> => {
  const shown = folders.filter((folder) => isShown(data, folder));
  return [
    ...shown.map((folder) => folder.name),
    ...generatedClientsOf(shown).map(({ client }) => client),
    ...data.packagesToDelete.map((entry) => entry.name),
  ];
};

function* mostSpecificAbstract(
  folder: PackageFolder,
  folderByName: ReadonlyMap<string, PackageFolder>,
): Effect.fn.Return<Option.Option<string>, AmbiguousExtends> {
  const abstractsOf = (name: string): ReadonlyArray<string> => {
    const candidate = folderByName.get(name);
    return candidate !== undefined && candidate.contents._tag === "Manifest"
      ? candidate.contents.abstractDependencies
      : [];
  };
  const ancestorsOf = (name: string, seen: Set<string> = new Set()): Set<string> => {
    for (const parent of abstractsOf(name)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      ancestorsOf(parent, seen);
    }
    return seen;
  };
  const direct = abstractsOf(folder.name);
  const candidates = direct.filter(
    (abstract) => !direct.some((other) => other !== abstract && ancestorsOf(other).has(abstract)),
  );
  if (candidates.length > 1) return yield* new AmbiguousExtends({ packageName: folder.name, candidates });
  return Option.fromNullishOr(candidates[0]);
}

const folderStatus = (
  folder: PackageFolder,
  note: Option.Option<PackageNote>,
  publishedVersion: Option.Option<string>,
): PackageStatus => {
  const building = Option.flatMap(note, (found) => found.building);
  if (Option.isSome(building)) return PackageStatus.Building({ publishedVersion, next: building.value });
  if (Option.isSome(publishedVersion)) return PackageStatus.Published({ version: publishedVersion.value });
  switch (folder.contents._tag) {
    case "Manifest":
      return PackageStatus.Built();
    case "Empty":
      return PackageStatus.Empty();
    case "DocsOnly":
      return PackageStatus.DocsOnly();
    case "Stub":
      return PackageStatus.Stub();
  }
};

/**
 * Builds the page: one tree per group, where a row sits under the package it extends (its most specific
 * jive-abstract-* dependency) when that package is in the same group, and a backend's published client sits
 * under the backend. Rows keep the design data's order; packages it doesn't list follow, by name.
 */
export function* deriveDesignPage(
  inputs: DesignInputs & { readonly publishedVersionOf: (packageName: string) => Option.Option<string> },
): Effect.fn.Return<DerivedDesignPage, AmbiguousExtends | ExtendsCycle> {
  const { data, folders, publishedVersionOf } = inputs;
  const folderByName = new Map(folders.map((folder) => [folder.name, folder]));
  const shown = folders.filter((folder) => isShown(data, folder));
  const nodes: Array<PackageNode> = [];
  const staleNotes: Array<string> = [];

  for (const folder of shown) {
    nodes.push({
      name: folder.name,
      group: groupFor(data, folder.name),
      status: folderStatus(folder, noteFor(data, folder.name), publishedVersionOf(folder.name)),
      parentCandidate: yield* mostSpecificAbstract(folder, folderByName),
    });
  }
  for (const { backend, client } of generatedClientsOf(shown)) {
    if (folderByName.has(client)) continue;
    nodes.push({
      name: client,
      group: groupFor(data, backend),
      status: Option.match(publishedVersionOf(client), {
        onSome: (version) => PackageStatus.Published({ version }),
        onNone: () => PackageStatus.Built(),
      }),
      parentCandidate: Option.some(backend),
    });
  }
  const nodeNames = new Set(nodes.map((node) => node.name));
  for (const note of data.packages) {
    const exists = nodeNames.has(note.name);
    if (Option.isSome(note.proposed)) {
      if (exists) {
        staleNotes.push(`${note.name} has a package folder now: delete "proposed" from its entry`);
        continue;
      }
      if (Option.isSome(note.building)) {
        staleNotes.push(`${note.name} is proposed, so its "building" note is not shown`);
      }
      nodes.push({
        name: note.name,
        group: groupFor(data, note.name),
        status: PackageStatus.Proposed(),
        parentCandidate: note.proposed.value.extends,
      });
    } else if (!exists) {
      staleNotes.push(`${note.name} has no package folder: delete its entry or mark it proposed`);
    }
  }

  const listedOrder = new Map(data.packages.map((note, index) => [note.name, index]));
  const displayOrder = (left: PackageNode, right: PackageNode) => {
    const leftIndex = listedOrder.get(left.name);
    const rightIndex = listedOrder.get(right.name);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return left.name.localeCompare(right.name);
  };
  const groupByName = new Map(nodes.map((node) => [node.name, node.group]));
  const parentOf = (node: PackageNode): Option.Option<string> =>
    Option.filter(node.parentCandidate, (parent) => groupByName.get(parent) === node.group);
  const rowsUnder = (group: string, parent: Option.Option<string>): ReadonlyArray<PackageRow> =>
    nodes
      .filter((node) => node.group === group && Equal.equals(parentOf(node), parent))
      .toSorted(displayOrder)
      .map((node) => ({
        name: node.name,
        status: node.status,
        purpose: Option.flatMap(noteFor(data, node.name), (note) => note.purpose),
        children: rowsUnder(group, Option.some(node.name)),
      }));

  const groups = [...data.groups, data.groupForOtherPackages].map((group) => ({
    label: group.label,
    description: group.description,
    rows: rowsUnder(group.label, Option.none()),
  }));
  const rendered = new Set<string>();
  const collect = (rows: ReadonlyArray<PackageRow>): void =>
    rows.forEach((row) => {
      rendered.add(row.name);
      collect(row.children);
    });
  groups.forEach((group) => collect(group.rows));
  const unreachable = nodes.filter((node) => !rendered.has(node.name)).map((node) => node.name);
  if (unreachable.length > 0) return yield* new ExtendsCycle({ packageNames: unreachable });

  const packagesToDelete: Array<PackageToDeleteRow> = [];
  for (const entry of data.packagesToDelete) {
    const publishedVersion = publishedVersionOf(entry.name);
    const folderPath = Option.map(Option.fromNullishOr(folderByName.get(entry.name)), (folder) => folder.path);
    if (Option.isNone(publishedVersion) && Option.isNone(folderPath)) {
      staleNotes.push(`${entry.name} is gone from npm and packages/: delete its packagesToDelete entry`);
      continue;
    }
    packagesToDelete.push({ name: entry.name, reason: entry.reason, publishedVersion, folderPath });
  }

  return { page: { openDecisions: data.openDecisions, packagesToDelete, groups }, staleNotes };
}
