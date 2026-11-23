const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { maintenanceHost, userPacket } = require('./maintenance-integration/host.cjs');

for (const { scenario, prefix } of [
  { scenario: 'quote-only-ascii', prefix: '' },
  { scenario: 'quote-only-unicode-prefix', prefix: '\u{1F9EA} ' },
]) test(`real OpenCode dispatch performs full read, adoption, independent review, scoped ask and native maintenance (${scenario})`,
  { skip: process.env.MEMOCAP_MAINTENANCE_HOST !== '1', timeout: 90000 }, async (context) => {
    const version = process.env.MEMOCAP_MAINTENANCE_VERSION ?? '1.19.5';
    const evidence = { scenario, version, cleanup: {}, phases: [], commands: [] };
    const filename = path.resolve(__dirname, `../.omo/evidence/capture-expansion/post-use-host-${scenario}-${version}-${randomUUID()}.json`);
    let host;
    context.after(async () => {
      if (host) {
        evidence.events = host.control.events;
        evidence.requests = host.provider.requests;
        await host.close();
      }
      fs.writeFileSync(filename, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      context.diagnostic(`evidence: ${filename}`);
      if (host) assert.deepEqual(evidence.cleanup, {
        host_port_closed: true, provider_port_closed: true, control_port_closed: true, sandbox_removed: true,
      });
    });
    host = await maintenanceHost(version, evidence);
    evidence.sandbox = host.root;
    evidence.loopback = { provider: host.provider.url, control: host.control.url };
    const session = await host.parent();
    evidence.parent_id = session.id;
    const { provider, control } = host;
    const quote = 'For local fixture, route is now /v2; unique timeout remains 7.';
    let canonicalCitation;
    provider.responses.push({ tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
      { tool: 'memocap_maintain', get args() {
        const receipt = control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read;
        assert.ok(receipt, 'only real native successful full read supplies the opaque handle');
        return { operation: 'use', ...receipt, statements: ['route is /v1'] };
      } }, { text: 'The local fixture task completed.' },
      { get text() {
        const data = userPacket(provider);
        assert.equal(data.stage, 'extract');
        const source = data.evidence[0];
        const offset = source.text.indexOf(quote);
        assert.ok(offset >= 0, 'extract receives the synthetic quote');
        const start = Array.from(source.text.slice(0, offset)).length;
        canonicalCitation = { source_id: source.source_id, content_hash: source.content_hash, start,
          end: start + Array.from(quote).length, quote };
        evidence.extract_citation = { source_id: source.source_id, quote };
        return JSON.stringify({ decision: { action: 'update', target: data.used[0].use_id,
          content: quote, citations: [evidence.extract_citation] } });
      } }, { get text() {
        const data = userPacket(provider);
        assert.equal(data.stage, 'support');
        assert.deepEqual(data.decision.citations, [canonicalCitation]);
        const [citation] = data.decision.citations;
        const source = data.evidence.find((entry) => entry.source_id === citation.source_id);
        assert.ok(source, 'support receives the cited source');
        assert.equal(source.content_hash, citation.content_hash);
        assert.equal(Array.from(source.text).slice(citation.start, citation.end).join(''), quote);
        return JSON.stringify({ status: 'supported', ...data.binding });
      } }, { tool: 'memocap_maintain', get args() {
        const data = userPacket(provider);
        assert.equal(data.stage, 'commit');
        return { operation: data.operation, proposal_id: data.proposal_id };
      } }, { text: '{"candidates":[]}' });
    await host.prompt(session, `${prefix}${quote} Use the adopted memory to perform this task.`);
    const result = await control.wait((event) => event.phase === 'maintenance.review' && event.parentID === session.id);
    evidence.result = result;
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.model_calls, 3);
    assert.equal(result.write_attempts, 1);
    assert.equal(result.child_sessions, 2);
    assert.equal(provider.requests.length, 6);
    const asks = control.events.filter((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain');
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].request.patterns, [host.pattern]);
    const spawns = control.events.filter((event) => event.phase === 'native.spawn' && event.args.includes('maintain'));
    assert.equal(spawns.length, 1);
    const resolved = control.events.filter((event) => event.phase === 'ask.resolved' && event.sessionID === asks[0].sessionID);
    assert.equal(resolved.length, 1);
    assert.ok(control.events.indexOf(resolved[0]) < control.events.indexOf(spawns[0]));
    assert.equal(control.events.filter((event) => event.phase === 'session.messages' && event.id === session.id).length, 0);
    evidence.separate_readback = host.cli(['organize', 'read'], { keys: [{ id: 1, placement: 'universal' }] });
    assert.equal(evidence.separate_readback.organization.records[0].snapshot.content, quote);
    evidence.activity = host.cli(['activity', 'list', '--writes', '--operation', result.operation_id]);
    assert.equal(evidence.activity.events.length, 1);
    assert.equal(evidence.activity.events[0].detail.metadata.action, 'maintain_update');
    assert.equal(evidence.activity.events[0].context.session_id, asks[0].sessionID);
    await host.captureDone(session);
    assert.equal(provider.requests.length, 7);
  });
