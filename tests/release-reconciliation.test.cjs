"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/release.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function job(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n  [^\s]/);
  return workflow.slice(start, next === -1 ? undefined : start + marker.length + next);
}

test("keeps release workflow read-only while registry publishes through OIDC", () => {
  // Given
  const registry = job("registry");

  // When
  const releaseWrites = ["  release:\n", "contents: write", "gh release ", "workflow_dispatch"];

  // Then
  for (const releaseWrite of releaseWrites) {
    assert.equal(workflow.includes(releaseWrite), false, `forbidden release write: ${releaseWrite}`);
  }
  assert.match(registry, /environment: npm-release/);
  assert.match(registry, /id-token: write/);
  assert.match(registry, /npm publish --access public --provenance --ignore-scripts/);
});
