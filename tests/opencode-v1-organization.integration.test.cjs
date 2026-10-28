const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { repo, prepare, wireProvider, startHost, portClosed } = require('./opencode-v1/host.cjs');
const { retain } = require('./opencode-v1/phases.cjs');

test('actual OpenCode 1.19.3 transports organization commands and permitted native apply through an isolated local provider',
  { skip: process.env.MEMOCAP_ORGANIZATION_HOST !== '1', timeout: 600000 }, async (context) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-organization-host-')));
    const evidence = { status: 'failed', platform: process.platform, commands: [], assertions: [], cleanup: {} };
    let fixture;
    let provider;
    let host;
    context.after(async () => {
      try {
        if (host) { await host.close(); evidence.cleanup.host_port_closed = await portClosed(evidence.host.url); }
      } finally {
        try {
          if (provider) { await provider.close(); evidence.cleanup.provider_port_closed = await portClosed(provider.url); }
        } finally {
          if (fixture) evidence.cleanup.package = await fixture.cleanup();
          fs.rmSync(root, { recursive: true, force: true });
          evidence.cleanup.isolated_root_removed = !fs.existsSync(root);
          retain(process.env.MEMOCAP_TEST_HOST_EVIDENCE || path.join(repo, '.omo/evidence/memory-organization-v040/organization-host.json'),
            evidence, [[root, '<isolated-root>'], [repo, '<repository>']]);
        }
      }
      assert.equal(evidence.cleanup.host_port_closed, true);
      assert.equal(evidence.cleanup.provider_port_closed, true);
    });
    fixture = await prepare(root, evidence);
    const { env } = fixture;
    env.MEMOCAP_DB = path.join(root, 'organization/core.db');
    provider = await wireProvider();
    host = await startHost(fixture, provider, evidence);
    assert.ok((await host.api('/experimental/tool/ids')).includes('memocap_organize'));
    const session = await host.api('/session', { title: 'isolated organization transport' });
    const command = async (argumentsText) => {
      const response = await host.api(`/session/${session.id}/command`, { command: 'memory', arguments: argumentsText, model: 'wire/wire-model' });
      assert.equal(response.info.error, undefined, JSON.stringify(response.info.error));
      const message = provider.requests.at(-1).body.messages.findLast((entry) => entry.role === 'user');
      assert.equal(typeof message.content, 'string');
      return JSON.parse(message.content);
    };
    assert.equal((await command('help')).status, 'ok');
    assert.equal(fs.existsSync(env.MEMOCAP_DB), false);
    assert.equal((await command('organize --wat')).error.code, 'invalid_arguments');
    const source = `nativehostanchor exact source ${'完整详情'.repeat(7000)}`;
    const seeded = spawnSync(fixture.native, ['remember', '--universal', '--json', '--', source], {
      env, cwd: fixture.directories.A, encoding: 'utf8', timeout: 5000 });
    assert.equal(seeded.status, 0, seeded.stderr);
    const preview = await command('organize');
    assert.equal(preview.status, 'ok', JSON.stringify(preview));
    const page = preview.untrusted_data.receipt.organization;
    assert.equal(Buffer.byteLength(page.records[0].content), Buffer.byteLength(source));
    assert.ok(page.records[0].content === source, 'command preview preserves exact source bytes');
    const messages = await host.api(`/session/${session.id}/message`);
    assert.equal(messages.filter((entry) => entry.info.role === 'user').at(-1).parts[0].metadata.memocap.suppress_auto_recall, true);
    const runTool = async (name, args) => {
      provider.responses.push({ tool: name, args }, { text: 'Transport observed; semantic adoption unclaimed.' });
      const response = await host.api(`/session/${session.id}/message`, { model: { providerID: 'wire', modelID: 'wire-model' },
        parts: [{ type: 'text', text: `fixture transport ${name}` }] });
      assert.equal(response.info.error, undefined, JSON.stringify(response.info.error));
      const history = await host.api(`/session/${session.id}/message`);
      const part = history.flatMap((entry) => entry.parts).findLast((entry) => entry.type === 'tool' && entry.tool === name);
      assert.equal(part.state.status, 'completed', JSON.stringify(part));
      return part.state.output;
    };
    const policyRead = await runTool('read', { filePath: preview.instruction_pointer.path });
    assert.ok(policyRead.length > 100);
    const full = JSON.parse(await runTool('memocap_organize', { operation: 'read', database: page.database,
      request: JSON.stringify({ keys: [{ id: page.records[0].id, placement: page.records[0].placement }] }) }));
    assert.deepEqual(full.untrusted_data.receipt.organization.records[0].snapshot, page.records[0]);
    const request = { mode: 'pending', group: { action: 'refine', expected: page.records[0], content: 'approved nativehostanchor text' }, dependencies: [] };
    const applied = JSON.parse(await runTool('memocap_organize', { operation: 'apply', database: page.database,
      request: JSON.stringify(request), confirmed: true }));
    assert.equal(applied.outcome, 'committed', JSON.stringify(applied));
    assert.equal(applied.untrusted_data.readback.status, 'ok');
    assert.equal(applied.untrusted_data.readback.receipt.organization.records[0].snapshot.content, request.group.content);
    const all = await command('organize -a');
    assert.equal(all.untrusted_data.receipt.organization.records[0].content, request.group.content);
    assert.deepEqual(provider.errors, []);
    evidence.organization = { help_without_database: true, invalid_arguments: true,
      source_bytes: Buffer.byteLength(source), complete_preview: true, exact_read: true,
      confirmed_apply: applied.outcome, independent_readback: applied.untrusted_data.readback.status,
      all_selection: true, paid_provider_requests: 0, model_adoption: 'not_claimed' };
    evidence.status = 'passed';
  });
