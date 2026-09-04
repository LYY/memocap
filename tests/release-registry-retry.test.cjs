"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/release.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function workflowStep(marker) {
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${marker.trim()}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function stepRun(step) {
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start !== -1) {
    return step
      .slice(start + marker.length)
      .split("\n")
      .filter((line) => line.startsWith("          "))
      .map((line) => line.slice(10))
      .join("\n");
  }
  const inline = step.match(/^\s{8}run: (.+)$/m);
  assert.ok(inline, "missing workflow run command");
  return inline[1];
}

const inspectRegistry = stepRun(workflowStep("      - id: registry\n"));
const publishPackage = stepRun(workflowStep("      - name: Publish missing package\n"));
const verifyRegistry = stepRun(
  workflowStep("      - name: Verify registry package and provenance\n"),
);

function provenanceAudit(packageName, version, overrides) {
  const repository = overrides.provenanceRepository ?? "https://github.com/LYY/memocap";
  const ref = overrides.provenanceRef ?? `refs/tags/v${version}`;
  const sha = overrides.provenanceSha ?? "0123456789012345678901234567890123456789";
  const invocation = overrides.provenanceInvocation ?? "https://github.com/LYY/memocap/actions/runs/123/attempts/1";
  const statement = {
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            path: overrides.provenanceWorkflow ?? ".github/workflows/release.yml",
            ref,
          },
        },
        resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: sha } }],
      },
      runDetails: { metadata: { invocationId: invocation } },
    },
  };
  return {
    verified: [
      {
        name: packageName,
        version,
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              },
            },
          },
        ],
      },
    ],
  };
}

function writeFixture(context, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-registry-retry-"));
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  const counters = path.join(root, "counters");
  const state = path.join(root, "published");
  const log = path.join(root, "npm.log");
  const output = path.join(root, "github-output");
  const packageName = "@lyy-gh/memocap";
  const version = "0.0.2";
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(bin);
  fs.mkdirSync(workspace);
  fs.mkdirSync(temp);
  fs.mkdirSync(counters);
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      repository: { url: "https://github.com/LYY/memocap.git" },
    }),
  );
  fs.writeFileSync(
    path.join(bin, "npm-stub.cjs"),
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const command = process.argv[2];
const metadata = JSON.parse(process.env.FAKE_NPM_METADATA);
const audit = JSON.parse(process.env.FAKE_NPM_AUDIT);
function record(value) { fs.appendFileSync(process.env.FAKE_NPM_LOG, value + "\\n"); }
function consume(name) {
  const file = path.join(process.env.FAKE_NPM_COUNTERS, name);
  const value = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : Number(process.env[name] || 0);
  if (value < 1) return false;
  fs.writeFileSync(file, String(value - 1));
  return true;
}
if (command === "view") {
  record("view");
  if (!fs.existsSync(process.env.FAKE_NPM_STATE) || consume("FAKE_NPM_INVISIBLE_VIEWS")) {
    process.stderr.write("npm ERR! code E404\\n");
    process.exit(1);
  }
  if (consume("FAKE_NPM_BAD_INTEGRITY_VIEWS")) metadata.dist.integrity = "sha512-stale";
  process.stdout.write(JSON.stringify(metadata));
  process.exit(0);
}
if (command === "publish") {
  record("publish");
  fs.writeFileSync(process.env.FAKE_NPM_STATE, "present");
  process.exit(Number(process.env.FAKE_NPM_PUBLISH_STATUS));
}
if (command === "pack") {
  record("pack");
  process.stdout.write("[{\\"integrity\\":\\"sha512-fixture\\"}]");
  process.exit(0);
}
if (command === "init" || command === "install") {
  record(command);
  process.exit(0);
}
if (command === "audit") {
  record("audit");
  process.stdout.write(JSON.stringify(consume("FAKE_NPM_MISSING_PROVENANCE_AUDITS") ? { verified: [] } : audit));
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    '#!/usr/bin/env bash\nexec node "$(dirname "$0")/npm-stub.cjs" "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const metadata = {
    name: packageName,
    version,
    repository: { url: overrides.repositoryUrl ?? "https://github.com/LYY/memocap.git" },
    dist: { integrity: "sha512-fixture" },
  };
  const audit = overrides.audit ?? provenanceAudit(packageName, version, overrides);
  return {
    log,
    output,
    commandOptions: {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        GITHUB_REF: `refs/tags/v${version}`,
        GITHUB_REPOSITORY: "LYY/memocap",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_SHA: "0123456789012345678901234567890123456789",
        TAG: `v${version}`,
        TAG_SHA: "0123456789012345678901234567890123456789",
        FAKE_NPM_AUDIT: JSON.stringify(audit),
        FAKE_NPM_BAD_INTEGRITY_VIEWS: String(overrides.badIntegrityViews ?? 0),
        FAKE_NPM_COUNTERS: counters,
        FAKE_NPM_INVISIBLE_VIEWS: String(overrides.invisibleViews ?? 0),
        FAKE_NPM_LOG: log,
        FAKE_NPM_METADATA: JSON.stringify(metadata),
        FAKE_NPM_MISSING_PROVENANCE_AUDITS: String(overrides.missingProvenanceAudits ?? 0),
        FAKE_NPM_PUBLISH_STATUS: String(overrides.publishStatus ?? 0),
        FAKE_NPM_STATE: state,
      },
    },
  };
}

