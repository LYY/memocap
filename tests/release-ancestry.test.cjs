"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/release.yml"),
  "utf8",
);

function git(root, args) {
  const execution = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout.trim();
}

function commit(root, name, content) {
  fs.writeFileSync(path.join(root, name), content);
  git(root, ["add", name]);
  git(root, ["commit", "-m", `add ${name}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-ancestry-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Release Test"]);
  const ancestor = commit(root, "base", "base\n");
  commit(root, "main", "main\n");
  const main = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", main]);
  git(root, ["checkout", "-b", "divergent", ancestor]);
  const divergent = commit(root, "divergent", "divergent\n");
  return { ancestor, divergent, root };
}

function ancestryResult(root, sha) {
  assert.match(workflow, /git merge-base --is-ancestor "\$sha" origin\/main/);
  return spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("accepts a tag SHA that is an ancestor of origin/main", (context) => {
  const release = fixture(context);

  const execution = ancestryResult(release.root, release.ancestor);

  assert.equal(execution.status, 0, execution.stderr);
});

test("rejects a divergent tag SHA", (context) => {
  const release = fixture(context);

  const execution = ancestryResult(release.root, release.divergent);

  assert.notEqual(execution.status, 0);
});

test("binds tag recovery to an approved release workflow snapshot", () => {
  assert.match(workflow, /GITHUB_WORKFLOW_SHA/);
  assert.match(workflow, /GITHUB_WORKFLOW_REF/);
  assert.match(
    workflow,
    /release_recovery_sha="86b4c20a79db2d4cac3eeaeebf19143778e572d2"/,
  );
  assert.match(workflow, /tag_workflow="\$\(git rev-parse "\$sha:\.github\/workflows\/release\.yml"\)"/);
  assert.match(workflow, /main_workflow="\$\(git rev-parse "origin\/main:\.github\/workflows\/release\.yml"\)"/);
  assert.match(workflow, /workflow_identity="\$\(git rev-parse "\$GITHUB_WORKFLOW_SHA:\.github\/workflows\/release\.yml"\)"/);
  assert.match(
    workflow,
    /expected_workflow_ref="\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml@refs\/tags\/\$tag"/,
  );
  assert.match(workflow, /\[ "\$GITHUB_WORKFLOW_REF" = "\$expected_workflow_ref" \]/);
});
