const { requireStage, size } = require('./value.cjs');

function boundSDK(client, charge) {
  const guarded = Object.create(client);
  for (const [group, methods] of Object.entries({ session: ['get', 'create', 'update', 'prompt', 'messages', 'abort', 'delete'],
    config: ['get'], app: ['agents'], tool: ['ids'], _client: ['get'] })) {
    if (!client[group]) continue;
    const member = Object.create(client[group]);
    for (const name of methods.filter((method) => typeof client[group][method] === 'function')) {
      member[name] = async (...args) => {
        requireStage(size(args) <= 65536, 'sdk_request_bytes');
        charge('sdk_requests'); charge('total_bytes', size(args));
        const response = await client[group][name](...args);
        requireStage(size(response) <= 131072, 'sdk_response_bytes');
        charge('total_bytes', size(response));
        return response;
      };
    }
    Object.defineProperty(guarded, group, { value: member });
  }
  return guarded;
}
module.exports = { boundSDK };
