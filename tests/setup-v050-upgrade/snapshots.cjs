"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { snapshot } = require("../packaged-runtime.cjs");

function databaseSnapshot(filename) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec("BEGIN");
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const tables = {};
    for (const { name } of schema.filter((entry) => entry.type === "table" && entry.name !== "schema_metadata")) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      tables[name] = database.prepare(`SELECT * FROM ${quoted}`).all()
        .map((row) => Object.fromEntries(Object.entries(row)))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    const version = database.prepare("SELECT major,minor FROM schema_metadata WHERE singleton=1").get();
    database.exec("COMMIT");
    return { schema_version: `${version.major}.${version.minor}`, schema, tables };
  } finally { database.close(); }
}

async function managedSnapshot(fixture, config) {
  const { createRequire } = require("node:module");
  const jsonc = createRequire(path.join(fixture.installedRoot, "package.json"))("jsonc-parser");
  const text = fs.readFileSync(config, "utf8");
  const parsed = jsonc.parse(text);
  const manifestPath = path.join(fixture.env.XDG_STATE_HOME, "memocap/setup.json");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.format_version, 2);
  const records = Object.values(manifest.installs);
  assert.equal(records.length, 1);
  const owner = records[0];
  assert.equal(fs.realpathSync(owner.config), fs.realpathSync(config));
  assert.equal(owner.kind, "global");
  assert.equal(owner.skill.kind, "managed");
  const { inspectPolicy } = await import(pathToFileURL(path.join(fixture.installedRoot, "lib/policy.mjs")));
  const policy = inspectPolicy(owner.skill.path);
  const bundle = inspectPolicy(path.join(fixture.installedRoot, "skills/memocap"));
  assert.equal(policy.digest, bundle.digest);
  assert.equal(policy.digest, owner.skill.digest);
  assert.deepEqual(policy.files, bundle.files);
  const policyBytes = snapshot([owner.skill.path]);
  assert.ok(Object.values(policyBytes).every((value) => !value.startsWith("symlink:")));
  for (let directory = owner.skill.path; directory !== path.dirname(directory); directory = path.dirname(directory)) {
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, directory);
    if (fs.realpathSync(directory) === fs.realpathSync(fixture.env.XDG_CONFIG_HOME)) break;
  }
  assert.equal(parsed.plugin.length, 1);
  assert.equal(parsed.plugin[0][0], `@lyy-gh/memocap@${owner.version}`);
  assert.deepEqual(Object.keys(parsed.plugin[0][1]), ["skillDirectory"]);
  assert.equal(fs.realpathSync(parsed.plugin[0][1].skillDirectory), policy.directory);
  return { config_text: text, config: parsed, manifest_text: manifestText, manifest,
    policy: { directory: policy.directory, digest: policy.digest, files: policy.files, bytes: policyBytes } };
}

function assertRetained(before, after) {
  assert.deepEqual(after.tables, before.tables, "upgrade must retain all business, FTS, ledger and activity rows byte-for-byte");
  const unaffected = (schema) => schema.filter((entry) => !["activity_events", "activity_retention"].includes(entry.name));
  assert.deepEqual(unaffected(after.schema), unaffected(before.schema), "only activity DDL may change");
}

module.exports = { databaseSnapshot, managedSnapshot, assertRetained };
