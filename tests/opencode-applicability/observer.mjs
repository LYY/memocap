import fs from 'node:fs';

export default { id: 'applicability-fixture-observer', async server(input, options) {
  const { memocap } = await import(options.plugin);
  const { tool } = await import(options.sdk);
  const hooks = await memocap(input, options.policy);
  const record = (event) => fs.appendFileSync(options.journal, `${JSON.stringify(event)}\n`);
  return { ...hooks,
    async config(config) {
      await hooks.config(config);
      config.permission.fixture_source = 'allow';
      config.permission.fixture_destination = 'allow';
      config.permission.fixture_dispatch = { '*': 'allow', alpha: 'deny' };
    },
    tool: { ...Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, {
      ...definition, async execute(args, context) {
        const result = await definition.execute(args, context);
        record({ phase: 'native_callback', session: context.sessionID, tool: name, args,
          receipt: JSON.parse(result.output) });
        return result;
      },
    }])),
    fixture_source: tool({ description: 'Read the current synthetic authoritative route.',
      args: { key: tool.schema.string() },
      async execute(args, context) {
        const source = JSON.parse(fs.readFileSync(options.sources, 'utf8'))[args.key];
        if (!source) throw new Error('Unknown synthetic source');
        record({ phase: 'source_read', session: context.sessionID, key: args.key, source });
        return JSON.stringify(source);
      },
    }),
    fixture_destination: tool({ description: 'Invoke an isolated mock business destination.',
      args: { environment: tool.schema.string(), entry: tool.schema.string() },
      async execute(args, context) {
        record({ phase: 'dispatch', session: context.sessionID, args });
        await context.ask({ permission: 'fixture_dispatch', patterns: [args.environment],
          always: [args.environment], metadata: args });
        record({ phase: 'destination_action', session: context.sessionID, args });
        return JSON.stringify({ mock: true, accepted: args });
      },
    }) },
  };
} };
