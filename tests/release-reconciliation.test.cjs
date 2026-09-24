"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const assets = [
  "memocap-x86_64-unknown-linux-gnu",
  "memocap-aarch64-apple-darwin",
  "memocap-x86_64-pc-windows-msvc.exe",
];
const tag = "v0.0.9";
const tagSha = "0123456789012345678901234567890123456789";
const workflow = fs
  .readFileSync(path.resolve(__dirname, "../.github/workflows/release.yml"), "utf8")
  .replace(/\r\n/g, "\n");

function publicationScript() {
  const marker = "      - name: Publish verified GitHub Release assets\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "missing release publication step");
  const end = workflow.indexOf("\n      - ", start + marker.length);
  const step = workflow.slice(start, end === -1 ? undefined : end);
  const run = step.indexOf("        run: |\n");
  assert.notEqual(run, -1, "missing release publication script");
  return step
    .slice(run + "        run: |\n".length)
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
}

function writeAsset(directory, name, content = `fixture:${name}`) {
  const binary = Buffer.from(content);
  fs.writeFileSync(path.join(directory, name), binary);
  const digest = crypto.createHash("sha256").update(binary).digest("hex");
  fs.writeFileSync(path.join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
}

function writeGhStub(bin) {
  fs.writeFileSync(
    path.join(bin, "gh.cjs"),
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const remote = process.env.FAKE_GH_ASSETS;
const log = process.env.FAKE_GH_LOG;
const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
const record = () => fs.appendFileSync(log, args.join(" ") + "\\n");
const release = () => ({
  tagName: process.env.TAG,
  isDraft: false,
  isPrerelease: false,
  assets: state().assetNames.slice().sort().map((name) => ({ name })),
});
const copySources = () => {
  const current = state();
  const end = args.indexOf("--repo");
  for (const source of args.slice(3, end)) {
    const name = path.basename(source);
    fs.copyFileSync(source, path.join(remote, name));
    if (!current.assetNames.includes(name)) current.assetNames.push(name);
  }
  save(current);
};
record();
if (args[0] === "api") {
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha: process.env.TAG_SHA } }));
  process.exit(0);
}
if (args[0] !== "release") process.exit(1);
if (args[1] === "view") {
  if (!state().exists) process.exit(1);
  process.stdout.write(JSON.stringify(release()));
  process.exit(0);
}
if (args[1] === "create") {
  if (state().exists || !args.includes("--verify-tag") || !args.includes("--target")) process.exit(2);
  copySources();
  save({ ...state(), exists: true });
  process.exit(0);
}
if (args[1] === "upload") {
  if (!state().exists || !args.includes("--clobber")) process.exit(3);
  copySources();
  process.exit(0);
}
if (args[1] === "download") {
  const directory = args[args.indexOf("--dir") + 1];
  for (const name of state().assetNames) {
    fs.copyFileSync(path.join(remote, name), path.join(directory, name));
  }
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/usr/bin/env bash\nargs=("$@")\nif command -v cygpath >/dev/null 2>&1; then\n  for variable in FAKE_GH_ASSETS FAKE_GH_LOG FAKE_GH_SCRIPT FAKE_GH_STATE; do\n    export "$variable=$(cygpath -w "${!variable}")"\n  done\n  for index in "${!args[@]}"; do\n    if [ "${args[$index]}" = "--dir" ]; then\n      next=$((index + 1))\n      args[$next]=$(cygpath -w "${args[$next]}")\n    fi\n  done\nfi\nexec node "$FAKE_GH_SCRIPT" "${args[@]}"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "mktemp"),
    '#!/usr/bin/env bash\nmkdir -p verify-directory\nprintf "%s\\n" verify-directory\n',
    { mode: 0o755 },
  );
}

