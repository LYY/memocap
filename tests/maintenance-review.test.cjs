const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./maintenance-integration/fixture.cjs');

test('a used task with no persistent maintenance grant keeps a concrete supported proposal visible', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = (data) => ({ action: 'update', target: data.used[0].use_id, content: 'new route',
    citations: [{ source_id: data.evidence[0].source_id, quote: 'Check current route' }] });
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  const summary = host.runtime.maintenanceStatus('A');
  assert.equal(summary.status, 'proposal');
  assert.equal(summary.reason, 'maintenance_grant_required');
  assert.equal(summary.proposal.action, 'update');
  assert.equal(summary.proposal.content, 'new route');
  assert.equal(summary.model_calls, 2);
  assert.equal(summary.child_sessions, 1);
  assert.equal(host.writes.length, 0);
  assert.equal(host.asks.filter((ask) => ask.permission === 'memocap_maintain').length, 0);
});

test('independent support assessment can refuse mutation even when extraction proposes it', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.support = 'unsupported';
  host.modelDecision = (data) => ({ action: 'update', target: data.used[0].use_id, content: 'invented route',
    citations: [{ source_id: data.evidence[0].source_id, quote: 'Check current route' }] });
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  assert.equal(host.runtime.maintenanceStatus('A').reason, 'unsupported');
  assert.equal(host.writes.length, 0);
});

test('task completion without actual use performs no model generation or write', async (context) => {
  const host = await fixture(context);
  await host.read();
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  assert.equal(host.runtime.maintenanceStatus('A').status, 'no_candidate');
  assert.equal(host.runtime.maintenanceStatus('A').model_calls, 0);
  assert.equal(host.writes.length, 0);
});
