const { fixture, user } = require('./plugin-fixture.cjs');

async function accessHost(options = {}) {
  const base = fixture();
  const config = options.config ?? base.config;
  const rules = [{ permission: '*', pattern: '*', action: 'allow' }];
  const session = { id: 'A', directory: base.input.directory, agent: 'build', permission: [] };
  base.input.client.app = { agents: async () => ({ data: [{ name: 'build', permission: rules }] }) };
  base.input.client.session.get = async () => ({ data: session });
  const { createRecallRuntime } = await import('../plugin/recall.js');
  const { createOperations } = await import('../plugin/operations.js');
  const { createTools } = await import('../plugin/tools.js');
  const runtime = createRecallRuntime(base.input, { automatic: true }, async (argv, settings) => {
    const answer = await base.run(argv, settings);
    return options.respond ? options.respond(argv, settings, answer) : answer;
  });
  runtime.config(config);
  const operations = createOperations(runtime, options.rememberHooks);
  const tools = createTools(operations);
  const asks = [];
  const context = { sessionID: 'A', messageID: 'explicit', agent: 'build', abort: new AbortController().signal,
    ask: async (request) => { asks.push(request); }, metadata() {} };
  const execute = async (name, args) => JSON.parse((await tools[`memocap_${name}`].execute(args, context)).output);
  const transform = async (id = 'turn') => {
    const message = user('A', id);
    message.info.agent = 'build';
    await runtime.transform({}, { messages: [message] });
    return message.parts.at(-1);
  };
  return { ...base, runtime, operations, rules, session, tools, asks, context, transform, execute };
}

module.exports = { accessHost };
