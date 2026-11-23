const { createHash } = require('node:crypto');

// Deidentified equal-CP fixture: 151-CP locators and 30-CP source handles preserve the measured budget.
const statement = 'For Vessa contour ledger imported offline relief sheets, use Sheets > Trace index with trace_order=by_height and bridge_gaps=off to preserve deliberate contour gaps; this route excludes live stylus traces. The entry guide establishes the menu and order, while independent renderer verification establishes gap preservation (bridge_gaps=on joins gaps and changes contours).';
const quotes = [
  'Vessa contour ledger: offline relief sheets enter the trace index at Sheets > Trace index with trace_order=by_height. This route applies to imported relief sheets, not live stylus traces. Gap handling is a separate setting and is not established by this entry guide.',
  'Independent Vessa renderer verification: imported relief sheets with deliberate contour gaps retain those gaps with bridge_gaps=off; bridge_gaps=on joins them and changes the contours. This check verifies the gap setting for offline relief sheets. It does not determine the menu entry or trace ordering.',
];
const citations = quotes.map((quote, index) => ({
  source_id: `synthetic_vessa_source_${index}`.padEnd(30, 'x'),
  content_hash: createHash('sha256').update(quote).digest('hex'),
  span: { start: 0, end: [...quote].length }, quote, user_id: index === 0 ? 't1' : 't3',
  pointer: { type: 'file', locator: `${`/synthetic/vessa/project/source-${index}/`.padEnd(146, 'x')}.data`,
    observed_at: 1700000000000 + index, line_range: { start: 1, end: 1 } },
}));
const units = [{ text: statement, citations }];
function sourceExtra(index) {
  const citation = citations[index];
  return { text: citation.quote, change(part) {
    part.id = citation.source_id;
    part.state.output = part.state.output.replaceAll(part.state.input.filePath, citation.pointer.locator);
    part.state.input.filePath = citation.pointer.locator;
    part.state.metadata.display.path = citation.pointer.locator;
  } };
}
module.exports = { statement, quotes, citations, units, sourceExtra };