function fixture(
  context,
  {
    existing = false,
    unexpected = false,
    mismatched = false,
    remoteUnexpected = false,
    remoteUnknownName,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-publication-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const releaseAssets = path.join(root, "release-assets");
  const remoteAssets = path.join(root, "remote-assets");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(releaseAssets);
  fs.mkdirSync(remoteAssets);
  const assetNames = [];
  for (const asset of assets) {
    writeAsset(releaseAssets, asset);
    if (existing) {
      writeAsset(remoteAssets, asset, `stale:${asset}`);
      assetNames.push(asset, `${asset}.sha256`);
    }
  }
  if (unexpected) fs.writeFileSync(path.join(releaseAssets, "unexpected"), "untrusted");
  if (remoteUnexpected) {
    fs.writeFileSync(path.join(remoteAssets, "unexpected"), "untrusted");
    assetNames.push("unexpected");
  }
  if (remoteUnknownName !== undefined) assetNames.push(remoteUnknownName);
  fs.writeFileSync(state, JSON.stringify({ exists: existing, assetNames }));
  if (mismatched) fs.writeFileSync(path.join(releaseAssets, `${assets[0]}.sha256`), `${"0".repeat(64)}  ${assets[0]}\n`);
  writeGhStub(bin);
  return { bin, log, releaseAssets, remoteAssets, root, state };
}

function runPublication(release) {
  return spawnSync("bash", ["-c", publicationScript()], {
    cwd: release.root,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_ASSETS: release.remoteAssets,
      FAKE_GH_LOG: release.log,
      FAKE_GH_SCRIPT: path.join(release.bin, "gh.cjs"),
      FAKE_GH_STATE: release.state,
      GH_TOKEN: "fixture-token",
      GITHUB_REPOSITORY: "LYY/memocap",
      MSYS_NO_PATHCONV: "1",
      PATH: `${release.bin}${path.delimiter}${process.env.PATH}`,
      TAG: tag,
      TAG_SHA: tagSha,
    },
  });
}

function publicationFailureDetails(execution, release) {
  const details = [execution.error?.message, execution.stdout, execution.stderr];
  if (fs.existsSync(release.log)) details.push(fs.readFileSync(release.log, "utf8"));
  if (fs.existsSync(release.state)) details.push(fs.readFileSync(release.state, "utf8"));
  return details.filter(Boolean).join("\n");
}

function expectedNames() {
  return assets.flatMap((asset) => [asset, `${asset}.sha256`]).sort();
}

test("creates a public release with every launcher asset and checksum", (context) => {
  const release = fixture(context);

  const execution = runPublication(release);

  assert.equal(execution.status, 0, publicationFailureDetails(execution, release));
  assert.deepEqual(fs.readdirSync(release.remoteAssets).sort(), expectedNames());
  const log = fs.readFileSync(release.log, "utf8");
  assert.match(log, new RegExp(`release create ${tag} .*--verify-tag --target ${tagSha}`));
  assert.doesNotMatch(log, /release upload/);
});

test("replaces only known release assets on an idempotent rerun", (context) => {
  const release = fixture(context, { existing: true });

  const execution = runPublication(release);

  assert.equal(execution.status, 0, publicationFailureDetails(execution, release));
  assert.deepEqual(fs.readdirSync(release.remoteAssets).sort(), expectedNames());
  for (const name of expectedNames()) {
    assert.deepEqual(
      fs.readFileSync(path.join(release.remoteAssets, name)),
      fs.readFileSync(path.join(release.releaseAssets, name)),
    );
  }
  const log = fs.readFileSync(release.log, "utf8");
  assert.match(log, new RegExp(`release upload ${tag} .*--clobber`));
  assert.doesNotMatch(log, /release create/);
});

test("rejects an unknown existing asset before a release write", (context) => {
  const release = fixture(context, { existing: true, remoteUnexpected: true });

  const execution = runPublication(release);

  assert.notEqual(execution.status, 0);
  const log = fs.readFileSync(release.log, "utf8");
  assert.doesNotMatch(log, /release (create|upload)/);
});

for (const [caseName, remoteUnknownName] of [
  ["whitespace-composed", `${assets[0]} ${assets[1]}`],
  ["newline-containing", `unknown\n${assets[0]}`],
  ["shell-metacharacter", "unknown;$()[]*?"],
]) {
  test(`rejects a ${caseName} unknown asset before a release write`, (context) => {
    const release = fixture(context, { existing: true, remoteUnknownName });
    const recognizedBytes = new Map(
      expectedNames().map((name) => [name, fs.readFileSync(path.join(release.remoteAssets, name))]),
    );

    const execution = runPublication(release);

    assert.notEqual(execution.status, 0);
    const log = fs.readFileSync(release.log, "utf8");
    assert.doesNotMatch(log, /release (create|upload)/);
    for (const [name, before] of recognizedBytes) {
      assert.deepEqual(fs.readFileSync(path.join(release.remoteAssets, name)), before);
    }
  });
}

for (const scenario of [
  { name: "unexpected artifact", options: { unexpected: true } },
  { name: "mismatched checksum", options: { mismatched: true } },
]) {
  test(`rejects ${scenario.name} before a release write`, (context) => {
    const release = fixture(context, scenario.options);

    const execution = runPublication(release);

    assert.notEqual(execution.status, 0);
    assert.deepEqual(fs.readdirSync(release.remoteAssets), []);
    assert.equal(fs.existsSync(release.log), false);
  });
}
