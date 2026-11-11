export function readSource(output) {
  if (!output.startsWith('<path>')) return output;
  const envelope = /^<path>[^\n]+<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*?)\n\n\(End of file - total (\d+) lines\)\n<\/content>$/.exec(output);
  if (!envelope) return undefined;
  const numbered = envelope[1].split('\n');
  if (numbered.length !== Number(envelope[2])) return undefined;
  const lines = [];
  for (const [index, line] of numbered.entries()) {
    const match = /^(\d+): ?(.*)$/.exec(line);
    if (!match || Number(match[1]) !== index + 1) return undefined;
    lines.push(match[2]);
  }
  return lines.join('\n');
}
