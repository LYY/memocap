export default { id: 'memocap-capture-spike', async server({ client }, options) {
  const workers = new Set();
  const claimed = new Set();
  const jobs = new Set();
  const epochs = new Map();
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST',
      body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`spike telemetry: ${response.status}`);
  };
  const data = (result) => {
    if (result.error) throw new Error(JSON.stringify(result.error));
    return result.data;
  };
  async function idle(sessionID) {
    if (workers.has(sessionID)) {
      await report({ phase: 'worker.excluded', sessionID });
      return;
    }
    const session = data(await client.session.get({ path: { id: sessionID } }));
    if (session.parentID) {
      await report({ phase: 'child.excluded', sessionID });
      return;
    }
    const messages = data(await client.session.messages({ path: { id: sessionID } }));
    const user = messages.findLast((message) => message.info.role === 'user');
    const assistant = messages.at(-1)?.info;
    if (!user || assistant?.role !== 'assistant' || assistant.parentID !== user.info.id ||
        !assistant.time.completed || assistant.error || assistant.finish !== 'stop') {
      if (options.observe) await report({ phase: 'worker.ineligible', sessionID,
        userID: user?.info.id, assistant });
      return;
    }
    if (claimed.has(user.info.id)) {
      await report({ phase: 'duplicate.excluded', sessionID, userID: user.info.id });
      return;
    }
    claimed.add(user.info.id);
    const child = data(await client.session.create({ body: { parentID: sessionID,
      title: 'Capture spike worker', permission: session.permission } }));
    workers.add(child.id);
    const epoch = epochs.get(sessionID) || 0;
    await report({ phase: 'worker.created', sessionID: child.id, parentID: sessionID,
      userID: user.info.id, assistantID: assistant.id, permission: child.permission });
    const response = await fetch(options.control, { signal: AbortSignal.timeout(10000) });
    const settings = await response.json();
    if (settings.gate) {
      const gate = await fetch(`${options.control}/gate?id=${child.id}`,
        { signal: AbortSignal.timeout(20000) });
      if (!gate.ok) throw new Error(`worker gate: ${gate.status}`);
      const current = data(await client.session.messages({ path: { id: sessionID } }));
      await report({ phase: 'worker.released', sessionID: child.id, parentID: sessionID,
        userID: user.info.id, latestUserID: current.findLast((message) => message.info.role === 'user')?.info.id,
        epoch, currentEpoch: epochs.get(sessionID) || 0 });
      return;
    }
    const extraction = data(await client.session.prompt({ path: { id: child.id }, body: {
      model: user.info.model, agent: user.info.agent,
      tools: Object.fromEntries(settings.tools.map((name) => [name, false])),
      system: 'Extract a reusable candidate from the supplied completed turn; return JSON only.',
      parts: [{ type: 'text', text: JSON.stringify({ userID: user.info.id,
        evidence: messages.filter((message) => message.info.id === user.info.id ||
          message.info.parentID === user.info.id) }) }],
    } }));
    await report({ phase: 'worker.completed', sessionID: child.id, userID: user.info.id,
      error: extraction.info.error, finish: extraction.info.finish,
      text: extraction.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') });
  }
  return {
    'chat.message'(input, output) {
      epochs.set(input.sessionID, (epochs.get(input.sessionID) || 0) + 1);
      if (options.observe) {
        const job = report({ phase: 'input.observed', sessionID: input.sessionID,
          userID: output.message.id, epoch: epochs.get(input.sessionID) }).finally(() => jobs.delete(job));
        jobs.add(job);
      }
    },
    event({ event }) {
      const sessionID = event.properties?.sessionID;
      if (options.observe && (event.type.startsWith('message.') ||
          ['session.status', 'session.idle', 'session.error'].includes(event.type))) {
        const job = report({ phase: 'host.event', event }).finally(() => jobs.delete(job));
        jobs.add(job);
      }
      if (event.type !== 'session.idle' &&
          !(event.type === 'session.status' && event.properties.status.type === 'idle')) return;
      const job = idle(sessionID).catch((error) => report({ phase: 'failed', message: error.message }))
        .finally(() => jobs.delete(job));
      jobs.add(job);
    },
    async dispose() { await Promise.all(jobs); },
  };
} };
