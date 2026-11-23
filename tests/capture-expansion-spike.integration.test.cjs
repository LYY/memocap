const test = require('node:test');
const { runSpike, runProbes } = require('./capture-expansion-spike/run.cjs');
const { runProduction } = require('./capture-expansion-spike/production.cjs');

test('bounded observed acquisition and three dispatch native commit on the real isolated host', {
  skip: process.env.MEMOCAP_CAPTURE_EXPANSION_SPIKE !== '1', timeout: 900000,
}, runSpike);

test('native invalidation boundary probes on the real isolated host', {
  skip: process.env.MEMOCAP_CAPTURE_EXPANSION_SPIKE !== '1', timeout: 180000,
}, runProbes);

test('production bounded acquisition and native barrier on the real isolated host', {
  skip: process.env.MEMOCAP_CAPTURE_PRODUCTION !== '1', timeout: 600000,
}, runProduction);
