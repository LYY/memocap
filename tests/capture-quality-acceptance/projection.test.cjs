const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { population, save, annotations, outputJudgment } = require('./examples.cjs');
const root = path.resolve(__dirname, '../..');

test('B1 public collect runs with only committable collector, tuning and mapping dependencies', () => {
  const prefix = 'tests/capture-quality-acceptance/';
  const files = new Map([...fs.readdirSync(__dirname).filter((name) => /\.(cjs|json)$/.test(name)).map((name) => prefix + name),
    'tests/capture-evaluation/tuning.json', 'tests/capture-quality-population/mapping.json']
    .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const cache = new Map(); const loaded = [];
  function load(file) {
    if (['node:crypto', 'node:util'].includes(file)) return require(file);
    assert.ok(files.has(file), `Uncommittable or external dependency: ${file}`);
    loaded.push(file);
    if (cache.has(file)) return cache.get(file).exports;
    const text = files.get(file);
    if (file.endsWith('.json')) return JSON.parse(text);
    const module = { exports: {} }; cache.set(file, module);
    const local = (request) => load(request.startsWith('node:') ? request : path.posix.normalize(path.posix.join(path.posix.dirname(file), request)));
    vm.runInNewContext(`(function(require,module,exports){${text}\n})`, {}, { filename: file })(local, module, module.exports);
    return module.exports;
  }
  const input = population(); save(input, 'same-source-distinct-claims');

  const { collect } = load(prefix + 'index.cjs');
  const labels = annotations(); labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0, 1]));
  const result = collect(input, labels);

  assert.equal(result.metrics.capture_admission_precision.value, 1);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 2);
  assert.equal(result.freeze.planned.capture_opportunities, 8);
  assert.ok(loaded.every((file) => !file.startsWith('.omo/')));
});

test('B3 real receipt transform accepts synthetic raw native writes and reads without invented caller fields', () => {
  const file = 'tests/capture-quality-native/projection.cjs'; const module = { exports: {} };
  const imports = { 'node:crypto': require('node:crypto'), '../../plugin/protocol.js': {}, './entry.cjs': { CanaryBlocked: Error } };
  const local = (request) => { assert.ok(Object.hasOwn(imports, request)); return imports[request]; };
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.join(root, file), 'utf8')}\n})`, {}, { filename: file })(local, module, module.exports);
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  const record = item.trace.saved_outputs[0].record;
  for (const event of item.trace.events.filter((entry) => ['native.commit', 'native.readback'].includes(entry.kind))) {
    const read = event.kind === 'native.readback';
    event.receipt = module.exports.receipt({ operation: read ? 'read' : 'remember', operation_id: read ? 'raw-read' : 'raw-write',
      status: read ? 'ok' : 'inserted', truncated: false, returned_ids: [record.id],
      results: [{ memory: { id: record.id, placement: record.placement, content: record.content, tags: '' }, completeness: 'full' }] });
  }
  item.trace.writes[0].receipt = item.trace.events.find((event) => event.kind === 'native.commit').receipt;
  const { collect } = require('./index.cjs'); const labels = annotations();
  labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0, 1]));

  const result = collect(input, labels);

  assert.equal(result.inventory.attempts[0].verified, true);
  assert.equal(result.metrics.capture_admission_precision.value, 1);
});
