const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { meta, writes } = require('./cases.cjs');
const { crossProject } = require('./cross-project.cjs');

async function documentRoute(current, evidence) {
  const docs = path.join(current.fixture.project, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const filePath = path.join(docs, 'entry.md');
  const section = '# Project\n\n## Alpha environment\n\nStart at docs/alpha.md. Approval required.\n\nNever use this entry for beta.';
  fs.writeFileSync(filePath, `${section}\n\n## Development\n\n\`\`\`sh\n${'build project\n'.repeat(100)}\`\`\`\n`);
  const parent = await current.parent();
  const before = writes(current.control);
  current.provider.responses.push({ tool: 'read', args: { filePath } }, { text: 'Read confirmed.' },
    current.extract((parsed) => {
      const selected = parsed.evidence.find((unit) => unit.text.includes('docs/alpha.md'));
      assert.ok(selected, JSON.stringify(parsed.evidence));
      assert.match(selected.text, /Never use this entry for beta/);
      return { candidates: [{ evidence: [{ sourceId: selected.sourceId, quote: selected.text }] }] };
    }), current.commit(), { text: 'Saved.' });
  await current.prompt(parent, 'Read docs/entry.md to locate the alpha entry.');
  const result = await current.review(parent);
  assert.equal(meta(result).status, 'saved', JSON.stringify(result));
  assert.equal(writes(current.control), before + 1);
  const rows = await current.cli(['list', '--repo', current.fixture.project]);
  const saved = rows.results.find((entry) => entry.memory.content.includes('docs/alpha.md'));
  assert.ok(saved);
  assert.match(saved.memory.content, /Alpha environment/);
  assert.match(saved.memory.content, /Approval required/);
  assert.match(saved.memory.content, /Never use this entry for beta/);
  evidence.cases.push({ name: 'actual_read_long_document_short_complete_route', review: meta(result) });
  await crossProject(current, evidence, { parent, saved: saved.memory, review: meta(result) });
}

async function readFailures(current, evidence) {
  const parent = await current.parent();
  const text = 'I prefer concise responses for the read failure fixture.';
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Saved.' });
  await current.prompt(parent, text);
  assert.equal(meta(await current.review(parent)).status, 'saved');
  const before = writes(current.control);
  const observed = current.control.events.length;
  current.control.settings.failRead = true;
  current.provider.responses.push({ text: 'Confirmed again.' }, current.extract());
  await current.prompt(parent, text);
  const failed = await current.review(parent, observed);
  current.control.settings.failRead = false;
  assert.equal(meta(failed).status, 'failed');
  assert.equal(meta(failed).write_attempts, 0);
  assert.deepEqual(meta(failed).memory_ids, []);
  assert.equal(writes(current.control), before);
  evidence.cases.push({ name: 'controlled_duplicate_full_read_failure_zero_writes', review: meta(failed) });

  const mismatch = await current.parent();
  current.control.settings.mismatchReadTags = true;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Unknown.' });
  await current.prompt(mismatch, 'I prefer explicit units for the tag readback fixture.');
  const changed = await current.review(mismatch);
  current.control.settings.mismatchReadTags = false;
  assert.equal(meta(changed).status, 'unknown');
  assert.equal(meta(changed).write_attempts, 1);
  assert.equal(meta(changed).memory_ids.length, 1);
  assert.equal(writes(current.control), before + 1);
  evidence.cases.push({ name: 'controlled_native_tag_mismatch_never_saved_or_retried', review: meta(changed) });
}

module.exports = { documentRoute, readFailures };
