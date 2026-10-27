const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { repo, prepare, wireProvider, startHost, portClosed } = require('./opencode-v1/host.cjs');
const { observe, retain, recordCleanupFailure } = require('./opencode-v1/phases.cjs');

function reference(message) {
  const parts = typeof message.content === 'string' ? [message.content] :
    (message.content || []).filter((part) => part.type === 'text').map((part) => part.text);
  const text = parts.findLast((part) => part.startsWith('memocap reference data'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined;
}

test('official OpenCode 1.19.3 loads memocap and sends recalled references to a local wire provider',
  { skip: process.env.MEMOCAP_OPENCODE_INTEGRATION !== '1', timeout: 600000 }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-official-v1-')));
    const evidence = { format_version: 1, status: 'running', started_at: new Date().toISOString(), commands: [], assertions: [],
      platform: process.platform, arch: process.arch, cleanup: {}, claims: {
        official_host_model_input: false, model_adoption: false, paid_provider_requests: 0,
        postrelease_matching_tag: 'not_run', cross_platform: 'not_run',
        packaged_installation: false,
        old_cli_core_compatibility: 'actual 0.2.1 installer/native migration; full unrelated old-client matrix is not claimed',
      } };
    let provider;
    let host;
    let failure;
    let fixture;
    const evidenceFile = process.env.MEMOCAP_TEST_HOST_EVIDENCE ||
      path.join(repo, '.omo/evidence/memocap-unified-skill/task-8.json');
    try {
      fixture = await prepare(root, evidence);
      evidence.claims.packaged_installation = true;
      provider = await wireProvider();
      host = await startHost(fixture, provider, evidence);
      const debugOptions = { cwd: fixture.directories.outside };
      const effectiveConfig = await observe(evidence, 'debug_config', async () => {
        const config = JSON.parse((await fixture.packaged.command(fixture.host, ['debug', 'config'], debugOptions)).stdout);
        evidence.effective_skills = config.skills;
        return config;
      });
      await observe(evidence, 'first_command', async () => {
        evidence.loaded_commands = (await host.api('/command')).map(({ name, description, source }) =>
          ({ name, description, source }));
        assert.ok(evidence.loaded_commands.some((command) => command.name === 'memory'));
      });
      evidence.loaded_tool_ids = await host.api('/experimental/tool/ids');
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
        evidence.command_results[argumentsText] = receipt;
        return receipt;
      };
      const status = await command('status');
      assert.deepEqual(status.policy, { mode: 'managed', directory: fixture.managed,
        mainPath: path.join(fixture.managed, 'SKILL.md'), version: fixture.version, digest: fixture.bundled.digest });
      const debugSkill = await fixture.packaged.command(fixture.host, ['debug', 'skill', '--print-logs'], debugOptions);
      const discovered = JSON.parse(debugSkill.stdout)
        .filter((skill) => skill.name === 'memocap');
      assert.equal(discovered.length, 1, JSON.stringify({ discovered, skills: effectiveConfig.skills, log: debugSkill.stderr.slice(-5000) }));
      assert.equal(fs.realpathSync(discovered[0].location), status.policy.mainPath);
      evidence.discovery = { count: discovered.length, mainPath: status.policy.mainPath,
        plugin_policy: status.policy, digest: fixture.bundled.digest };
      const runTool = async (name, args) => {
        provider.responses.push({ tool: name, args }, { text: 'Local deterministic tool observation completed.' });
        const response = await prompt(`fixture tool observation ${name}`);
        assert.equal(response.info.error, undefined, JSON.stringify(response.info.error));
        const messages = await host.api(`/session/${session.id}/message`);
        const tool = messages.flatMap((message) => message.parts).findLast((part) => part.type === 'tool' && part.tool === name);
        assert.equal(tool?.state.status, 'completed', JSON.stringify(tool));
        return tool.state.output;
      };
      const loadedSkill = await runTool('skill', { name: 'memocap' });
      assert.ok(loadedSkill.includes(fixture.bundled.rules), 'actual skill tool output includes exact packaged policy markers');
      evidence.actual_reads = [];
      for (const file of fixture.bundled.files.filter((entry) => entry.path.endsWith('.md'))) {
        const filename = path.join(fixture.managed, file.path);
        const output = await runTool('read', { filePath: filename });
        const lines = output.split('\n').filter((line) => /^\d+: /.test(line))
          .map((line) => line.replace(/^\d+: /, ''));
        const actual = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
        assert.equal(lines.join('\n'), actual, `real host absolute read of ${file.path}`);
        evidence.actual_reads.push({ path: file.path, sha256: file.sha256, bytes: file.size, host_read: true });
      }
      const beforeCompaction = provider.requests.length;
      provider.responses.push({ text: 'Local fixture compaction summary.' });
      await host.api(`/session/${session.id}/summarize`, { providerID: 'wire', modelID: 'wire-model', auto: false });
      const compaction = provider.requests.slice(beforeCompaction)
        .find((entry) => entry.body.messages.some((message) => JSON.stringify(message.content).includes('memocap:begin')));
      assert.ok(compaction, 'actual summarize provider input includes policy context');
      const compactionText = compaction.body.messages.map((message) => typeof message.content === 'string' ? message.content :
        (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n');
      assert.ok(compactionText.includes(fixture.bundled.rules), 'compaction receives exact selected marker bytes');
      evidence.compaction = { actual_summarize_request: true, exact_marker_bytes: true,
        marker_sha256: crypto.createHash('sha256').update(fixture.bundled.rules).digest('hex') };
      evidence.assertions.push('official debug skill is unique and equals plugin managed policy',
        'actual skill/read tools load complete packaged main and references', 'actual summarize receives exact managed marker block');
      const empty = await prompt('emptywireprobe');
      assert.equal(empty.info.error, undefined, JSON.stringify(empty.info.error));
      const firstRequest = provider.requests.find((entry) => JSON.stringify(entry.body.messages).includes('emptywireprobe'));
      assert.ok(firstRequest);
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
      const writeMessages = savedMessages.filter((message) => message.info.parentID === saved.info.parentID);
      const savedTool = writeMessages.flatMap((message) => message.parts)
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
        evidence.session_isolation.push({ session_id: isolatedSession.id, receipt: isolatedReceipt });
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
      evidence.activity_count = fixture.cli(['activity', 'list', '--limit', '50']).events.length;
      fs.renameSync(fixture.env.MEMOCAP_DB, `${fixture.env.MEMOCAP_DB}.saved`);
      fs.mkdirSync(fixture.env.MEMOCAP_DB);
      const negative = await prompt('negativewireprobe sidecar failure should preserve this conversation');
      assert.equal(negative.info.error, undefined, JSON.stringify(negative.info.error));
      const negativeRequest = provider.requests.findLast((entry) =>
        JSON.stringify(entry.body.messages).includes('negativewireprobe'));
      assert.ok(negativeRequest);
      assert.equal(reference(negativeRequest.body.messages.findLast((message) => message.role === 'user')).status, 'failed');
      evidence.negative = { conversation_preserved: true, receipt: reference(negativeRequest.body.messages.findLast((message) => message.role === 'user')) };
      fs.rmdirSync(fixture.env.MEMOCAP_DB);
      fs.renameSync(`${fixture.env.MEMOCAP_DB}.saved`, fixture.env.MEMOCAP_DB);
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
        evidence.request_count = provider.requests.length;
        await observe(evidence, 'provider_cleanup', () => provider.close())
          .catch((error) => { evidence.cleanup.provider_error = error.message; failure = recordCleanupFailure(evidence, failure, error); });
        evidence.cleanup.provider_port_closed = await portClosed(provider.url);
      }
      evidence.cleanup.provider_closed = Boolean(provider);
      if (!failure && fixture && process.env.MEMOCAP_TEST_LINUX_OFFLINE === '1') {
        try {
          assert.equal(process.platform, 'linux', 'offline network proof requires the Linux native job');
          const offlineSpec = path.join(fixture.packaged.root, 'offline-fixture.json');
          const offlineEvidence = path.join(fixture.packaged.root, 'offline-evidence.json');
          fs.writeFileSync(offlineSpec, JSON.stringify({ env: fixture.env, host: fixture.host, config: fixture.config,
            directories: fixture.directories, managed: fixture.managed, rules: fixture.bundled.rules,
            files: fixture.bundled.files, policy_digest: fixture.bundled.digest, offline_evidence: offlineEvidence,
            uid: process.getuid(), gid: process.getgid(),
            parent_net_namespace: fs.readlinkSync('/proc/self/ns/net') }));
          await fixture.packaged.command('sudo', ['--preserve-env=PATH', 'unshare', '--net', '--pid', '--mount-proc', '--fork', '--kill-child',
            'sh', '-c', 'ip link set lo up && exec setpriv --reuid "$1" --regid "$2" --clear-groups "$3" "$4" "$5"',
            'memocap-offline', String(process.getuid()), String(process.getgid()), process.execPath,
            path.join(__dirname, 'opencode-v1/offline.cjs'), offlineSpec]);
          assert.equal(fs.statSync(offlineEvidence).uid, process.getuid(), 'offline evidence must remain owned by the fixture user');
          evidence.linux_offline = JSON.parse(fs.readFileSync(offlineEvidence));
          assert.equal(evidence.linux_offline.status, 'passed');
          assert.equal(evidence.linux_offline.cleanup.port_closed, true);
        } catch (error) { failure = error; evidence.status = 'failed'; evidence.error = error.stack; }
      } else evidence.linux_offline = { status: 'not_run', reason: 'Linux network namespace acceptance runs in the native Linux CI job; macOS/Windows outbound denial is not claimed' };
      if (fixture) evidence.cleanup.package = await observe(evidence, 'package_cleanup', () => fixture.cleanup())
        .catch((error) => { evidence.cleanup.package_error = error.message; failure = recordCleanupFailure(evidence, failure, error); });
      retain(evidenceFile, evidence, [[root, '<isolated-root>'], [repo, '<repository>']]);
      fs.rmSync(root, { recursive: true, force: true });
      evidence.cleanup.isolated_root_removed = !fs.existsSync(root);
      evidence.finished_at = new Date().toISOString();
      retain(evidenceFile, evidence, [[root, '<isolated-root>'], [repo, '<repository>']]);
    }
    if (failure) throw failure;
  });
