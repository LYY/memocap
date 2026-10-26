"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { wireProvider, startHost, portClosed } = require("./host.cjs");
const { digest, write } = require("../packaged-runtime.cjs");

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.argv[2]));
  const evidence = { status: "running", host: {}, cleanup: {},
    mechanism: "Linux child network+PID namespace; fixture UID/GID restored before Node", assertions: [] };
  let host;
  let provider;
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.getuid(), fixture.uid);
    assert.equal(process.getgid(), fixture.gid);
    evidence.identity = { uid: process.getuid(), gid: process.getgid() };
    assert.notEqual(fs.readlinkSync("/proc/self/ns/net"), fixture.parent_net_namespace);
    const denied = await new Promise((resolve) => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      socket.setTimeout(1500);
      socket.once("connect", () => { socket.destroy(); resolve("unexpected_connection"); });
      socket.once("error", (error) => resolve(error.code));
      socket.once("timeout", () => { socket.destroy(); resolve("timeout"); });
    });
    assert.equal(denied, "ENETUNREACH", "kernel must deny actual outbound TCP in the child namespace");
    evidence.outbound_tcp = denied;
    provider = await wireProvider();
    host = await startHost(fixture, provider, evidence);
    const session = await host.api("/session", { title: "Isolated Linux cache-ready actual host" });
    await host.api(`/session/${session.id}/command`, { command: "memory", arguments: "status", model: "wire/wire-model" });
    const status = JSON.parse(provider.requests.at(-1).body.messages.findLast((message) => message.role === "user").content);
    assert.equal(status.policy.digest, fixture.policy_digest);
    assert.equal(status.policy.mainPath, path.join(fixture.managed, "SKILL.md"));
    const prompt = async (tool, args) => {
      provider.responses.push({ tool, args }, { text: "Offline local fixture observed real host tool." });
      const reply = await host.api(`/session/${session.id}/message`, { model: { providerID: "wire", modelID: "wire-model" },
        parts: [{ type: "text", text: `offline fixture ${tool}` }] });
      assert.equal(reply.info.error, undefined, JSON.stringify(reply.info.error));
      const messages = await host.api(`/session/${session.id}/message`);
      const part = messages.flatMap((message) => message.parts).findLast((entry) => entry.type === "tool" && entry.tool === tool);
      assert.equal(part?.state.status, "completed", JSON.stringify(part));
      return part.state.output;
    };
    assert.ok((await prompt("skill", { name: "memocap" })).includes(fixture.rules));
    const reference = fixture.files.find((file) => file.path.startsWith("references/"));
    const referencePath = path.join(fixture.managed, reference.path);
    const output = await prompt("read", { filePath: referencePath });
    const observed = output.split("\n").filter((line) => /^\d+: /.test(line)).map((line) => line.replace(/^\d+: /, "")).join("\n");
    assert.equal(observed, fs.readFileSync(referencePath, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, ""));
    provider.responses.push({ text: "Offline compaction fixture summary." });
    const requestIndex = provider.requests.length;
    await host.api(`/session/${session.id}/summarize`, { providerID: "wire", modelID: "wire-model", auto: false });
    assert.ok(provider.requests.slice(requestIndex).some((entry) => entry.body.messages.some((message) => {
      const text = typeof message.content === "string" ? message.content : (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      return text.includes(fixture.rules);
    })), "offline actual summarize contains the selected complete marker block");
    const references = provider.requests.flatMap((entry) => entry.body.messages.flatMap((message) =>
      typeof message.content === "string" ? [message.content] :
        (message.content || []).filter((part) => part.type === "text").map((part) => part.text)))
      .filter((text) => text.startsWith("memocap reference data"))
      .map((text) => JSON.parse(text.slice(text.indexOf("\n") + 1)));
    assert.ok(references.some((receipt) => ["empty", "recalled"].includes(receipt.status)),
      "default automatic recall receipt must reach the local provider in the offline host");
    assert.deepEqual(provider.errors, []);
    evidence.status = "passed";
    evidence.policy_digest = fixture.policy_digest;
    evidence.marker_sha256 = digest(fixture.rules);
    evidence.provider_requests = provider.requests.length;
    evidence.assertions = ["actual kernel ENETUNREACH with independent net namespace", "loopback actual official host and local provider",
      "actual skill and absolute reference read", "actual summarize exact marker bytes", "default automatic recall observed"];
  } finally {
    if (host) { await host.close(); evidence.cleanup.port_closed = await portClosed(evidence.host.url); }
    if (provider) { await provider.close(); evidence.cleanup.provider_closed = true; }
    write(fixture.offline_evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
