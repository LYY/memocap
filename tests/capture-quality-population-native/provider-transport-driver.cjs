const assert = require('node:assert/strict');
const { egress, correlation } = require('./egress.cjs');
const { createMeter } = require('./inventory.cjs');

async function driver() {
  const { createOpencodeClient } = await import('@opencode-ai/sdk'); const cleanup = [];
  const meter = createMeter({ mode: 'offline' }, 'offline'); let calls = 0; let cancelled = 0;
  const endpoint = 'https://example.invalid/responses'; let chunks = 0;
  const transport = egress({ origin: 'http://127.0.0.1:4444', endpoints: [endpoint], session: (id) => id === 'observed-child',
    charge: meter.charge, transport: async (request) => {
      if (new URL(request.url).origin === 'http://127.0.0.1:4444') {
        cleanup.push([request.method, new URL(request.url).pathname]); return Response.json(true);
      }
      calls++; assert.equal(await request.text(), '{}'); assert.equal(request.headers.has(correlation), false);
      return new Response(new ReadableStream({ pull(controller) {
        chunks++; controller.enqueue(new Uint8Array(chunks === 1 ? 262144 : 1));
      }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  const request = () => new Request(endpoint, { method: 'POST', headers: { [correlation]: 'observed-child' }, body: '{}' });
  const response = await transport.provider(request());
  const reader = response.body.getReader(); assert.equal((await reader.read()).value.byteLength, 262144);
  await assert.rejects(reader.read(), /provider_response_body_limit/);
  await assert.rejects(transport.provider(request()), /provider_response_body_limit/);
  assert.equal(calls, 1); assert.equal(cancelled, 1);
  const sdk = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4444', fetch: transport.global, throwOnError: true });
  const before = meter.snapshot();
  await assert.rejects(sdk.session.delete({ path: { id: 'foreign' } }), /provider_response_body_limit/);
  assert.equal((await sdk.session.abort({ path: { id: 'observed-child' } })).data, true);
  assert.equal((await sdk.session.delete({ path: { id: 'observed-child' } })).data, true);
  assert.deepEqual(cleanup, [['POST', '/session/observed-child/abort'], ['DELETE', '/session/observed-child']]);
  await assert.rejects(transport.provider(request()), /provider_response_body_limit/);
  assert.deepEqual(meter.snapshot(), before); assert.equal(calls, 1);
  return { kind: 'offline_provider_transport_driver', status: 'verified', transport_calls: calls, cancelled_sources: cancelled,
    budget_used: meter.snapshot(), rejected_overflow_bytes: 1, second_dispatch: false, owned_sdk_cleanup: cleanup,
    cleanup_settled: true, first_stop_reason: 'provider_response_body_limit', real_runtime: 'NOT_RUN', quality_credit: false };
}
if (require.main === module) driver().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`${error instanceof Error ? error.name : 'unknown'}\n`); process.exitCode = 1; });
module.exports = { driver };
