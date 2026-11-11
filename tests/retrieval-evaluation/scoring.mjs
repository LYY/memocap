import assert from "node:assert/strict";

export function scoreCase(expected, observed, records) {
  const wanted = expected.expectedIDs;
  const positive = wanted.length > 0;
  assert.equal(positive, !Boolean(expected.expectedNoAnswer));
  const rank = observed.returned.findIndex((id) => wanted.includes(id)) + 1;
  const coverage = (ids) => {
    if (!positive) return null;
    const found = wanted.filter((id) => ids.includes(id)).length;
    return expected.idRule === "any" ? Number(found > 0) : found / wanted.length;
  };
  const completeConcepts = new Set(records.filter((record) =>
    wanted.includes(record.id) && observed.complete.includes(record.id)).flatMap((record) => record.concepts));
  const missingConcepts = expected.concepts.filter((concept) => !completeConcepts.has(concept));
  const forbidden = observed.returned.filter((id) => (expected.forbiddenIDs ?? []).includes(id));
  const negativeNoise = !positive && observed.returned.length > 0;
  return {
    positive, hit1: positive ? Number(rank === 1) : null,
    hit3: positive ? Number(rank > 0 && rank <= 3) : null,
    reciprocalRank: positive ? (rank > 0 ? 1 / rank : 0) : null,
    idCoverage: coverage(observed.returned),
    candidateCoverage: observed.candidates === null ? null : coverage(observed.candidates),
    missingConcepts, forbidden, negativeNoise,
    environmentCheck: Boolean(expected.environmentCheck),
    wrongEnvironment: Boolean(expected.environmentCheck) && forbidden.length > 0,
    success: positive ? coverage(observed.returned) === 1 && missingConcepts.length === 0 && forbidden.length === 0
      : !negativeNoise,
  };
}

export function summarize(rows) {
  const positives = rows.filter((row) => row.score.positive);
  const negatives = rows.filter((row) => !row.score.positive);
  const environment = rows.filter((row) => row.score.environmentCheck);
  const mean = (items, field) => items.length ? items.reduce((sum, row) => sum + row.score[field], 0) / items.length : null;
  const candidates = positives.filter((row) => row.score.candidateCoverage !== null);
  const times = rows.map((row) => row.wallMs).sort((left, right) => left - right);
  const quantile = (fraction) => times.length ? times[Math.ceil(times.length * fraction) - 1] : null;
  return {
    cases: rows.length, positives: positives.length, negatives: negatives.length,
    successes: rows.filter((row) => row.score.success).length,
    hit1: mean(positives, "hit1"), hit3: mean(positives, "hit3"), MRR: mean(positives, "reciprocalRank"),
    candidateCoverage: mean(candidates, "candidateCoverage"),
    negativeNoise: negatives.length ? negatives.filter((row) => row.score.negativeNoise).length / negatives.length : null,
    negativeReturnedItems: negatives.reduce((sum, row) => sum + row.returned.length, 0),
    wrongEnvironmentRate: environment.length ? environment.filter((row) => row.score.wrongEnvironment).length / environment.length : null,
    p50Ms: quantile(0.5), p95Ms: quantile(0.95),
  };
}
