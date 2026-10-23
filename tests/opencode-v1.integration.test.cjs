const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repo, prepare, wireProvider, startHost, portClosed } = require('./opencode-v1/host.cjs');

function reference(message) {
  const parts = typeof message.content === 'string' ? [message.content] :
    (message.content || []).filter((part) => part.type === 'text').map((part) => part.text);
  const text = parts.findLast((part) => part.startsWith('memocap reference data'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined;
}

test('official OpenCode 1.19.3 loads memocap and sends recalled references to a local wire provider',
  { skip: process.env.MEMOCAP_OPENCODE_INTEGRATION !== '1', timeout: 150000 }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-official-v1-')));
    const evidence = { status: 'running', started_at: new Date().toISOString(),
      platform: process.platform, arch: process.arch, cleanup: {}, claims: {
        official_host_model_input: false, model_adoption: false, paid_provider_requests: 0,
        postrelease_matching_tag: 'not_run', cross_platform: 'not_run',
        packaged_installation: 'not_run: prioritize official host blocker',
        old_cli_core_compatibility: 'not_run: prioritize official host blocker',
        independent_agent_tasks: 'not_run: parent agent tools unavailable in this harness',
      } };
    let provider;
    let host;
    let failure;
    const evidenceFile = process.env.MEMOCAP_TEST_HOST_EVIDENCE ||
      path.join(repo, '.omo/evidence/memocap-observable-opencode-v1/task-11-host.json');
    try {
      const fixture = prepare(root, evidence);
      provider = await wireProvider();
      host = await startHost(fixture, provider, evidence);
      evidence.loaded_commands = (await host.api('/command')).map(({ name, description, source }) =>
        ({ name, description, source }));
      evidence.loaded_tool_ids = await host.api('/experimental/tool/ids');
      assert.ok(evidence.loaded_commands.some((command) => command.name === 'memory'));
      for (const tool of ['memocap_scope', 'memocap_recall', 'memocap_remember']) {
        assert.ok(evidence.loaded_tool_ids.includes(tool), `${tool} registered by actual host`);
      }
      const session = await host.api('/session', { title: 'memocap official wire integration' });
      evidence.session = { id: session.id, directory: session.directory };
      const prompt = (text) => host.api(`/session/${session.id}/message`, {
        model: { providerID: 'wire', modelID: 'wire-model' }, parts: [{ type: 'text', text }],
      });
      evidence.command_results = {};
      const command = async (argumentsText) => {
        const reply = await host.api(`/session/${session.id}/command`, {
          command: 'memory', arguments: argumentsText, model: 'wire/wire-model',
        });
        assert.equal(reply.info.error, undefined, JSON.stringify(reply.info.error));
        const request = provider.requests.at(-1);
        const receipt = JSON.parse(request.body.messages.findLast((message) => message.role === 'user').content);
        evidence.command_results[argumentsText] = { reply, request, receipt };
        return receipt;
      };
      const empty = await prompt('emptywireprobe');
      assert.equal(empty.info.error, undefined, JSON.stringify(empty.info.error));
      const firstRequest = provider.requests.find((entry) => JSON.stringify(entry.body.messages).includes('emptywireprobe'));
      assert.ok(firstRequest);
      evidence.initial_request = firstRequest;
      const initialReceipt = reference(firstRequest.body.messages.findLast((message) => message.role === 'user'));
      evidence.initial_receipt = initialReceipt;
      assert.equal(initialReceipt?.status, 'empty');
      const seededContent = 'wireseedquartz: the unique repository A sentinel is cobalt-teapot-731.';
      const seeded = fixture.cli(['remember', '--repo', fixture.directories.A, '--', seededContent]);
      const seedID = seeded.returned_ids[0];
      evidence.seed = { content: seededContent, id: seedID };
      evidence.scope_command_result = await command(`scope "${fixture.directories.A}" "${fixture.directories.B}"`);
      assert.deepEqual(evidence.scope_command_result.targets.map((target) => target.canonical_path),
        [fixture.directories.A, fixture.directories.B]);
      const answer = await prompt('wireseedquartz');
      assert.equal(answer.info.error, undefined, JSON.stringify(answer.info.error));
      const request = provider.requests.findLast((entry) => {
        const messages = JSON.stringify(entry.body.messages);
        return messages.includes('wireseedquartz') && messages.includes('cobalt-teapot-731');
      });
      assert.ok(request, 'real provider input contains unique native memory');
      const userMessage = request.body.messages.findLast((message) => message.role === 'user');
      const recalled = reference(userMessage);
      assert.ok(recalled.references.some((entry) => entry.id === seedID && entry.content === seededContent &&
        entry.placement.startsWith('repository:') && entry.applicable_repositories.length > 0));
      assert.ok(request.body.tools.some((tool) => tool.function.name === 'memocap_remember'));
      evidence.claims.official_host_model_input = true;
      evidence.recalled_request = request;
      evidence.scope = fixture.directories;
      const why = await command('why');
      assert.deepEqual(why.current.returned_ids, [seedID]);
      assert.deepEqual(why.current.targets, [fixture.directories.A, fixture.directories.B]);
      assert.ok(why.events.some((event) => event.detail.phase === 'injection_prepared'));
      await command('scopes');
      const beforeB = fixture.cli(['list', '--repo', fixture.directories.B]);
      provider.responses.push({ tool: 'memocap_remember', args: {
        repository: fixture.directories.A, content: 'wirewriteamber: explicit A-only saved memory.' } },
      { text: 'Deterministic fixture acknowledged tool execution; no model adoption claim.' });
      const saved = await prompt('wirewriteamber save explicitly in A only');
      assert.equal(saved.info.error, undefined, JSON.stringify(saved.info.error));
      const savedMessages = await host.api(`/session/${session.id}/message`);
      evidence.write_messages = savedMessages.filter((message) => message.info.parentID === saved.info.parentID);
      const savedTool = evidence.write_messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'tool' && part.tool === 'memocap_remember');
      assert.ok(savedTool, 'actual host executed SDK memory tool');
      assert.equal(savedTool.state.status, 'completed', JSON.stringify(savedTool));
      const savedReceipt = JSON.parse(savedTool.state.output);
      assert.equal(savedReceipt.status, 'inserted');
      assert.equal(savedReceipt.readback.status, 'ok');
      evidence.write = savedReceipt;
      assert.deepEqual(fixture.cli(['list', '--repo', fixture.directories.B]).returned_ids, beforeB.returned_ids);
      evidence.B_unchanged = true;
      await prompt('wirewriteamber');
      const writeRequest = provider.requests.at(-1);
      assert.ok(reference(writeRequest.body.messages.findLast((message) => message.role === 'user'))
        .references.some((entry) => entry.content === 'wirewriteamber: explicit A-only saved memory.'));
      evidence.write_recalled_request = writeRequest;
      const recent = await command('recent');
      assert.ok(recent.events.some((event) => event.operation_id === savedReceipt.operation_id),
        'recent includes the actual host write');
      evidence.session_isolation = [];
      for (const parentID of [undefined, session.id]) {
        const isolatedSession = await host.api('/session', { title: 'isolated recall',
          ...(parentID ? { parentID } : {}) });
        const isolatedReply = await host.api(`/session/${isolatedSession.id}/message`, {
          model: { providerID: 'wire', modelID: 'wire-model' },
          parts: [{ type: 'text', text: 'wireseedquartz' }],
        });
        assert.equal(isolatedReply.info.error, undefined);
        const isolatedRequest = provider.requests.at(-1);
        const isolatedReceipt = reference(isolatedRequest.body.messages.findLast((message) => message.role === 'user'));
        evidence.session_isolation.push({ session: isolatedSession, request: isolatedRequest, receipt: isolatedReceipt });
        assert.equal(isolatedReceipt.status, 'empty', 'new and child sessions use their own directory');
      }
      for (const request of provider.requests) {
        for (const message of request.body.messages.filter((entry) => entry.role === 'user')) {
          if (!Array.isArray(message.content)) continue;
          assert.ok(message.content.filter((part) => part.type === 'text' &&
            part.text.startsWith('memocap reference data')).length <= 1, 'reference blocks do not accumulate');
        }
      }
      evidence.reference_block_deduplication = true;
      evidence.activities = fixture.cli(['activity', 'list', '--limit', '50']);
      fs.renameSync(fixture.env.MEMOCAP_DB, `${fixture.env.MEMOCAP_DB}.saved`);
      fs.mkdirSync(fixture.env.MEMOCAP_DB);
      const negative = await prompt('negativewireprobe sidecar failure should preserve this conversation');
      assert.equal(negative.info.error, undefined, JSON.stringify(negative.info.error));
      const negativeRequest = provider.requests.findLast((entry) =>
        JSON.stringify(entry.body.messages).includes('negativewireprobe'));
      assert.ok(negativeRequest);
      assert.equal(reference(negativeRequest.body.messages.findLast((message) => message.role === 'user')).status, 'failed');
      evidence.negative = { reply: negative, request: negativeRequest };
      assert.deepEqual(provider.errors, []);
      evidence.status = 'passed';
    } catch (error) {
      failure = error;
      evidence.status = 'blocked';
      evidence.blocker = { message: error.message, stack: error.stack };
    } finally {
      if (host) await host.close().catch((error) => { evidence.cleanup.host_error = error.message; });
      if (evidence.host?.url) evidence.cleanup.host_port_closed = await portClosed(evidence.host.url);
      if (provider) {
        evidence.requests = provider.requests;
        evidence.request_count = provider.requests.length;
        await provider.close();
        evidence.cleanup.provider_port_closed = await portClosed(provider.url);
      }
      evidence.cleanup.provider_closed = Boolean(provider);
      fs.rmSync(root, { recursive: true, force: true });
      evidence.cleanup.isolated_root_removed = !fs.existsSync(root);
      evidence.finished_at = new Date().toISOString();
      const sanitize = (text) => text.split(root).join('<isolated-root>').split(repo).join('<repository>');
      fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
      fs.writeFileSync(evidenceFile, sanitize(JSON.stringify(evidence, null, 2)) + '\n');
      assert.equal(JSON.parse(fs.readFileSync(evidenceFile)).status, evidence.status);
    }
    if (failure) throw failure;
  });
