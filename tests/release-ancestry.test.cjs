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
).replace(/\r\n/g, "\n");
const repositoryRoot = path.resolve(__dirname, "..");
const workflowPath = ".github/workflows/release.yml";

function git(root, args) {
  const execution = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout.trim();
}

function commit(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  git(root, ["add", name]);
  git(root, ["commit", "-m", `add ${name}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-ancestry-"));
  const remote = path.join(directory, "origin.git");
  const root = path.join(directory, "checkout");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, ["clone", "--bare", repositoryRoot, remote]);
  git(directory, ["--git-dir", remote, "update-ref", "refs/heads/main", git(repositoryRoot, ["rev-parse", "HEAD"])]);
  git(directory, ["clone", "--branch", "main", remote, root]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Release Test"]);
  fs.writeFileSync(path.join(root, workflowPath), workflow);
  fs.writeFileSync(path.join(root, "release-validation-current"), "current\n");
  git(root, ["add", workflowPath, "release-validation-current"]);
  git(root, ["commit", "-m", "current release workflow"]);
  const current = git(root, ["rev-parse", "HEAD"]);
  const main = commit(root, "release-validation-final", "final\n");
  git(root, ["push", "origin", "main"]);
  return { current, main, root };
}

function validationScript() {
  const step = workflow.indexOf("      - id: release\n");
  const run = workflow.indexOf("        run: |\n", step);
  const end = workflow.indexOf("\n      - name: Verify actionlint", run);
  assert.notEqual(step, -1, "missing release identity step");
  assert.notEqual(run, -1, "missing release identity script");
  assert.notEqual(end, -1, "missing release identity script boundary");
  return workflow
    .slice(run + "        run: |\n".length, end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function validationResult(root, tag, workflowSha) {
  const output = path.join(root, "github-output");
  return spawnSync("bash", ["-c", validationScript()], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: "1",
      GITHUB_OUTPUT: output,
      GITHUB_REF_NAME: tag,
      GITHUB_REPOSITORY: "LYY/memocap",
      GITHUB_WORKFLOW_REF: `LYY/memocap/${workflowPath}@refs/tags/${tag}`,
      GITHUB_WORKFLOW_SHA: workflowSha,
    },
  });
}

function tag(root, name, sha) {
  git(root, ["tag", name, sha]);
}

test("accepts a tag from the final origin/main commit", (context) => {
  const release = fixture(context);
  const name = "v0.0.2-final";
  tag(release.root, name, release.main);

  const execution = validationResult(release.root, name, release.main);

  assert.equal(execution.status, 0, execution.stderr);
});

test("rejects a tag from an ancestor with the current workflow snapshot", (context) => {
  const release = fixture(context);
  const name = "v0.0.2-ancestor";
  tag(release.root, name, release.current);

  const execution = validationResult(release.root, name, release.current);

  assert.notEqual(execution.status, 0);
});
