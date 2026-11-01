import { Option } from "effect";
import type { OpenDecision } from "../design-data/interface";
import type { CliCommandRow, CliDoc, CliSection, DesignPage, GroupSection, PackageRow, PackageStatus, PackageToDeleteRow } from "./model";

// The page is a file with no server, so the open tab rereads it every few seconds to show each regeneration.
const HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Jive design</title><style>
:root{--fg:#e6e6e6;--muted:#9a9a9a;--border:#2a2a2a;--bg:#111}
body{font-family:-apple-system,system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:32px;max-width:980px}
h1{font-size:20px;margin:0 0 18px}h2{font-size:15px;margin:26px 0 6px}
.row{display:grid;grid-template-columns:400px 110px 1fr;gap:12px;padding:6px 0;border-top:1px solid var(--border);font-size:13.5px;align-items:baseline}
.name{font-family:ui-monospace,monospace;font-size:12.5px;white-space:pre}
.node{color:var(--muted)}
.b{font-size:11.5px;padding:1px 8px;border-radius:999px;white-space:nowrap}
.pub{background:#16351f;color:#5fd17f}.built{background:#152a40;color:#6cb2f0}.empty{background:#2a2a2a;color:#aaa}.prop{background:#3d2e10;color:#f0b44c}.work{background:#2d1f40;color:#c49cf5}.del{background:#3d1616;color:#f07a7a}
.legend{font-size:12px;color:var(--muted);display:flex;gap:14px;margin-bottom:6px}
a{color:#6cb2f0}
</style></head><body>
<h1>Jive design</h1>`;

const LEGEND = `<div class="legend"><span><span class="b pub">version</span> on npm</span><span><span class="b built">built</span> unpublished</span><span><span class="b work">building</span> in progress</span><span><span class="b empty">empty</span> folder only</span><span><span class="b prop">proposed</span> not started</span></div>`;

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const badge = (cssClass: string, text: string) => `<span><span class="b ${cssClass}">${escapeHtml(text)}</span></span>`;

const row = (name: string, badgeCell: string, textCell: string) =>
  `<div class="row"><span class="name">${name}</span>${badgeCell}<span>${textCell}</span></div>`;

const statusBadge = (status: PackageStatus): string => {
  switch (status._tag) {
    case "Published":
      return badge("pub", status.version);
    case "Building":
      return badge("work", "building");
    case "Built":
      return badge("built", "built");
    case "Empty":
      return badge("empty", "empty");
    case "DocsOnly":
      return badge("empty", "docs only");
    case "Stub":
      return badge("empty", "stub");
    case "Proposed":
      return badge("prop", "proposed");
  }
};

/** The purpose line, plus for work in progress its npm version and next step: "Expo apps (0.2.0 on npm). Next: …". */
const rowText = (packageRow: PackageRow): string => {
  if (packageRow.status._tag !== "Building") {
    return Option.match(packageRow.purpose, { onNone: () => "", onSome: (purpose) => `${purpose}.` });
  }
  const onNpm = Option.map(packageRow.status.publishedVersion, (version) => `${version} on npm`);
  const lead = Option.match(packageRow.purpose, {
    onNone: () => onNpm,
    onSome: (purpose) =>
      Option.some(Option.match(onNpm, { onNone: () => purpose, onSome: (npm) => `${purpose} (${npm})` })),
  });
  return [...Option.toArray(lead), `Next: ${packageRow.status.next}`].map((sentence) => `${sentence}.`).join(" ");
};

const treeRows = (rows: ReadonlyArray<PackageRow>, indent: string): ReadonlyArray<string> =>
  rows.flatMap((packageRow, index) => {
    const isLast = index === rows.length - 1;
    return [
      row(`${indent}${isLast ? "└─ " : "├─ "}${escapeHtml(packageRow.name)}`, statusBadge(packageRow.status), escapeHtml(rowText(packageRow))),
      ...treeRows(packageRow.children, `${indent}${isLast ? "   " : "│  "}`),
    ];
  });

const groupRows = (group: GroupSection): string =>
  [
    `<div class="row"><span class="name node">${escapeHtml(group.label)}</span><span></span>${Option.match(group.description, {
      onNone: () => "<span></span>",
      onSome: (description) => `<span class="node">${escapeHtml(description)}</span>`,
    })}</div>`,
    ...treeRows(group.rows, ""),
  ].join("\n");

const decisionText = (decision: OpenDecision): string =>
  [
    ...Option.toArray(Option.map(decision.text, escapeHtml)),
    ...Option.getOrElse(decision.options, () => []).map(
      (option, index) => `<b>${String.fromCharCode(97 + index)}.</b> ${escapeHtml(option)}`,
    ),
  ].join(" ");

const decisionRows = (decisions: ReadonlyArray<OpenDecision>): string =>
  decisions.length === 0
    ? row("None open", "<span></span>", "")
    : decisions
        .map((decision, index) => row(`${index + 1}. ${escapeHtml(decision.title)}`, badge("prop", "open"), decisionText(decision)))
        .join("\n");

/** "Throwaway test. Left: npm 0.0.2, folder packages/@ozyman42/hi." */
const deleteText = (entry: PackageToDeleteRow): string => {
  const left = [
    ...Option.toArray(Option.map(entry.publishedVersion, (version) => `npm ${version}`)),
    ...Option.toArray(Option.map(entry.folderPath, (folderPath) => `folder packages/${folderPath}`)),
  ];
  return `${entry.reason}. Left: ${left.join(", ")}.`;
};

const deleteRows = (entries: ReadonlyArray<PackageToDeleteRow>): string =>
  entries.length === 0
    ? row("None", "<span></span>", "")
    : entries.map((entry) => row(escapeHtml(entry.name), badge("del", "delete"), escapeHtml(deleteText(entry)))).join("\n");

const cliBadge = (row: CliCommandRow): string => {
  switch (row.status) {
    case "Implemented":
      return badge("built", "implemented");
    case "Stub":
      return badge("empty", "stub");
    case "Group":
      return "<span></span>";
  }
};

const cliTreeRows = (rows: ReadonlyArray<CliCommandRow>, indent: string): ReadonlyArray<string> =>
  rows.flatMap((cliRow, index) => {
    const isLast = index === rows.length - 1;
    return [
      row(
        `${indent}${isLast ? "└─ " : "├─ "}${escapeHtml(cliRow.command)}`,
        cliBadge(cliRow),
        escapeHtml(Option.getOrElse(cliRow.description, () => "")),
      ),
      ...cliTreeRows(cliRow.children, `${indent}${isLast ? "   " : "│  "}`),
    ];
  });

const cliDocRow = (doc: CliDoc): string =>
  Option.match(doc.url, {
    onSome: (url) => row(`<a href="${escapeHtml(url)}">${escapeHtml(doc.path)}</a>`, badge("built", "doc"), ""),
    onNone: () => row(escapeHtml(doc.path), badge("prop", "not written"), ""),
  });

const cliRows = (cli: CliSection): string =>
  [
    `<div class="legend"><span>From <code>${escapeHtml(cli.source)}</code>, run in this checkout</span></div>`,
    ...cliTreeRows(cli.commands, ""),
    ...cli.docs.map(cliDocRow),
  ].join("\n");

export const renderDesignPage = (page: DesignPage): string =>
  [
    HEAD,
    "",
    "<h2>Open decisions</h2>",
    decisionRows(page.openDecisions),
    "",
    "<h2>To delete or unpublish</h2>",
    deleteRows(page.packagesToDelete),
    "",
    "<h2>Packages</h2>",
    LEGEND,
    "",
    page.groups.map(groupRows).join("\n\n"),
    "",
    "<h2>jive CLI</h2>",
    cliRows(page.cli),
    "</body></html>",
  ].join("\n") + "\n";
