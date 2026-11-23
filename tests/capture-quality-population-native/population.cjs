const inputs = require('../capture-quality-population/inputs.cjs');
const { createDispatcher } = require('../capture-quality-population/dispatcher.cjs');
const { requireStage } = require('./value.cjs');
const { createEvaluation, compileEvaluation } = require('./evaluation.cjs');

const tuningPopulation = Object.freeze({ ...inputs, createDispatcher, frozen: true });
function population(value = tuningPopulation) {
  if (value?.kind === 'finite-evaluation-v1' || value?.descriptor) return compileEvaluation(value.descriptor ?? value);
  requireStage(value?.frozen === true && value.mapping === inputs.mapping && value.tuning === inputs.tuning &&
    value.resolveCase === inputs.resolveCase && value.payload === inputs.payload &&
    value.createDispatcher === createDispatcher, 'explicit_frozen_population_required');
  return value;
}
module.exports = { population, tuningPopulation, createEvaluation };
