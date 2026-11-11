import { limits } from "./contract.js";
import { readSource } from "./read-source.js";

const route = /(?:docs?\/[^\s]+|https?:\/\/[^\s]+|\/[\w.-]+\/[^\s]+).*(?:entry|start|route|入口|参阅)|(?:entry|start|route|入口|参阅).*(?:docs?\/|https?:\/\/|\/[\w.-]+\/)/isu;

function completeSections(text) {
  const root = { level: 0, text: [], children: [] };
  const stack = [root];
  let fence;
  for (const line of text.split('\n')) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      stack.at(-1).text.push(line);
      continue;
    }
    const heading = !fence && /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      while (stack.at(-1).level >= heading[1].length) stack.pop();
      const section = { level: heading[1].length, text: [line], children: [] };
      stack.at(-1).children.push(section);
      stack.push(section);
    } else stack.at(-1).text.push(line);
  }
  if (fence) return [];
  const sections = [];
  function visit(section, ancestors) {
    const context = [...ancestors, section.text.join('\n').trim()].filter(Boolean);
    if (section.children.length) for (const child of section.children) visit(child, context);
    else {
      const whole = context.join('\n\n');
      if (whole && Array.from(whole).length <= limits.maxQuoteCodePoints) sections.push(whole);
    }
  }
  visit(root, []);
  return sections;
}

export function evidenceFor(messages, userID) {
  const evidence = new Map();
  for (const message of messages) {
    if (message.info.id !== userID && message.info.parentID !== userID) continue;
    for (const part of message.parts) {
      if (part.synthetic || part.ignored || part.metadata?.memocap) continue;
      let unit;
      if (message.info.id === userID && part.type === "text") {
        unit = { source: "user", text: part.text, pointer: `message:${userID}/${part.id}`,
          eligibility: "durable" };
      } else if (part.type === "tool") {
        const success = part.state.status === "completed";
        const text = success && typeof part.state.output === "string" ? part.state.output : "Unsupported tool evidence";
        const read = part.tool === "read" && success && typeof part.state.input?.filePath === "string" &&
          /(?:^|[/\\])(?:docs?[/\\].*\.md|README(?:[^/\\]*)\.md)$/i.test(part.state.input.filePath);
        const source = read ? readSource(text) : text;
        const sections = source === undefined ? [] : read ? completeSections(source) : [source];
        for (const [index, section] of sections.entries()) {
          const sourceId = sections.length === 1 && section === text ? part.id : `${part.id}/section:${index}`;
          const runbook = /(?:^|\n)\s*(?:`{3,}|~{3,}|\d+[.)]\s)/m.test(section);
          evidence.set(sourceId, Object.freeze({ source: "tool", success: read, text: section,
            pointer: `tool:${message.info.id}/${part.callID}`,
            eligibility: runbook ? "runbook" : read && route.test(section) ? "durable" : "unsupported" }));
        }
      }
      if (unit) evidence.set(part.id, Object.freeze(unit));
    }
  }
  return evidence;
}

export function extractionUnits(evidence) {
  return [...evidence].filter(([, unit]) => Array.from(unit.text).length <= limits.maxQuoteCodePoints)
    .slice(0, 12).map(([sourceId, unit]) => ({ sourceId, source: unit.source, text: unit.text }));
}
