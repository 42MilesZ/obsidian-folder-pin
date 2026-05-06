import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

test("pinned folders do not replace the root explorer item or root data-path", () => {
  assert.doesNotMatch(source, /\brootItem\.file\s*=\s*pinnedRoot\b/);
  assert.doesNotMatch(source, /\binstallRootItemAlias\b/);
  assert.doesNotMatch(source, /\boverrideRootDropPath\s*\(/);
});

test("layout changes do not fully rebuild existing explorer controllers", () => {
  assert.match(source, /\bexisting\.syncUi\(\);/);
  assert.doesNotMatch(source, /\bexisting\.refreshUi\(\);\s*continue;/);
});

test("tab status rendering is skipped when the rendered state is unchanged", () => {
  assert.match(source, /\bstatusRenderKey\b/);
  assert.match(source, /this\.statusRenderKey !== nextRenderKey/);
  assert.match(source, /this\.statusEl\.replaceChildren\(fragment\);/);
});
