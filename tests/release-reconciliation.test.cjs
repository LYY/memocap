"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../.github/workflows/release.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function reconcileScript() {
  const marker = "      - name: Reconcile GitHub Release\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "missing release reconciliation step");
  const step = workflow.slice(start, workflow.indexOf("\n      - ", start + marker.length));
  const run = step.indexOf("        run: |\n");
  assert.notEqual(run, -1, "missing release reconciliation script");
  return step
    .slice(run + "        run: |\n".length)
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
}

const reconcile = reconcileScript();
const assets = [
  "memocap-x86_64-unknown-linux-gnu",
  "memocap-aarch64-apple-darwin",
  "memocap-x86_64-pc-windows-msvc.exe",
];

function writeAsset(directory, name) {
  const binary = Buffer.from(`fixture:${name}`);
  fs.writeFileSync(path.join(directory, name), binary);
  const digest = crypto.createHash("sha256").update(binary).digest("hex");
  fs.writeFileSync(path.join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
}

function writeGhStub(bin) {
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = process.env.FAKE_GH_ASSETS;
const draft = process.env.FAKE_GH_DRAFT;
const names = () => fs.readdirSync(state).sort();
const release = () => ({
  tag_name: process.env.TAG,
  target_commitish: process.env.TAG_SHA,
  draft: fs.readFileSync(draft, "utf8") === "true",
  prerelease: false,
  assets: names().map((name) => ({ name })),
});
if (args[0] === "api") {
  process.stdout.write(JSON.stringify([[release()]]));
  process.exit(0);
}
if (args[0] !== "release") process.exit(1);
if (args[1] === "download") {
  const pattern = args[args.indexOf("--pattern") + 1];
  const directory = args[args.indexOf("--dir") + 1];
  fs.copyFileSync(path.join(state, pattern), path.join(directory, pattern));
  process.exit(0);
}
if (args[1] === "upload") {
  const repo = args.indexOf("--repo");
  for (const source of args.slice(3, repo)) {
    fs.copyFileSync(source, path.join(state, path.basename(source)));
  }
  process.exit(0);
}
if (args[1] === "edit") {
  fs.writeFileSync(draft, "false");
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
}

function fixture(context, partial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-reconcile-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const releaseAssets = path.join(root, "release-assets");
  const remoteAssets = path.join(root, "remote-assets");
  const draft = path.join(root, "draft");
  fs.mkdirSync(bin);
  fs.mkdirSync(releaseAssets);
  fs.mkdirSync(remoteAssets);
  fs.writeFileSync(draft, "true");
  for (const asset of assets) writeAsset(releaseAssets, asset);
  const source = path.join(releaseAssets, assets[0]);
  const remote = partial === "binary" ? source : `${source}.sha256`;
  fs.copyFileSync(remote, path.join(remoteAssets, path.basename(remote)));
  writeGhStub(bin);
  return { bin, releaseAssets, remoteAssets, root, draft };
}

for (const partial of ["binary", "checksum"]) {
  test(`completes a draft release with only a ${partial} asset`, (context) => {
    const release = fixture(context, partial);

    const execution = spawnSync("bash", ["-c", reconcile], {
      cwd: release.root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "LYY/memocap",
        GITHUB_WORKSPACE: release.root,
        PATH: `${release.bin}${path.delimiter}${process.env.PATH}`,
        TAG: "v0.0.2",
        TAG_SHA: "0123456789012345678901234567890123456789",
        FAKE_GH_ASSETS: release.remoteAssets,
        FAKE_GH_DRAFT: release.draft,
      },
    });

    assert.equal(execution.status, 0, execution.stderr);
    const expected = assets.flatMap((asset) => [asset, `${asset}.sha256`]).sort();
    assert.deepEqual(fs.readdirSync(release.remoteAssets).sort(), expected);
    assert.equal(fs.readFileSync(release.draft, "utf8"), "false");
  });
}
