const termBudget = 12;
const tokenPattern = /(?:\.{0,2}[/\\])?[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*(?:[-./\\][\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*)*/gu;

function coverage(candidates, budget) {
  const frequencies = new Map();
  for (const candidate of candidates) {
    const bucket = frequencies.get(candidate.count) ?? [];
    bucket.push(candidate);
    frequencies.set(candidate.count, bucket);
  }
  const selected = [];
  for (const frequency of [...frequencies.keys()].sort((left, right) => left - right)) {
    const bucket = frequencies.get(frequency);
    const slots = Math.min(budget - selected.length, bucket.length);
    for (let index = 0; index < slots; index++) {
      selected.push(bucket[slots === 1 ? bucket.length - 1 : Math.floor(index * (bucket.length - 1) / (slots - 1))]);
    }
    if (selected.length === budget) break;
  }
  return selected;
}

export function queryTerms(text) {
  const unique = new Map();
  for (const match of text.matchAll(tokenPattern)) {
    const term = Array.from(match[0]).slice(0, 64).join("");
    const existing = unique.get(term);
    if (existing) existing.count++;
    else unique.set(term, { term, count: 1, position: match.index });
  }
  const candidates = [...unique.values()];
  if (candidates.length <= termBudget) return candidates.map(({ term }) => term);

  const anchors = [];
  const names = [];
  const words = [];
  for (const candidate of candidates) {
    if (/[-\p{N}_./\\]/u.test(candidate.term)) anchors.push(candidate);
    else if (/\p{Lu}/u.test(candidate.term) ||
        (/\p{Script=Han}/u.test(candidate.term) && /\p{Script=Latin}/u.test(candidate.term))) names.push(candidate);
    else words.push(candidate);
  }
  const groups = [anchors, names, words].map((candidates) => ({ candidates, budget: 0 }));
  let remaining = termBudget;
  while (remaining > 0) {
    for (const group of groups) {
      if (remaining > 0 && group.budget < group.candidates.length) {
        group.budget++;
        remaining--;
      }
    }
  }
  return groups.flatMap(({ candidates, budget }) => coverage(candidates, budget))
    .sort((left, right) => left.position - right.position).map(({ term }) => term);
}
