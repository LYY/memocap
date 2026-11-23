const { readObservation } = require('./capture-source-host/synthetic.cjs');
const { QualityBlocked } = require('./capture-quality-boundary.cjs');

async function qualityContext(fixture) {
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const source = fixture.turns[0];
  const observation = readObservation(source.tools[0].output);
  observation.part.state.output = observation.part.state.output.replace(
    `<path>${observation.part.state.input.filePath}</path>`, `<path>${source.tools[0].path}</path>`);
  observation.part.state.input.filePath = source.tools[0].path;
  observation.part.state.metadata.display.path = source.tools[0].path;
  const frames = [{ userID: 'user', at: 1700000000000, messages: [
    { info: { id: 'user', role: 'user' }, parts: [{ id: 'user-text', type: 'text', text: source.user }] },
    { info: observation.message, parts: [observation.part] },
  ] }];
  const turn = { userID: 'user', targets: [`repository:${'a'.repeat(64)}`] };
  const context = evidenceContext(frames, turn, '1.19.5');
  if (!context.packet.sources.some((entry) => entry.kind === 'file_content' && entry.text === source.tools[0].output)) {
    throw new QualityBlocked('tuning_source_missing');
  }
  return { frames, turn, context };
}
module.exports = { qualityContext };
