"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/npm-bootstrap-v0.0.1.yml"),
  "utf8",
).replace(/\r\n/g, "\n");
const ciWorkflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/ci.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function workflowStep(marker) {
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${marker.trim()}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("bootstrap workflow permits one verified manual v0.0.1 publication", () => {
  const publish = workflowStep("      - name: Publish v0.0.1 package\n");

  assert.match(workflow, /^name: npm bootstrap v0\.0\.1$/m);
  assert.match(workflow, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(
    workflow,
    /^concurrency:\n  group: npm-publish-lyy-gh-memocap-v0-0-1\n  cancel-in-progress: false$/m,
  );
  assert.match(
    workflow,
    /if: github\.event\.inputs\.confirm == 'PUBLISH_V0_0_1'/,
  );
  assert.match(workflow, /environment: npm-bootstrap-v0-0-1/);
  assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(workflow, /node-version: "24\.20\.0"/);
  assert.match(workflow, /npm@11\.15\.0/);
  assert.match(workflow, /ref: v0\.0\.1/);
  assert.match(workflow, /TAG_SHA: 9e9dabe5a59b7e74decb376a0e0c4e5b1218b9a2/);
  assert.match(workflow, /npm view "\$package@\$version" --json/);
  assert.match(workflow, /npm audit signatures --json --include-attestations/);
  assert.equal((workflow.match(/for attempt in \{1\.\.10\}; do/g) ?? []).length, 2);
  assert.equal((workflow.match(/NPM_PUBLISH_TOKEN/g) ?? []).length, 1);
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_PUBLISH_TOKEN \}\}/);
  assert.match(publish, /npm publish --access public --provenance/);
  assert.doesNotMatch(publish, /(?:echo|printf).*NODE_AUTH_TOKEN/);
});

test("CI actionlint covers the bootstrap workflow", () => {
  assert.match(
    ciWorkflow,
    /actionlint" .github\/workflows\/ci\.yml .github\/workflows\/release\.yml .github\/workflows\/npm-bootstrap-v0\.0\.1\.yml/,
  );
});
