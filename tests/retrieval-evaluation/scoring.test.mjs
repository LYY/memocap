import assert from "node:assert/strict";
import test from "node:test";
import { scoreCase, summarize } from "./scoring.mjs";

test("ranking counts a third-position answer independently from complete concept coverage", () => {
  const expected = {expectedIDs:["answer"], concepts:["constraint"]};
  const observed = {returned:["noise", "other", "answer"], candidates:["answer"], complete:[]};
  const score = scoreCase(expected, observed, [{id:"answer", concepts:["constraint"]}]);
  assert.deepEqual([score.hit1, score.hit3, score.reciprocalRank, score.success], [0, 1, 1 / 3, false]);
});

test("negative noise is counted only on no-answer cases", () => {
  const expected = {expectedIDs:[], concepts:[], expectedNoAnswer:true};
  const score = scoreCase(expected, {returned:["noise"], candidates:[], complete:[]}, []);
  assert.deepEqual([score.negativeNoise, score.success, score.hit1], [true, false, null]);
});

test("alternative duplicates form one answer unit", () => {
  const expected = {expectedIDs:["copy1", "copy2"], idRule:"any", concepts:["route"]};
  const score = scoreCase(expected, {returned:["copy2"], candidates:["copy2"], complete:["copy2"]},
    [{id:"copy2", concepts:["route"]}]);
  assert.deepEqual([score.idCoverage, score.candidateCoverage, score.success], [1, 1, true]);
});

test("a relevant hit still fails when an inapplicable environment is exposed", () => {
  const expected = {expectedIDs:["beta"], concepts:[], forbiddenIDs:["alpha"], environmentCheck:true};
  const score = scoreCase(expected, {returned:["beta", "alpha"], candidates:null, complete:["beta"]}, []);
  assert.deepEqual([score.hit1, score.wrongEnvironment, score.success, score.candidateCoverage], [1, true, false, null]);
});

test("summary keeps negative cases out of rank denominators and uses nearest-rank latency", () => {
  const positive = {positive:true, success:true, hit1:1, hit3:1, reciprocalRank:1, candidateCoverage:1};
  const negative = {positive:false, success:false, negativeNoise:true};
  const summary = summarize([{score:positive, returned:["answer"], wallMs:2},
    {score:negative, returned:["noise", "other"], wallMs:10}]);
  assert.deepEqual([summary.hit1, summary.MRR, summary.negativeNoise, summary.negativeReturnedItems,
    summary.p50Ms, summary.p95Ms], [1, 1, 1, 2, 2, 10]);
});
