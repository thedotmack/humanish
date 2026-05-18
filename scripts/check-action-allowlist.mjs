#!/usr/bin/env node
/**
 * Verifies ACTION_REGISTRY (box) and ACTION_ALLOWLIST (broker) are in sync.
 *
 * Why this exists: adding an action without updating the broker allowlist is
 * a security bug — the broker would accept mints for the new action but the
 * bearer wouldn't be honored anywhere, OR (worse, if the broker side is
 * accidentally too permissive) a request for an unintended action could slip
 * through. Failing CI on divergence makes the dual-update mandatory.
 *
 * Strategy:
 *   - Broker side: extract the `Set<string>` literal contents from
 *     packages/broker/src/actions.ts. We match string literals that look like
 *     action IDs (`namespace.verb`) inside the ACTION_ALLOWLIST declaration.
 *   - Box side: read packages/box/action-runner/src/actions/index.ts, find
 *     each `import { FOO } from "./xyz.js"`, then read each xyz file and
 *     extract the `id: "..."` field. This catches an action whose filename
 *     doesn't match its registered ID.
 *   - Compare sorted lists. Fail on any divergence.
 *
 * Run: `pnpm check:allowlist` (also called from CI before deploy).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ----- broker side -----

const brokerActionsPath = join(repoRoot, "packages/broker/src/actions.ts");
const brokerSource = readFileSync(brokerActionsPath, "utf8");

// Slice between `ACTION_ALLOWLIST` and the next closing `])` after it. This
// keeps us from accidentally matching string literals elsewhere in the file
// (e.g. comments or future helpers).
const allowlistMatch = brokerSource.match(
  /ACTION_ALLOWLIST[\s\S]*?new Set<string>\(\[([\s\S]*?)\]\)/,
);
if (!allowlistMatch) {
  console.error(
    `Could not locate ACTION_ALLOWLIST in ${brokerActionsPath}. Check the file shape.`,
  );
  process.exit(2);
}
const allowlistBlock = allowlistMatch[1];
const brokerIds = [...allowlistBlock.matchAll(/['"]([a-z][a-z0-9]*\.[a-z][a-z0-9-]*)['"]/g)]
  .map((m) => m[1]);
const brokerSet = [...new Set(brokerIds)];

// ----- box side -----

const boxActionsDir = join(repoRoot, "packages/box/action-runner/src/actions");
const indexPath = join(boxActionsDir, "index.ts");
const indexSource = readFileSync(indexPath, "utf8");

// Pull every `from "./xyz.js"` or `from "./xyz"` import — those are the
// action modules. Skip the `.js` suffix that ESM resolution requires.
const importMatches = [
  ...indexSource.matchAll(/from\s+['"]\.\/([A-Za-z][A-Za-z0-9._-]*?)(?:\.js)?['"]/g),
];
const boxIds = [];
for (const im of importMatches) {
  const moduleName = im[1];
  // Each action file should expose `id: "namespace.verb" as const`. We accept
  // single or double quotes; we accept `as const` or no annotation.
  const sourcePath = join(boxActionsDir, `${moduleName}.ts`);
  let src;
  try {
    src = readFileSync(sourcePath, "utf8");
  } catch (err) {
    console.error(`Cannot read box action file ${sourcePath}: ${err.message}`);
    process.exit(2);
  }
  const idMatch = src.match(/\bid\s*:\s*['"]([a-z][a-z0-9]*\.[a-z][a-z0-9-]*)['"]/);
  if (!idMatch) {
    console.error(
      `Box action ${moduleName}.ts has no parseable \`id: "namespace.verb"\` field.`,
    );
    process.exit(2);
  }
  boxIds.push(idMatch[1]);
}
const boxSet = [...new Set(boxIds)];

// ----- compare -----

const brokerSorted = [...brokerSet].sort();
const boxSorted = [...boxSet].sort();

if (JSON.stringify(brokerSorted) !== JSON.stringify(boxSorted)) {
  console.error("ACTION_ALLOWLIST out of sync between broker and box.");
  console.error("  broker (ACTION_ALLOWLIST):", brokerSorted);
  console.error("  box    (ACTION_REGISTRY): ", boxSorted);
  const onlyInBroker = brokerSorted.filter((id) => !boxSorted.includes(id));
  const onlyInBox = boxSorted.filter((id) => !brokerSorted.includes(id));
  if (onlyInBroker.length) {
    console.error("  only in broker:", onlyInBroker);
  }
  if (onlyInBox.length) {
    console.error("  only in box:   ", onlyInBox);
  }
  process.exit(1);
}

console.log(`ACTION_ALLOWLIST in sync (${brokerSorted.length} action(s)):`, brokerSorted);
