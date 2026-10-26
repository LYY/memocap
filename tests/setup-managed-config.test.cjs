"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

for (const tuple of [false, true]) for (const directory of ["/owned path/memocap", "/policy-中/memocap"]) {
  for (const position of ["sole", "first", "middle", "last"]) for (const layout of ["compact", "multiline", "CRLF", "comments"]) for (const trailing of [false, true]) {
    test(`owned path removal preserves bytes ${tuple}/${directory}/${position}/${layout}/${trailing}`, async () => {
      const { managedConfigText } = await import("../scripts/setup/config.mjs");
      const ownedPlugin = tuple ? '["@lyy-gh/memocap@0.1.0",{"automatic":false}]' : '"@lyy-gh/memocap@0.1.0"';
      const others = ['/unrelated,"path', "/unicode-😀"].map((directory) => JSON.stringify(directory));
      const entries = position === "sole" ? [] : [...others];
      const index = { sole: 0, first: 0, middle: 1, last: 2 }[position];
      const owned = JSON.stringify(directory);
      entries.splice(index, 0, owned);
      const gap = { compact: "", multiline: "\n  ", CRLF: "\r\n\t", comments: "\n /* trivia , ] */ " }[layout];
      const slots = entries.map((entry) => `${gap}${entry}${layout === "comments" ? " /* after ] */" : ""}`);
      const commas = entries.map((_, offset) => offset < entries.length - 1 || trailing ? "," : "");
      const render = (plugin) => `{/* keep */"plugin":[${plugin}],"skills":{"paths":[${slots.map((slot, offset) => slot + commas[offset]).join("")}${gap}],"urls":["https://invalid.test"]},"model":"keep"}`;
      const text = render(ownedPlugin);
      slots[index] = slots[index].replace(owned, "");
      if (commas[index]) commas[index] = "";
      else if (index > 0) commas[index - 1] = "";
      const expected = render("");
      const changed = managedConfigText({ config: "/fixture.jsonc", text }, null, [directory]);
      assert.equal(changed, expected);
    });
  }
}

test("managed config switches both references with one CAS while preserving tuple options and CRLF", async (context) => {
  const f = fixture(context);
  const { managedEntry, writeManagedConfig, parseConfig } = await import("../scripts/setup/config.mjs");
  const text = '{\r\n// user\r\n"plugin":[["@lyy-gh/memocap@0.0.10",{/* option */"automatic":false,"skillDirectory":"/old","nested":[1,2]}],"other"],\r\n"skills":{"paths":["/other","/old"]},"model":"keep"\r\n}\r\n';
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, text);
  const original = fs.renameSync;
  let commits = 0;
  context.mock.method(fs, "renameSync", (source, destination) => { if (destination === f.config) commits++; return original(source, destination); });
  const entry = managedEntry(parseConfig(f.config).plugin[0], "0.1.0", "/new");
  writeManagedConfig({ config: f.config, text }, { entry, remove_paths: ["/old"] });
  assert.equal(commits, 1);
  const observed = fs.readFileSync(f.config, "utf8");
  assert.equal(observed.includes("/* option */"), true);
  assert.equal(observed.includes("// user\r\n"), true);
  assert.equal(/(?<!\r)\n/.test(observed), false);
  assert.deepEqual(parseConfig(f.config).plugin, [["@lyy-gh/memocap@0.1.0", { automatic: false, skillDirectory: "/new", nested: [1, 2] }], "other"]);
  assert.deepEqual(parseConfig(f.config).skills.paths, ["/other", "/new"]);
});

test("second CAS check keeps a concurrent user config edit before rename", async (context) => {
  const f = fixture(context);
  const { writeManagedConfig } = await import("../scripts/setup/config.mjs");
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\n");
  const write = fs.writeFileSync;
  const concurrent = '{"model":"concurrent"}\n';
  context.mock.method(fs, "writeFileSync", (filename, ...args) => {
    const outcome = write(filename, ...args);
    if (String(filename).startsWith(`${f.config}.memocap-`) && String(filename).endsWith(".tmp")) write(f.config, concurrent);
    return outcome;
  });
  assert.throws(() => writeManagedConfig({ config: f.config, text: "{}\n" }, { entry: ["@lyy-gh/memocap@0.1.0", { skillDirectory: "/new" }], remove_paths: [] }), { code: "concurrent_change" });
  assert.equal(fs.readFileSync(f.config, "utf8"), concurrent);
});
