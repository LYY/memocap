"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const runtime = require("./packaged-runtime.cjs");

test("actual Windows encoded caller normalizes without decoding literal filesystem percent names", () => {
  const { linkLocation } = require("./packaged-link-location.cjs");
  const root = "C:/Users/RUNNER~1/AppData/Local/Temp/memocap-official-link-control-XPJMfe";
  const script = "/tools/node_modules/opencode-ai/postinstall.mjs";
  const frame = `    at copyBinary (file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/memocap-official-link-control-XPJMfe${script}:151:8)`;
  assert.equal(linkLocation(frame, [root]), `    at copyBinary (<sandbox>${script}:151:8)`);
  for (const [name, encoded] of [["~ space \u4e2d", "%7E%20space%20%E4%B8%AD"], ["literal%7E", "literal%257E"]]) {
    const directory = `C:/sandbox/${name}`;
    assert.equal(linkLocation(`file:///C:/sandbox/${encoded}${script}`, [directory]), `<sandbox>${script}`);
    assert.equal(linkLocation(`${directory}${script}`, [directory]), `<sandbox>${script}`);
  }
  assert.equal(linkLocation(`C:/sandbox/literal%7E${script}`, ["C:/sandbox/literal~"]), `C:/sandbox/literal%7E${script}`);
});

test("malformed encoded separator outside-root and double-encoded caller URLs fail attribution", (context) => {
  const { linkLocation } = require("./packaged-link-location.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-url-negative-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = "<sandbox>/tools/node_modules/opencode-ai/postinstall.mjs";
  const event = { api: "linkSync", phase: "official-host-bootstrap", entry,
    entry_sha256: "5a7c990fe552e76b16422cdba3f4b0550590c7a487f7932c773362f74317c87b",
    source: "<sandbox>/tools/source", destination: "<sandbox>/tools/node_modules/opencode-ai/bin/opencode.exe" };
  const actual = "    at copyBinary (file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/memocap-official-link-control-XPJMfe/tools/node_modules/opencode-ai/postinstall.mjs:151:8)";
  const actualRoot = "C:/Users/RUNNER~1/AppData/Local/Temp/memocap-official-link-control-XPJMfe";
  const attributed = path.join(root, "actual-windows.jsonl");
  fs.writeFileSync(attributed, `${JSON.stringify({ ...event, pid: 5636, ppid: 5284, stack: [linkLocation(actual, [actualRoot])] })}\n`);
  assert.equal(runtime.assertManagedLinks(attributed).bootstrap_attempted_links, 1);
  const urls = ["file:///C:/sandbox/%ZZ", "file:///C:/sandbox%2Ftools", "file:///C:/sandbox%5Ctools",
    "file:///C:/sandbox-else/tools", "file:///C:/sandbox/%252E%252E/tools", "file://[bad"];
  for (const [index, url] of urls.entries()) {
    const log = path.join(root, `${index}.jsonl`);
    const frame = linkLocation(`    at copyBinary (${url}/node_modules/opencode-ai/postinstall.mjs:151:8)`, ["C:/sandbox"]);
    fs.writeFileSync(log, `${JSON.stringify({ ...event, stack: [frame] })}\n`);
    assert.throws(() => runtime.assertManagedLinks(log), /unexpected link attempt/);
  }
  for (const [index, frame] of [`    at copyBinary (file://${entry}:151:8)`,
    `    at copyBinary (${entry}:151:80)`, `    at copyBinary (${entry}:151:8) forged`].entries()) {
    const forged = path.join(root, `forged-${index}.jsonl`);
    fs.writeFileSync(forged, `${JSON.stringify({ ...event, stack: [frame] })}\n`);
    assert.throws(() => runtime.assertManagedLinks(forged), /unexpected link attempt/);
  }
});

for (const exitCode of [0, 17]) {
test(`real encoded module caller preserves raw journal before assertions and cleanup on exit ${exitCode}`, (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap ~ space \u4e2d %7E "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = runtime.isolatedEnvironment(root);
  env.MEMOCAP_LINK_PHASE = "current-managed";
  const log = runtime.denyLinks(root, env);
  const script = path.join(root, "caller.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs';\ntry { fs.linkSync(import.meta.filename, import.meta.filename + '.link'); } catch (error) { if(error.code !== 'EPERM') throw error; }\nprocess.exit(${exitCode});\n`);
  const url = pathToFileURL(script).href.replaceAll("~", "%7E");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { env, encoding: "utf8" });
  const raw = fs.readFileSync(log);
  fs.rmSync(root, { recursive: true });
  assert.equal(child.status, exitCode, child.stderr);
  assert.deepEqual(fs.readFileSync(log), raw);
  const retained = runtime.linkEvents(log);
  assert.equal(retained.events[0].source, "<sandbox>/caller.mjs");
  assert.ok(retained.events[0].stack.some(frame => frame.includes("<sandbox>/caller.mjs:2:")));
  assert.equal(retained.raw_sha256, runtime.digest(raw));
  assert.equal(retained.raw_bytes, raw.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${log}.proof.json`)), { raw_bytes: raw.length, raw_sha256: runtime.digest(raw) });
  assert.throws(() => runtime.assertManagedLinks(log), /unexpected link attempt/);
});
}
