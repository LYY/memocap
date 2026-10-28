const { version } = require('../package.json');
const path = require('node:path');

const repoPath = (...segments) => path.resolve('/repo', ...segments);

function receipt(operation, overrides = {}) {
  return {
    format_version: 1, package_version: version, operation_id: '00000000-0000-0000-0000-000000000311',
    operation, status: 'ok', backend: 'local', origin: 'cli',
    targets: [{ canonical_path: repoPath('A'), repository_id: 'repository:A', identity_source: 'directory', placements: [] }],
    results: [], returned_ids: [], activity_status: 'recorded', ...overrides,
  };
}

function memory(id = 1, content = 'release convention') {
  return { memory: { id, content, placement: 'repository:A', kind: 'decision', tags: '' },
    source_order: 0, visibility: 'visible', applicable_repositories: ['repository:A'] };
}

function user(sessionID = 'A', id = 'msg-1', text = 'release convention') {
  return { info: { sessionID, id, role: 'user' }, parts: [
    { id: `prt-${id}`, sessionID, messageID: id, type: 'text', text },
  ] };
}

function fixture() {
  const calls = [];
  const notices = [];
  const directories = { A: repoPath('A'), B: repoPath('B'), child: repoPath('child') };
  const input = { directory: directories.A, worktree: directories.A, project: { id: 'project' }, client: {
    session: { get: async ({ path }) => ({ data: { id: path.id, directory: directories[path.id] ?? directories.A } }) },
    tui: { showToast: async (notice) => { notices.push(notice); } },
  } };
  const run = async (argv, options) => {
    calls.push({ argv, options });
    const paths = argv.flatMap((arg, index) => arg === '--repo' ? [argv[index + 1]] : []);
    return { receipt: receipt(argv[0], { targets: paths.map((directory) => ({ canonical_path: directory,
      repository_id: `repository:${path.basename(directory)}`, identity_source: 'directory', placements: [] })),
      ...(argv[0] === 'recall' ? { results: [memory()], returned_ids: [1] } : {}) }) };
  };
  return { calls, notices, input, run };
}

async function sandbox() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-v1-plugin-'));
  for (const directory of ['bin', 'plugin', 'skills/memocap', 'A', 'B']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.cpSync(path.join(__dirname, '../plugin'), path.join(root, 'plugin'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../skills'), path.join(root, 'skills'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../lib'), path.join(root, 'lib'), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version }));
  fs.writeFileSync(path.join(root, 'bin/cli.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('memocap ' + version); return; }
const log = path.join(root, 'calls.jsonl');
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const operation = args[0];
const repos = args.flatMap((arg, index) => arg === '--repo' ? [args[index+1]] : []);
const targets = (repos.length ? repos : [process.cwd()]).map(canonical_path => ({canonical_path,repository_id:'repository:'+path.basename(canonical_path),identity_source:'directory',placements:[]}));
const file = path.join(root, 'rows.json');
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
const envelope = {format_version:1,package_version:version,operation_id:'00000000-0000-0000-0000-000000000311',operation,status:'ok',backend:'local',origin:'cli',targets,results:[],returned_ids:[],activity_status:'recorded'};
if (operation === 'remember') {
 const positional = args.slice(args.indexOf('--')+1);
 if(positional.length !== 1) { process.stderr.write('separator mishandled'); process.exit(2); }
 rows.push({memory:{id:rows.length+1,content:positional[0],placement:targets[0].repository_id,kind:'decision',tags:''},source_order:0,visibility:'visible',applicable_repositories:[targets[0].repository_id]});
 fs.writeFileSync(file,JSON.stringify(rows));
 envelope.status='inserted'; envelope.returned_ids=[rows.at(-1).memory.id]; envelope.searched_placements=[targets[0].repository_id];
}
if(operation === 'recall') envelope.results=[{memory:{id:91,content:'fixture release convention',placement:targets[0].repository_id,kind:'decision',tags:''},source_order:0,visibility:'visible',applicable_repositories:[targets[0].repository_id]}];
if(operation === 'list') envelope.results=rows.filter(row=>row.memory.placement === args[args.indexOf('--placement')+1]);
if(operation !== 'remember') envelope.returned_ids=envelope.results.map(row=>row.memory.id);
process.stdout.write(JSON.stringify(envelope));
`);
  return { root, A: path.join(root, 'A'), B: path.join(root, 'B'),
    module: await import(pathToFileURL(path.join(root, 'plugin/index.js')).href),
    calls: () => fs.existsSync(path.join(root, 'calls.jsonl')) ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const organizationDatabase = path.resolve('/isolated/memory.db');
const organizationSnapshot = (id = 7, content = 'original') => ({ id, placement: 'universal', scope: 'global', content,
  kind: 'context', tags: '', topic_key: '', created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:00:00Z', organized_at: null, provenance: null });
const organizationReceipt = (operation, organization, extra = {}) => receipt(`organize_${operation}`, {
  targets: [], results: [], activity_status: 'not_requested', organization, ...extra,
  returned_ids: operation === 'read' ? organization.records.filter((row) => row.snapshot).map((row) => row.id)
    : organization.records.map((row) => row.id),
});

async function organizationHost(context, respond) {
  const base = fixture();
  context.mock.property(process, 'env', { ...process.env, MEMOCAP_DB: organizationDatabase,
    MEMOCAP_ADDR: '', MEMOCAP_URL: '', MEMOCAP_ADDRESS: '' });
  const { createRecallRuntime } = await import('../plugin/recall.js');
  const { createOperations } = await import('../plugin/operations.js');
  const { createOrganization } = await import('../plugin/organization.js');
  const { createTools } = await import('../plugin/tools.js');
  const { createCommands } = await import('../plugin/commands.js');
  const { loadPolicy } = await import('../plugin/policy.js');
  const runtime = createRecallRuntime(base.input, {}, base.run);
  const policy = loadPolicy();
  const organizationCalls = [];
  const invoke = async (argv, options) => {
    organizationCalls.push({ argv, options });
    const operation = argv[1];
    const request = JSON.parse(options.stdin);
    return { receipt: respond ? await respond(operation, request, options) : organizationReceipt(operation, {
      database: options.env.MEMOCAP_DB, selection: request.selection ?? 'pending', upper_id: 7,
      next_id: 7, exhausted: false, records: [organizationSnapshot()],
    }) };
  };
  const operations = { ...createOperations(runtime), organization: createOrganization(runtime, policy, invoke) };
  const tools = createTools(operations);
  const commands = createCommands(operations, runtime, policy.provenance);
  await commands.config({});
  const asks = [];
  const toolContext = { sessionID: 'A', messageID: 'tool-message', abort: new AbortController().signal,
    ask: async (permission) => { asks.push(permission); }, metadata() {} };
  const command = async (argumentsText) => {
    const output = { parts: [{ type: 'text', messageID: 'org-command', text: 'placeholder' }] };
    await commands.execute({ command: 'memory', sessionID: 'A', arguments: argumentsText }, output);
    return { payload: JSON.parse(output.parts[0].text), part: output.parts[0] };
  };
  const execute = async (args) => JSON.parse((await tools.memocap_organize.execute(args, toolContext)).output);
  return { ...base, runtime, commands, tools, policy, organizationCalls, asks, toolContext, command, execute };
}

module.exports = { receipt, memory, user, fixture, sandbox, repoPath,
  organizationHost, organizationDatabase, organizationSnapshot, organizationReceipt };
