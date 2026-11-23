const assert = require('node:assert/strict');
const test = require('node:test');

const agent = { name: 'build', permission: [{ permission: 'memocap_remember', pattern: '*', action: 'allow' }] };
const deny = { permission: 'memocap_remember', pattern: 'repository:fixture', action: 'deny' };

for (const [label, sessionFields, agents, error] of [
  ['omitted session rules become empty', {}, [agent]],
  ['undefined session rules become empty', { permission: undefined }, [agent]],
  ['empty session rules stay empty', { permission: [] }, [agent]],
  ['null session rules are unavailable', { permission: null }, [agent], 'permission_unavailable'],
  ['non-array session rules are unavailable', { permission: {} }, [agent], 'permission_unavailable'],
  ['malformed session rule entries are unavailable', { permission: [null] }, [agent], 'permission_unavailable'],
  ['an absent agent is unavailable even with omitted session rules', {}, [], 'permission_unavailable'],
  ['a matching session deny overrides agent allow', { permission: [deny] }, [agent], 'permission_deny'],
]) {
  test(`capture permission snapshot: ${label}`, async () => {
    const { permissionSnapshot } = await import('../plugin/capture/permission.js');
    const client = {
      session: { get: async () => ({ data: { id: 'parent', ...sessionFields } }) },
      app: { agents: async () => ({ data: agents }) },
    };
    const turn = { parentID: 'parent', agent: 'build', target: { repository_id: 'repository:fixture' }, controller: new AbortController() };

    const result = permissionSnapshot(client, turn);

    if (error) await assert.rejects(result, { code: error, status: 'denied' });
    else assert.deepEqual((await result).permission, []);
  });
}
