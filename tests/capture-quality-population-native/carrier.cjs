const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { population: selectedPopulation } = require('./population.cjs');
const { requireStage, hash } = require('./value.cjs');
const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const { isDeepStrictEqual } = require('node:util');
function matchesInput(tool, expected, actual) {
  if (tool !== 'bash' || !actual || !Object.hasOwn(actual, 'description')) return isDeepStrictEqual(expected, actual);
  const { description, ...execution } = actual;
  return typeof description === 'string' && description.length > 0 && description.length <= 256 &&
    [...description].every((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127) && isDeepStrictEqual(expected, execution);
}

function createCarrier(id, location, input) {
  const { resolveCase, payload, createDispatcher } = selectedPopulation(input);
  const { entry, original } = resolveCase(id);
  const dispatcher = createDispatcher(id);
  const root = location.root;
  requireStage(typeof root === 'string' && path.isAbsolute(root) && !/[\r\n]/.test(root) &&
    typeof location.node === 'string' && path.isAbsolute(location.node), 'explicit_private_carrier_required');
  let currentTurn = 0;
  let cursor = 0;
  let pending;
  let terminal = false;
  const steps = [];
  let turn = 0;
  for (const [name, args = {}] of entry.script) {
    const operation = entry.operations[name];
    if (operation?.pointer?.startsWith('/turns/')) turn = Number(operation.pointer.split('/')[2]);
    if (name === 'control') { steps.push({ control: args, turn }); continue; }
    const tool = operation.pointer?.match(/^\/turns\/\d+\/tools\/\d+\/output$/)
      ? payload(id, operation.pointer.slice(0, -7)) : undefined;
    const token = randomUUID();
    const file = path.join(root, `${token}.data`);
    const emitter = path.join(root, `${token}.cjs`);
    const nativeTool = ['read', 'verified-read', 'partial'].includes(operation.kind) ? 'read' : 'bash';
    const input = nativeTool === 'read' ? { filePath: file, ...(operation.kind === 'partial' ? { offset: 10, limit: 1 } : {}) }
      : { command: `${quoteShell(location.node)} ${quoteShell(emitter)}` };
    steps.push({ token, name, args, operation, tool, turn, file, emitter, nativeTool, input });
  }
  const operations = (index) => steps.filter((step) => step.token && step.turn === index)
    .map((step) => ({ token: step.token, tool: step.nativeTool, input: structuredClone(step.input) }));
  function prepare(token) {
    requireStage(!terminal && !pending, 'source_terminal_or_pending');
    while (steps[cursor]?.control) {
      const result = dispatcher.control(steps[cursor].control);
      requireStage(result.kind === 'control', result.code ?? 'outer_control_failed');
      cursor++;
    }
    const step = steps[cursor];
    requireStage(step && step.token === token && step.turn === currentTurn, 'source_order_or_identity');
    const result = dispatcher.model.execute(step.name, step.args);
    requireStage(result.kind === 'response', result.code ?? 'source_operation_blocked');
    const value = result.value;
    const observation = value.observation;
    const unavailable = observation?.outcome ?? (observation?.status === 404 ? '404' : null);
    const text = typeof value.output === 'string' ? value.output : unavailable ?? JSON.stringify(value);
    const failure = step.tool?.status === 'error' || unavailable === 'permission_denied';
    const partial = step.operation.kind === 'partial';
    const exposed = partial ? text.match(/10: ([^\n]*)/)?.[1] : text;
    requireStage(typeof exposed === 'string' && Buffer.byteLength(exposed) <= 8192, 'carrier_bytes');
    const data = partial ? `${Array(9).fill('[unobserved test-only padding]').join('\n')}\n${exposed}` : text;
    const observed = step.nativeTool === 'read' && !partial ? exposed.replace(/\r\n/g, '\n').replace(/\n$/, '') : exposed;
    pending = { ...step, text: observed, source_hash: hash(observed), raw_source_hash: hash(exposed), partial, failure, unavailable,
      files: [{ path: step.file, bytes: data }, ...(step.nativeTool === 'bash' && !failure ? [{ path: step.emitter,
        bytes: `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(step.file)}));` }] : [])] };
    return structuredClone({ ...pending, original: undefined, operation: undefined, tool: undefined });
  }
  function accept() {
    requireStage(pending, 'unprepared_source');
    const result = pending;
    terminal = pending.unavailable === 'permission_denied';
    pending = undefined;
    cursor++;
    return result;
  }
  return { operations, prepare, accept, pending: () => pending,
    turn(index) { requireStage(!pending, 'source_observation_missing'); currentTurn = index; },
    complete(index) { requireStage(!steps.slice(cursor).some((step) => step.token && step.turn <= index), 'source_stage_missing'); },
    audit: () => ({ ...dispatcher.audit(), planned: steps.filter((step) => step.token).length,
      observed: steps.slice(0, cursor).filter((step) => step.token).length, terminal }),
    originals: original.turns?.map((item) => ({ user: item.user, assistant: item.assistant })) };
}
module.exports = { createCarrier, matchesInput };
