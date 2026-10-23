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
  fs.copyFileSync(path.join(__dirname, '../skills/memocap/SKILL.md'), path.join(root, 'skills/memocap/SKILL.md'));
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

module.exports = { receipt, memory, user, fixture, sandbox, repoPath };
