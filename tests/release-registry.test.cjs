"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const releaseWorkflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/release.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function workflowStep(marker) {
  const start = releaseWorkflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${marker.trim()}`);
  const end = releaseWorkflow.indexOf("\n      - ", start + marker.length);
  return releaseWorkflow.slice(start, end === -1 ? undefined : end);
}

function blockRun(step) {
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, "missing block run command");
  return step
    .slice(start + marker.length)
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
}

function stepRun(step) {
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start !== -1) {
    return blockRun(step);
  }
  const match = step.match(/^\s{8}run: (.+)$/m);
  assert.ok(match, "missing workflow run command");
  return match[1];
}

const inspectRegistry = blockRun(workflowStep("      - id: registry\n"));
const publishPackage = stepRun(workflowStep("      - name: Publish missing package\n"));
const verifyRegistry = blockRun(
  workflowStep("      - name: Verify registry package and provenance\n"),
);

function provenanceAudit(packageName, version) {
  const repository = "https://github.com/LYY/memocap";
  const ref = `refs/tags/v${version}`;
  const statement = {
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository, path: ".github/workflows/release.yml", ref },
        },
        resolvedDependencies: [
          {
            uri: `git+${repository}@${ref}`,
            digest: { gitCommit: "0123456789012345678901234567890123456789" },
          },
        ],
      },
      runDetails: {
        metadata: {
          invocationId: "https://github.com/LYY/memocap/actions/runs/123/attempts/1",
        },
      },
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-registry-"));
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  const state = path.join(root, "published");
  const log = path.join(root, "npm.log");
  const output = path.join(root, "github-output");
  const packageName = "@lyy-gh/memocap";
  const version = "0.0.1";

  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(bin);
  fs.mkdirSync(workspace);
  fs.mkdirSync(temp);
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
    [
      '"use strict";',
      'const fs = require("node:fs");',
      "const command = process.argv[2];",
      'function record(entry) { fs.appendFileSync(process.env.FAKE_NPM_LOG, entry + "\\n"); }',
      'if (command === "view") {',
      '  record("view");',
      '  if (!fs.existsSync(process.env.FAKE_NPM_STATE) || process.env.FAKE_NPM_FRESH_MODE === "e404") {',
      '    process.stderr.write("npm ERR! code E404\\n");',
      "    process.exit(1);",
      "  }",
      '  if (process.env.FAKE_NPM_FRESH_MODE === "malformed") {',
      '    process.stdout.write("not-json");',
      "    process.exit(0);",
      "  }",
      "  process.stdout.write(process.env.FAKE_NPM_METADATA);",
      "  process.exit(0);",
      "}",
      'if (command === "publish") {',
      '  record("publish");',
      '  fs.writeFileSync(process.env.FAKE_NPM_STATE, "present");',
      "  process.exit(0);",
      "}",
      'if (command === "pack") {',
      '  record("pack");',
      '  process.stdout.write(JSON.stringify([{ integrity: "sha512-fixture" }]));',
      "  process.exit(0);",
      "}",
      'if (command === "install") {',
      "  record(command);",
      "  process.exit(0);",
      "}",
      'if (command === "audit") {',
      '  record("audit");',
      "  process.stdout.write(process.env.FAKE_NPM_AUDIT);",
      "  process.exit(0);",
      "}",
      'process.stderr.write("unsupported npm command: " + command + "\\n");',
      "process.exit(1);",
      "",
    ].join("\n"),
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

  const metadata = overrides.metadata ?? {
    name: packageName,
    version,
    repository: { url: "https://github.com/LYY/memocap.git" },
    dist: { integrity: "sha512-fixture" },
  };
  const audit = overrides.audit ?? provenanceAudit(packageName, version);

  return {
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
        FAKE_NPM_LOG: log,
        FAKE_NPM_STATE: state,
        FAKE_NPM_METADATA: JSON.stringify(metadata),
        FAKE_NPM_AUDIT: JSON.stringify(audit),
        FAKE_NPM_FRESH_MODE: overrides.freshMode ?? "present",
      },
    },
    log,
    output,
  };
}

function run(command, fixture) {
  return spawnSync("bash", ["-c", command], fixture.commandOptions);
}

function runFirstPublish(fixture) {
  const inspect = run(inspectRegistry, fixture);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(fs.readFileSync(fixture.output, "utf8"), /^state=absent$/m);

  const publish = run(publishPackage, fixture);
  assert.equal(publish.status, 0, publish.stderr);
  return run(verifyRegistry, fixture);
}

function npmCalls(fixture) {
  return fs.readFileSync(fixture.log, "utf8").trim().split("\n");
}

test("first publish re-reads matching registry metadata before provenance verification", (context) => {
  const fixture = writeFixture(context);

  const verification = runFirstPublish(fixture);

  assert.equal(verification.status, 0, verification.stderr);
  assert.deepEqual(npmCalls(fixture), ["view", "publish", "pack", "view", "install", "audit"]);
});

for (const [name, overrides] of [
  ["fresh E404", { freshMode: "e404" }],
  ["malformed fresh metadata", { freshMode: "malformed" }],
  [
    "mismatched fresh integrity",
    {
      metadata: {
        name: "@lyy-gh/memocap",
        version: "0.0.1",
        repository: { url: "https://github.com/LYY/memocap.git" },
        dist: { integrity: "sha512-mismatch" },
      },
    },
  ],
  ["missing installed provenance", { audit: { verified: [] } }],
  [
    "non-provenance attestation bundle",
    {
      audit: {
        verified: [
          {
            name: "@lyy-gh/memocap",
            version: "0.0.1",
            attestationBundles: [{ predicateType: "https://example.com/not-provenance" }],
          },
        ],
      },
    },
  ],
]) {
  test(`first publish rejects ${name} without a second publish`, (context) => {
    const fixture = writeFixture(context, overrides);

    const verification = runFirstPublish(fixture);

    assert.notEqual(verification.status, 0);
    assert.equal(npmCalls(fixture).filter((call) => call === "publish").length, 1);
  });
}
