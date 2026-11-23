const { hash, requireStage } = require('./value.cjs');

function fakeHost(options = {}) {
  let sequence = 0;
  const next = (label) => `fake-${label}-${++sequence}`;
  let session;
  let user;
  let boundary;
  const memory = [];
  const packets = [];
  const translations = [];
  const reads = [];
  const stats = { open: 0, closed: 0, children: 0, native_processes: 0, provider_requests: 0, writes: 0 };
  function frame(translation) {
    const message = { id: next('assistant'), sessionID: session, role: 'assistant', parentID: user };
    const part = { id: next('part'), messageID: message.id, sessionID: session, type: 'tool',
      tool: translation.nativeTool, callID: next('call'), state: { status: translation.failure ? 'error' : 'completed',
        input: structuredClone(translation.input), time: { start: 1, end: 2 } } };
    const state = part.state;
    switch (part.tool) {
      case 'read': {
        const filePath = state.input.filePath;
        const lines = translation.text.split('\n');
        const offset = translation.partial ? 10 : 1;
        const total = translation.partial ? 10 : lines.length;
        state.output = `<path>${filePath}</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + offset}: ${line}`).join('\n')}\n\n(End of file - total ${total} lines)\n</content>`;
        state.metadata = { truncated: false, display: { type: 'file', path: filePath, text: translation.text,
          lineStart: offset, lineEnd: total, totalLines: total, truncated: false } };
        break;
      }
      case 'bash':
        if (translation.failure) state.error = translation.text;
        else { state.output = translation.text; state.metadata = { exit: 0, output: translation.text, truncated: false }; }
        break;
      default: requireStage(false, 'fake_unknown_tool');
    }
    return { userID: user, message, part };
  }
  return { mode: 'offline', stats, packets, translations, memory,
    async open() { stats.open++; session = next('session');
      return { sessionID: session, origin: 'repository:synthetic-native', version: '1.19.3', root: '/offline/private-fixture', node: '/offline/node' }; },
    async seed(snapshot) {
      const record = { id: memory.length + 101, ...snapshot }; memory.push(record);
      return { ...record, readback: structuredClone(record) };
    },
    async deliver(packet, target) {
      packets.push(structuredClone(packet)); boundary = target;
      user = next('user');
      const observedUser = { message: { id: user, sessionID: session, role: 'user' },
        parts: [{ id: next('userpart'), sessionID: session, messageID: user, type: 'text', text: packet.user }] };
      options.mutateUser?.(observedUser);
      await boundary.user(observedUser);
      const clean = (await import('../../plugin/capture/screen.js')).clean;
      if (!clean(packet.user)) return { screened: true };
      for (const item of packet.memories ?? []) {
        if (item.access === 'recall') {
          boundary.record({ kind: 'memory.recall', root: session, user, ids: [item.id] }); continue;
        }
        const record = memory.find((row) => row.id === item.id);
        const receipt_id = next('read'); reads.push({ record, receipt_id });
        boundary.record({ kind: 'memory.read', root: session, user, record, receipt_id, completeness: 'full' });
        if (item.declaration && !options.omitUse) boundary.record({ kind: 'memory.use', root: session, user,
          id: record.id, placement: record.placement, content_hash: hash(record.content), receipt_id, use_id: next('use') });
      }
      for (const operation of packet.operations) {
        const translation = await boundary.prepare(operation.token); translations.push(translation);
        const value = frame(translation);
        options.mutateSource?.(value, translation);
        await boundary.tool(value);
      }
      const info = { id: next('complete'), sessionID: session, parentID: user, role: 'assistant', finish: 'stop', time: { completed: 3 } };
      options.mutateCompletion?.(info);
      if (!options.omitCompletion) await boundary.complete(info);
    },
    async settle(request) {
      if (options.settle) return options.settle({ request, boundary, session, user, memory });
      if (request.review) boundary.record({ kind: 'raw', root: session, user, candidate: null, surface: 'fake-sdk-response' });
      return { status: request.review ? 'no_candidate' : 'not_queued', semantic: 'unexercised' };
    },
    async close(request) { stats.closed++; return options.cleanup ?? { exited: true, children: 0, removed: !request.retain_recovery }; },
  };
}
module.exports = { fakeHost };
