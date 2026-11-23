"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const version = require("../package.json").version;
const bridgeModule = import("../plugin/bridge.js");

for (const { name, options, content } of [
  { name: "ordinary content", options: ["remember", "--repository-id", "repository:fixture"], content: "two words" },
  { name: "dash-prefixed content", options: ["remember"], content: "-literal\n中文 \"quoted\"" },
  { name: "literal JSON flag content", options: ["remember"], content: "--json" },
  { name: "literal delimiter content", options: ["remember"], content: "--" },
  { name: "explicit root JSON option", options: ["--json", "remember"], content: "--json" },
  { name: "explicit command JSON option", options: ["remember", "--json"], content: "-literal" },
]) {
  test(`bridge preserves one positional argument with JSON enabled when given ${name}`, async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memocap bridge delimiter "));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const launcher = path.join(directory, "fake launcher.cjs");
    fs.writeFileSync(launcher, `
      if (process.argv[2] === "--version") {
        console.log("memocap ${version}");
      } else {
        const argv = process.argv.slice(2);
        const separator = argv.indexOf("--");
        console.log(JSON.stringify({format_version:1,status:"ok",argv,
          jsonOptions:argv.slice(0, separator).filter(argument => argument === "--json").length,
          content:argv.slice(separator + 1)}));
      }
    `);
    const { createBridge } = await bridgeModule;
    const argv = Object.freeze([...options, "--", content]);

    const { receipt } = await createBridge({ launcher }).run(argv, { cwd: directory });

    assert.deepEqual(receipt.content, [content]);
    assert.equal(receipt.jsonOptions, 1);
    assert.deepEqual(argv, [...options, "--", content]);
    if (options.includes("--json")) assert.deepEqual(receipt.argv, argv);
  });
}
