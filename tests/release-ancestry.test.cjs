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
  const bin = path.join(root, "test-bin");
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
  const main = commit(root, "release-validation-later-main", "later\n");
  git(root, ["push", "origin", "main"]);

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(root, "run"),
    `"use strict";
const expected = [
  "list", "--repo", "LYY/memocap", "--workflow", "CI", "--event", "push",
  "--branch", "main", "--commit", process.env.GITHUB_EXPECTED_SHA,
  "--status", "completed", "--json", "conclusion,event,headBranch,headSha,name",
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  process.stderr.write("unexpected gh run arguments\\n");
  process.exit(1);
}
process.stdout.write(process.env.GITHUB_CI_RUNS);
`,
  );
  const gh = path.join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, gh);
  } else {
    fs.symlinkSync(process.execPath, gh);
  }

  return { current, main, root, bin };
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

function validationResult(release, options) {
  const output = path.join(release.root, `github-output-${options.tag}`);
  return spawnSync("bash", ["-c", validationScript()], {
    cwd: release.root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_CI_RUNS: JSON.stringify(options.runs),
      GITHUB_EXPECTED_SHA: options.expectedSha,
      GITHUB_OUTPUT: output,
      GITHUB_REF_NAME: options.tag,
      GITHUB_REPOSITORY: "LYY/memocap",
      GITHUB_WORKFLOW_REF: options.workflowRef
        ?? `LYY/memocap/${workflowPath}@refs/tags/${options.tag}`,
      GITHUB_WORKFLOW_SHA: options.workflowSha,
      GH_TOKEN: "fixture-token",
      MSYS_NO_PATHCONV: "1",
      PATH: `${release.bin}${path.delimiter}${process.env.PATH}`,
    },
  });
}

function tag(root, name, sha) {
  git(root, ["tag", name, sha]);
}

function successfulCi(sha) {
  return {
    conclusion: "success",
    event: "push",
    headBranch: "main",
    headSha: sha,
    name: "CI",
  };
}

test("accepts a tested tag from main history after main advances", (context) => {
  // Given
  const release = fixture(context);
  const tagName = "v0.0.8-main-ancestor";
  tag(release.root, tagName, release.current);

  // When
  const execution = validationResult(release, {
    expectedSha: release.current,
    runs: [successfulCi(release.current)],
    tag: tagName,
    workflowSha: release.current,
  });

  // Then
  assert.equal(execution.status, 0, execution.stderr);
  assert.notEqual(release.current, release.main);
});

test("rejects a tag outside origin main history", (context) => {
  // Given
  const release = fixture(context);
  const outside = git(release.root, [
    "commit-tree",
    `${release.current}^{tree}`,
    "-p",
    release.current,
    "-m",
    "outside main",
  ]);
  const tagName = "v0.0.8-off-main";
  tag(release.root, tagName, outside);

  // When
  const execution = validationResult(release, {
    expectedSha: outside,
    runs: [successfulCi(outside)],
    tag: tagName,
    workflowSha: release.current,
  });

  // Then
  assert.notEqual(execution.status, 0);
});

for (const [name, runs] of [
  ["missing", []],
  ["failed", [{ ...successfulCi("expected"), conclusion: "failure" }]],
  ["wrong-event", [{ ...successfulCi("expected"), event: "pull_request" }]],
  ["wrong-branch", [{ ...successfulCi("expected"), headBranch: "release" }]],
  ["wrong-sha", [successfulCi("other")]],
]) {
  test(`rejects ${name} CI evidence`, (context) => {
    // Given
    const release = fixture(context);
    const tagName = `v0.0.8-${name}`;
    tag(release.root, tagName, release.current);
    const exactRuns = runs.map((run) => ({
      ...run,
      headSha: run.headSha === "expected" ? release.current : run.headSha,
    }));

    // When
    const execution = validationResult(release, {
      expectedSha: release.current,
      runs: exactRuns,
      tag: tagName,
      workflowSha: release.current,
    });

    // Then
    assert.notEqual(execution.status, 0);
  });
}

test("rejects a workflow ref that does not identify the tag workflow", (context) => {
  // Given
  const release = fixture(context);
  const tagName = "v0.0.8-workflow-ref";
  tag(release.root, tagName, release.current);

  // When
  const execution = validationResult(release, {
    expectedSha: release.current,
    runs: [successfulCi(release.current)],
    tag: tagName,
    workflowRef: "LYY/memocap/.github/workflows/release.yml@refs/tags/v0.0.8-other",
    workflowSha: release.current,
  });

  // Then
  assert.notEqual(execution.status, 0);
});
