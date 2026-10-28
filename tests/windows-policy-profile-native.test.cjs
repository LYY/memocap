"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { isolatedEnvironment, snapshot } = require("./packaged-runtime.cjs");

async function scanDriver() {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { snapshot } = require(process.argv[2]);
  const { inspectWindowsMetadata } = await import(process.argv[1]);
  const source = process.argv[3];
  const mode = process.argv[4];
  const originalEnv = { ...process.env };
  const before = snapshot([process.env.HOME, source]);
  let owned;
  let native;
  let folders;
  let cacheFiles;
  let caught;
  try {
    const observed = inspectWindowsMetadata(source, (executable, argv, options) => {
      owned = options.cwd;
      assert.equal(fs.statSync(owned).isDirectory(), true);
      assert.deepEqual(JSON.parse(options.input.toString("utf8")), { root: source });
      const script = Buffer.from(argv[3], "base64").toString("utf16le");
      const folderProbe = `[System.IO.File]::WriteAllLines([System.IO.Path]::Combine($env:TEMP, 'known-folders.txt'), [string[]]@(
        [Environment]::GetFolderPath('LocalApplicationData'), [Environment]::GetFolderPath('ApplicationData'),
        $PSVersionTable.PSVersion.ToString()))\n`;
      const fault = { nonzero: "exit 19", malformed: "[Console]::Write('{'); exit 0", timeout: "[Threading.Thread]::Sleep(30000)" }[mode];
      const encoded = Buffer.from(folderProbe + (fault || script), "utf16le").toString("base64");
      native = spawnSync(executable, [...argv.slice(0, -1), encoded], options);
      assert.equal(fs.statSync(owned).isDirectory(), true, "resources survive until the synchronous process exits");
      folders = fs.readFileSync(path.join(options.env.TEMP, "known-folders.txt"), "utf8").trim().split(/\r?\n/);
      assert.equal(folders[0].toLowerCase(), options.env.LOCALAPPDATA.toLowerCase());
      assert.equal(folders[1].toLowerCase(), options.env.APPDATA.toLowerCase());
      assert.match(folders[2], /^5\.1\./);
      cacheFiles = Object.keys(snapshot([options.env.LOCALAPPDATA])).filter((filename) => fs.statSync(filename).isFile()).map((filename) => path.relative(owned, filename));
      return native;
    });
    assert.equal(observed, null);
  } catch (error) { caught = error; }

  if (mode === "success") {
    if (caught) throw caught;
    assert.equal(native.status, 0);
    assert.ok(cacheFiles.some((filename) => filename.endsWith("StartupProfileData-NonInteractive")), "real PowerShell startup profiling writes under the owned profile");
  } else {
    assert.ok(caught, "fault injection must fail closed");
    assert.equal(caught.diagnostics, native);
    if (mode === "timeout") assert.equal(native.error?.code, "ETIMEDOUT");
    if (mode === "nonzero") assert.equal(native.status, 19);
    if (mode === "malformed") assert.equal(native.stdout.toString(), "{");
  }
  assert.equal(fs.existsSync(owned), false);
  assert.deepEqual({ ...process.env }, originalEnv);
  assert.deepEqual(snapshot([process.env.HOME, source]), before);
  console.log(JSON.stringify({ mode, powershell: folders[2], known_folders_owned: true, cache_files: cacheFiles,
    owned_removed: true, parent_home_unchanged: true, payload_unchanged: true, parent_env_unchanged: true,
    status: native.status, signal: native.signal, error: native.error?.code || null }));
}

for (const mode of ["success", "timeout", "nonzero", "malformed"]) {
  test(`native Windows cold child profile preserves parent HOME after ${mode === "success" ? "scan" : `actual PowerShell ${mode} fault injection`}`, {
    skip: process.platform !== "win32",
  }, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap native child profile "));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = isolatedEnvironment(root);
    env.TMP = env.TEMP = env.TMPDIR = env.HOME;
    const source = path.join(root, "payload 中文");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), "ordinary payload bytes");
    const before = snapshot([env.HOME, source]);
    const moduleURL = pathToFileURL(path.resolve(__dirname, "../lib/windows-policy-metadata.mjs")).href;
    const driver = `(${scanDriver.toString()})().catch(error => { console.error(error); process.exitCode = 1; })`;

    const output = execFileSync(process.execPath, ["-e", driver, moduleURL, path.join(__dirname, "packaged-runtime.cjs"), source, mode], {
      cwd: root, env, encoding: "utf8", timeout: 20000, windowsHide: true,
    });

    const report = JSON.parse(output);
    assert.equal(report.mode, mode);
    assert.equal(report.parent_home_unchanged, true);
    assert.deepEqual(snapshot([env.HOME, source]), before);
    context.diagnostic(JSON.stringify(report));
  });
}
