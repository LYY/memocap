"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("jsonc-parser");
const { fixture } = require("./setup-fixtures.cjs");

const tools = ["memocap_recall", "memocap_read"];
const grantPaths = tools.map((tool) => ["permission", tool, "library"]);

function permissionFixture(context, config) {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.5.0" }));
  setup.state.stable = "0.5.0";
  if (config !== undefined) {
    fs.mkdirSync(path.dirname(setup.config), { recursive: true });
    fs.writeFileSync(setup.config, typeof config === "string" ? config : JSON.stringify(config));
  }
  return setup;
}

function readConfig(setup) { return parse(fs.readFileSync(setup.config, "utf8")); }
function readRecord(report) { return JSON.parse(fs.readFileSync(report.manifest_path)).installs[report.scopes[0].owner_id]; }
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map((name) => {
    const filename = path.join(root, name);
    return [name, fs.statSync(filename).isFile() ? fs.readFileSync(filename).toString("hex") : null];
  });
}

async function installed05(context, config) {
  const setup = permissionFixture(context, config);
  const installed = await setup.setup(["install", "--yes"]);
  if (installed.exit_code !== 0) throw new Error(JSON.stringify(installed.error));
  const current = readConfig(setup);
  delete current.permission;
  fs.writeFileSync(setup.config, JSON.stringify(current));
  const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
  delete manifest.installs[installed.scopes[0].id].permissions;
  fs.writeFileSync(installed.manifest_path, JSON.stringify(manifest));
  return { setup, installed };
}

module.exports = { tools, grantPaths, permissionFixture, readConfig, readRecord, snapshot, installed05 };