function run(command, fixture) { return spawnSync("bash", ["-c", command], fixture.commandOptions); }

function runFirstPublish(fixture) {
  const inspection = run(inspectRegistry, fixture);
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.match(fs.readFileSync(fixture.output, "utf8"), /^state=absent$/m);
  const publish = run(publishPackage, fixture);
  assert.equal(publish.status, 0, publish.stderr);
  return run(verifyRegistry, fixture);
}

test("recovery accepts a package from an earlier attempt of the same run", (context) => {
  const fixture = writeFixture(context, {
    invisibleViews: 2,
    provenanceInvocation: "https://github.com/LYY/memocap/actions/runs/123/attempts/1",
    publishStatus: 1,
  });
  assert.equal(run(inspectRegistry, fixture).status, 0);
  assert.equal(run(publishPackage, fixture).status, 0);
  fixture.commandOptions.env.GITHUB_RUN_ATTEMPT = "2";
  assert.equal(run(inspectRegistry, fixture).status, 0);
  assert.match(fs.readFileSync(fixture.output, "utf8"), /^state=present$/m);
  const verification = run(verifyRegistry, fixture);

  assert.equal(verification.status, 0, verification.stderr);
  const calls = fs.readFileSync(fixture.log, "utf8").trim().split("\n");
  assert.equal(calls.filter((call) => call === "publish").length, 1);
  assert.ok(calls.filter((call) => call === "view").length >= 4);
});

test("retries delayed integrity and provenance visibility", (context) => {
  const fixture = writeFixture(context, { badIntegrityViews: 1, missingProvenanceAudits: 1 });

  const verification = runFirstPublish(fixture);

  assert.equal(verification.status, 0, verification.stderr);
  const calls = fs.readFileSync(fixture.log, "utf8").trim().split("\n");
  assert.ok(calls.filter((call) => call === "audit").length >= 2);
  assert.equal(calls.filter((call) => call === "publish").length, 1);
});

test("accepts a git+https registry repository URL", (context) => {
  const fixture = writeFixture(context, {
    repositoryUrl: "git+https://github.com/LYY/memocap.git",
  });

  const verification = runFirstPublish(fixture);

  assert.equal(verification.status, 0, verification.stderr);
});

test("rejects provenance not bound to this release workflow invocation", (context) => {
  for (const overrides of [
    { provenanceRepository: "https://github.com/other/memocap" },
    { provenanceWorkflow: ".github/workflows/other.yml" },
    { provenanceRef: "refs/tags/v0.0.1" },
    { provenanceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { provenanceInvocation: "https://github.com/LYY/memocap/actions/runs/122/attempts/not-a-number" },
  ]) {
    const fixture = writeFixture(context, overrides);
    const verification = runFirstPublish(fixture);

    assert.notEqual(verification.status, 0);
  }
});
