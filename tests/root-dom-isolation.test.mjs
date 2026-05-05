import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

test("pinned folders do not replace the root explorer item or root data-path", () => {
  assert.doesNotMatch(source, /\brootItem\.file\s*=\s*pinnedRoot\b/);
  assert.doesNotMatch(source, /\binstallRootItemAlias\b/);
  assert.doesNotMatch(source, /\boverrideRootDropPath\s*\(/);
});
