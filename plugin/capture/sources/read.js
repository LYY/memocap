import { normalize, truncated } from './value.js';

export function readFrame(state) {
  const path = state.input?.filePath;
  const display = state.metadata?.display;
  if (typeof path !== 'string' || !path || path.includes('\n') || path.includes('\r') ||
      state.metadata?.truncated !== false || display?.truncated !== false || display.type !== 'file' ||
      display.path !== path || typeof display.text !== 'string' ||
      (state.input.offset !== undefined && state.input.offset !== 1) ||
      typeof state.output !== 'string' || truncated(state.output)) return;
  const output = normalize(state.output);
  const prefix = `<path>${path}</path>\n<type>file</type>\n<content>\n`;
  if (!output.startsWith(prefix)) return;
  const content = output.slice(prefix.length);
  const footer = content.match(/\n\n\(End of file - total (\d+) lines\)\n<\/content>$/);
  if (!footer) return;
  const total = Number(footer[1]);
  const numbered = content.slice(0, footer.index).split('\n');
  if (!Number.isSafeInteger(total) || total < 1 || numbered.length !== total ||
      display.lineStart !== 1 || display.lineEnd !== total || display.totalLines !== total) return;
  const lines = [];
  for (const [index, line] of numbered.entries()) {
    const number = `${index + 1}: `;
    if (!line.startsWith(number)) return;
    lines.push(line.slice(number.length));
  }
  const text = lines.join('\n');
  if (normalize(display.text) !== text) return;
  return { text, locator: path, kind: 'file_content', outcome: { type: 'observed_content' },
    authority: 'observed_content', line_range: { start: 1, end: total } };
}
