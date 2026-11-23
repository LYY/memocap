const filePath = '/synthetic/alpha.js';
function readObservation(text = 'A😀中', change = {}) {
  const lines = text.split(/\r\n?|\n/);
  const output = `<path>${filePath}</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`;
  return {
    host_version: '1.19.3', user_id: 'user', observed_at: 1700000000000,
    message: { id: 'message', role: 'assistant', parentID: 'user' },
    part: { id: 'part', messageID: 'message', type: 'tool', tool: 'read', callID: 'call',
      state: { status: 'completed', input: { filePath }, output,
        metadata: { truncated: false, display: { type: 'file', path: filePath, text,
          lineStart: 1, lineEnd: lines.length, totalLines: lines.length, truncated: false } },
        time: { start: 1699999999990, end: 1700000000000 } } },
    ...change,
  };
}
function commandObservation(text = 'queued\n', exit = 0) {
  const observation = readObservation();
  observation.part.tool = 'bash';
  observation.part.state = { status: 'completed', input: { command: 'printf queued', description: 'Synthetic' },
    output: text, metadata: { output: text, exit, truncated: false },
    time: { start: 1699999999990, end: 1700000000000 } };
  return observation;
}
module.exports = { readObservation, commandObservation };
