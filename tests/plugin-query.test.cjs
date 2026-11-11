const assert = require('node:assert/strict');
const test = require('node:test');
const load = () => import('../plugin/protocol.js');

test('retains a late service name when natural language exceeds the term budget', async () => {
  const { queryTerms } = await load();
  const input = 'please investigate what happened during the previous attempt and explain how we should recover the Deployment';

  const terms = queryTerms(input);

  assert.ok(terms.includes('Deployment'));
  assert.ok(terms.length <= 12);
});

test('retains path version and exact error anchors after a long explanation', async () => {
  const { queryTerms } = await load();
  const input = 'please explain how we can investigate the problem from yesterday before changing anything in our running service ' +
    'checkout-api ERR_CONNECTION_RESET /srv/checkout/config.yaml v0.6.0';

  const terms = queryTerms(input);

  for (const anchor of ['checkout-api', 'ERR_CONNECTION_RESET', '/srv/checkout/config.yaml', 'v0.6.0']) {
    assert.ok(terms.includes(anchor), anchor);
  }
});

test('scans beyond sixteen thousand characters for tail anchors', async () => {
  const { queryTerms } = await load();
  const input = `${'background '.repeat(2000)}Deployment ERR_TAIL_ONLY`;

  const terms = queryTerms(input);

  assert.ok(terms.includes('Deployment'));
  assert.ok(terms.includes('ERR_TAIL_ONLY'));
});

test('retains a useful interior anchor amid repeated filler', async () => {
  const { queryTerms } = await load();
  const filler = 'please explain what happened during the previous attempt before we change anything about this issue ';
  const input = `${filler.repeat(50)}checkout ${filler.repeat(50)}`;

  const terms = queryTerms(input);

  assert.ok(terms.includes('checkout'));
});

test('covers both ends when ordinary words exceed the term budget', async () => {
  const { queryTerms } = await load();
  const input = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango';

  const terms = queryTerms(input);

  assert.ok(terms.includes('alpha'));
  assert.ok(terms.includes('tango'));
  assert.equal(terms.length, 12);
});

test('preserves short query order and deduplication', async () => {
  const { queryTerms } = await load();
  const input = 'release convention release';

  const terms = queryTerms(input);

  assert.deepEqual(terms, ['release', 'convention']);
});

test('preserves Chinese and mixed script lexical runs', async () => {
  const { queryTerms } = await load();
  const input = '中文 发布 rust 中文Deployment失败';

  const terms = queryTerms(input);

  assert.deepEqual(terms, ['中文', '发布', 'rust', '中文Deployment失败']);
});

test('preserves combining marks and supplementary Unicode letters', async () => {
  const { queryTerms } = await load();
  const input = 'cafe\u0301 naïve 𐐀service';

  const terms = queryTerms(input);

  assert.deepEqual(terms, ['cafe\u0301', 'naïve', '𐐀service']);
});

test('keeps mixed script anchors in over-budget natural language', async () => {
  const { queryTerms } = await load();
  const input = 'please investigate how we can fix the failures from yesterday before changing any configuration 中文Deployment失败';

  const terms = queryTerms(input);

  assert.ok(terms.includes('中文Deployment失败'));
});

test('strips query metacharacters and controls while retaining literal anchors', async () => {
  const { queryTerms } = await load();
  const input = '"checkout-api" OR ("ERR_RESET"*) NEAR(\'src/main.js\',2)\0bad\u0001input\u007fvalue';

  const terms = queryTerms(input);

  assert.ok(terms.includes('checkout-api'));
  assert.ok(terms.includes('ERR_RESET'));
  assert.ok(terms.includes('src/main.js'));
  assert.ok(terms.every((term) => !/[\s"'()*:\p{C}]/u.test(term)));
});

for (const input of ['', ' \n\t', '"()*:\0\u0001💥']) {
  test(`returns no terms for input without lexical content ${JSON.stringify(input)}`, async () => {
    const { queryTerms } = await load();

    const terms = queryTerms(input);

    assert.deepEqual(terms, []);
  });
}

test('bounds each term by Unicode scalars without splitting supplementary letters', async () => {
  const { queryTerms } = await load();
  const input = `${'𐐀'.repeat(100)} ${'界'.repeat(100)}`;

  const terms = queryTerms(input);

  assert.deepEqual(terms, ['𐐀'.repeat(64), '界'.repeat(64)]);
});

test('returns at most twelve unique bounded terms in deterministic source order', async () => {
  const { queryTerms } = await load();
  const input = Array.from({ length: 200 }, (_, index) => `word${index} Service${index} path/${index}.js`).join(' ');

  const runs = [queryTerms(input), queryTerms(input)];

  assert.deepEqual(runs[0], runs[1]);
  assert.equal(runs[0].length, 12);
  assert.equal(new Set(runs[0]).size, 12);
  assert.ok(runs[0].every((term) => Array.from(term).length <= 64));
  const positions = runs[0].map((term) => input.indexOf(term));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});
