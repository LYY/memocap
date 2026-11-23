const { TransportBlocked, requireStage } = require('./value.cjs');
const providerBodyLimit = 262144;

function meteredBody(body, options) {
  if (!body) return null;
  const reader = body.getReader(); let bytes = 0; let finished = false;
  const cancel = (reason) => { void reader.cancel(reason).catch(() => options.stop('provider_cancel_unknown')); };
  let abort;
  const finish = () => { finished = true; options.signal.removeEventListener('abort', abort); };
  return new ReadableStream({
    start(controller) {
      abort = () => {
        if (finished) return;
        finish(); const error = new TransportBlocked(options.stop('provider_aborted'));
        controller.error(error); cancel(error);
      };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { finish(); controller.close(); return; }
        requireStage(next.value instanceof Uint8Array, 'provider_body_chunk_invalid');
        requireStage(bytes + next.value.byteLength <= providerBodyLimit, `provider_${options.direction}_body_limit`);
        options.charge(`provider_${options.direction}_bytes`, next.value.byteLength);
        bytes += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        finish(); controller.error(error);
        options.stop(error instanceof TransportBlocked ? error.code : `provider_${options.direction}_unknown`);
        cancel(error);
      }
    },
    cancel(reason) { finish(); options.stop(`provider_${options.direction}_cancelled`); cancel(reason); },
  }, { highWaterMark: 0 });
}

async function requestBody(body, options) {
  const stream = meteredBody(body, { ...options, direction: 'request' });
  if (!stream) return null;
  const buffer = new Uint8Array(providerBodyLimit); let bytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      buffer.set(next.value, bytes); bytes += next.value.byteLength;
    }
    return buffer.subarray(0, bytes);
  } finally { reader.releaseLock(); }
}

async function dispatch(transport, request) {
  let abort;
  const interrupted = new Promise((_resolve, reject) => {
    abort = () => reject(new TransportBlocked('provider_aborted'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    request.signal.throwIfAborted();
    const response = Promise.resolve(transport(request)).then((value) => {
      if (request.signal.aborted) {
        if (value.body) void value.body.cancel('provider_aborted').catch(abort);
        throw new TransportBlocked('provider_aborted');
      }
      return value;
    });
    return await Promise.race([response, interrupted]);
  }
  finally { request.signal.removeEventListener('abort', abort); }
}
module.exports = { providerBodyLimit, meteredBody, requestBody, dispatch };
