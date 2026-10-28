"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function isolatedPackage(f) {
  const global = path.join(f.prefix, "global/v11");
  const group = path.join(global, "123-456");
  const alias = path.join(global, "a".repeat(64));
  const installed = path.join(group, "node_modules/@lyy-gh/memocap");
  fs.mkdirSync(path.join(installed, "bin"), { recursive: true });
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0", bin: { memocap: "bin/cli.cjs" } }));
  fs.writeFileSync(path.join(installed, "bin/cli.cjs"), "console.log('memocap 0.1.0');\n");
  fs.symlinkSync(group, alias, "junction");
  fs.mkdirSync(path.dirname(f.cliPath), { recursive: true });
  const target = path.join(alias, "node_modules/@lyy-gh/memocap/bin/cli.cjs");
  fs.writeFileSync(f.cliPath, process.platform === "win32" ? `@echo off\r\n:: cmd-shim-target=${target}\r\n` : `#!/bin/sh\nexec node "${target}" "$@"\n# cmd-shim-target=${target}\n`, { mode: 0o755 });
  const run = f.runtime.run;
  f.runtime.run = (command, args, options) => {
    if (command !== "pnpm") return command === "npm" ? Promise.resolve({ code: 127, stdout: "", stderr: "absent" }) : run(command, args, options);
    const stdout = args[0] === "list" ? JSON.stringify([{ path: global, dependencies: { "@lyy-gh/memocap": { version: "0.1.0", path: installed } } }]) : args[0] === "root" ? global : args[0] === "--version" ? "12.14.0" : path.dirname(f.cliPath);
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  return { installed, target, global, alias };
}

test("pnpm isolated manager inventory and hash shim identify one real package", async (context) => {
  const f = fixture(context);
  const { installed } = isolatedPackage(f);
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  const cli = await discoverCLI(f.runtime, {});
  assert.equal(fs.realpathSync(cli.package_root), fs.realpathSync(installed));
  assert.equal(cli.executable_path, f.cliPath);
  assert.equal(cli.manager, "pnpm");
});

test("a manager-owned package does not authorize an unrelated PATH executable", async (context) => {
  const f = fixture(context);
  f.installCLI("0.1.0");
  fs.rmSync(f.cliPath);
  fs.writeFileSync(f.cliPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  await assert.rejects(discoverCLI(f.runtime, {}), { code: "unowned_cli" });
});

test("skill discovery prunes dependencies and bounds canonical symlink cycles", async (context) => {
  const f = fixture(context);
  const root = path.join(f.home, ".agents/skills");
  const canonical = path.join(root, "memocap");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "SKILL.md"), "---\nname: memocap\n---\n");
  for (const ignored of ["node_modules/.pnpm", ".git", "vendor"]) {
    fs.mkdirSync(path.join(root, "targa-local-login", ignored, ...Array(9).fill("deep")), { recursive: true });
  }
  fs.symlinkSync(root, path.join(root, "cycle"), "junction");
  fs.symlinkSync(canonical, path.join(root, "alias"), "junction");
  const { skillFiles } = await import("../scripts/setup/files.mjs");
  const files = skillFiles(root);
  assert.equal(files.length, 2);
  assert.equal(new Set(files.map((filename) => fs.realpathSync(filename))).size, 1);
  assert.equal(fs.realpathSync(files[0]), fs.realpathSync(path.join(canonical, "SKILL.md")));
});

test("deep dependencies alone do not hide a discoverable skill", async (context) => {
  const f = fixture(context);
  const root = path.join(f.home, ".agents/skills");
  fs.mkdirSync(path.join(root, "targa-local-login/node_modules/.pnpm", ...Array(9).fill("deep")), { recursive: true });
  fs.mkdirSync(path.join(root, "memocap"));
  fs.writeFileSync(path.join(root, "memocap/SKILL.md"), "---\nname: memocap\n---\n");
  const { skillFiles } = await import("../scripts/setup/files.mjs");
  assert.equal(skillFiles(root).length, 1);
});

test("pnpm inventory aliases deduplicate but distinct install groups conflict", async (context) => {
  const f = fixture(context);
  const { installed, alias, global } = isolatedPackage(f);
  const { pnpmRoot } = await import("../scripts/setup/pnpm.mjs");
  const run = f.runtime.run;
  let duplicate = path.join(alias, "node_modules/@lyy-gh/memocap");
  f.runtime.run = (command, args, options) => command === "pnpm" && args[0] === "list" ? Promise.resolve({ code: 0, stdout: JSON.stringify([installed, duplicate].map((directory) => ({ dependencies: { "@lyy-gh/memocap": { path: directory, version: "0.1.0" } } }))) }) : run(command, args, options);
  assert.equal(fs.realpathSync(path.join(await pnpmRoot(f.runtime), "@lyy-gh/memocap")), fs.realpathSync(installed));
  duplicate = path.join(global, "second/node_modules/@lyy-gh/memocap");
  fs.cpSync(installed, duplicate, { recursive: true });
  await assert.rejects(pnpmRoot(f.runtime), { code: "duplicate_managers" });
});

test("pnpm inventory version disagreement and stale shim targets are refused", async (context) => {
  const f = fixture(context);
  const { installed, target } = isolatedPackage(f);
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  const metadata = path.join(installed, "package.json");
  const original = fs.readFileSync(metadata, "utf8");
  fs.writeFileSync(metadata, original.replace('"0.1.0"', '"0.0.10"'));
  await assert.rejects(discoverCLI(f.runtime, {}), { code: "package_identity" });
  fs.writeFileSync(metadata, original);
  fs.writeFileSync(f.cliPath, `#!/bin/sh\n# cmd-shim-target=${target}.stale\n`, { mode: 0o755 });
  await assert.rejects(discoverCLI(f.runtime, {}), { code: "unowned_cli" });
});

test("a manual 0.1.0 release can plan a later upgrade without a setup manifest", async (context) => {
  const f = fixture(context);
  f.installCLI("0.1.0");
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, JSON.stringify({ plugin: ["@lyy-gh/memocap@0.1.0"] }));
  const paths = f.skillPaths(f.project, true);
  fs.mkdirSync(path.dirname(paths.canonical), { recursive: true });
  fs.cpSync(path.join(f.installed, "skills/memocap"), paths.canonical, { recursive: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ version: 3, skills: { memocap: { source: "LYY/memocap", sourceType: "github", ref: "v0.1.0", sourceUrl: "https://github.com/LYY/memocap/tree/v0.1.0" } } }));
  const [major, minor] = JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"))).version.split(".").map(Number);
  const target = `${major}.${minor + 1}.0`;
  const report = await f.setup(["update", "--to", target, "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.manifest_path && fs.existsSync(report.manifest_path), false);
  fs.appendFileSync(path.join(paths.canonical, "SKILL.md"), "user edit\n");
  const changed = await f.setup(["update", "--to", target, "--dry-run"]);
  assert.equal(changed.error.code, "unowned_skill");
});
