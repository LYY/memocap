import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = path.join(root, "scripts/evaluate-retrieval.mjs");
const archive = process.env.RETRIEVAL_BASELINE_ARCHIVE;
const hash = (text) => createHash("sha256").update(text).digest("hex");

test("help accepts a protocol selection without loading it or opening a binary", () => {
  const argv = [runner, "--protocol", "/missing/protocol.mjs", "--binary", "/missing/native", "--help"];
  const result = spawnSync(process.execPath, argv, {encoding:"utf8"});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("--protocol PATH"));
});

test("a missing explicitly selected protocol fails before invoking the binary", () => {
  const argv = [runner, "--protocol", "/missing/protocol.mjs", "--binary", "/missing/native"];
  const result = spawnSync(process.execPath, argv, {encoding:"utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT.*\/missing\/protocol\.mjs/);
});

test("selected protocol executes its reexported query implementation and reports both source hashes", {
  skip:!archive && "Set RETRIEVAL_BASELINE_ARCHIVE to an immutable 0.5.0 archive",
}, async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "memocap-evaluator-option-"));
  try {
    const protocol = path.join(sandbox, "protocol.mjs");
    const query = path.join(sandbox, "query.mjs");
    const upstream = pathToFileURL(path.join(archive, "plugin/protocol.js")).href;
    writeFileSync(protocol, `export { referenceBlock, validateMemories } from ${JSON.stringify(upstream)};\nexport { queryTerms } from "./query.mjs";\n`);
    writeFileSync(query, 'export function queryTerms() { return ["Deployment"]; }\n');
    const result = spawnSync(process.execPath, [runner, "--binary", path.join(archive, "memocap-native"),
      "--protocol", protocol, "--split", "tuning"], {cwd:root, encoding:"utf8", timeout:30000, maxBuffer:4 * 1024 * 1024});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.protocolPath, protocol);
    assert.equal(report.protocolSha256, hash(readFileSync(protocol)));
    assert.equal(report.queryImplementation.path, query);
    assert.equal(report.queryImplementation.sha256, hash(readFileSync(query)));
    const selected = await import(pathToFileURL(query).href);
    assert.equal(report.queryImplementation.functionSha256, hash(selected.queryTerms.toString()));
    assert.equal(report.packageVersion, "0.5.0");
    assert.equal(report.cases.length, 12);
    assert.ok(report.cases.every((row) => row.argv[1] === "Deployment"));
    assert.ok(report.cases.every((row) => row.sourceResolution.status === "not_run"));
  } finally {
    rmSync(sandbox, {recursive:true, force:true});
  }
});
