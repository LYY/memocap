# Capture Expansion QA-0 Dataset

These synthetic, deidentified fixtures freeze the approved v0.7.0 evaluation
intent before product changes. No record is copied from a user library. All
locators, jobs, records and grants are fictional; never resolve their URLs or
paths. No schema, provider, persistence or host adapter is introduced here.

`tuning.json` contains Quartz release tasks. `holdout.json` reserves Cedar
offline cache/recovery tasks. Both source-template and task-template sets are
disjoint, rather than paraphrases of a shared task. The common schema and metric
families are intentionally shared. `manifest.json` freezes exact UTF-8 file
hashes. Authoring and hash/count validation are allowed; executing or scoring
holdout is forbidden until the model ID/version, parameters, prompts, budgets,
scoring rules and acceptance thresholds have been frozen from tuning. No
holdout predictions or results exist. Do not add a holdout option to the baseline
runner or tune against its labels.

Gold is specified in each fixture independently of module output: claims,
conditions, support label and save/skip or maintenance decision. `old` records
the separately observed v0.6.0 mechanism, not the new acceptance target. For
runbooks a save label means a short route, never permission to copy the source.
Two claims on one source represent two possible reviews, not two candidates in
one extraction. The identity probe exposes the old full-source interface; it
does not test an invented claim-aware API or implement semantic dedup (#24).
Human-readable gold has been authored and self-checked, but independent label
review is still required before real quality acceptance.

## Replay

From the worktree root:

```sh
node tests/capture-evaluation/baseline.cjs .omo/evidence/capture-expansion/baseline.json
```

For later replay choose a fresh receipt such as `baseline-replay-01.json`.
Receipts and TAP logs use exclusive creation; never rewrite the original
baseline. The runner exports commit
`905a066aa4e67e9932e0f2af135aaa1cf170ad37` using `git archive`, verifies the
v0.6.0 tag, runs unchanged evidence/admission/identity/lifecycle tests there,
and imports only that archive's public module functions. It removes the
temporary archive in `finally`. Working-tree product changes cannot become
the old baseline. Dependencies are unnecessary for these pure module probes.

`turns` are explicit synthetic OpenCode message fixtures, not acquired host
observations. The runner invokes completion, evidence collection, secret
screening, selection, admission and identity separately. Its scripted proposals
exercise the public seam already used by the existing capture tests; they do
not predict model output. `collected_ids` may include a screened secret ID;
only `selected_ids` represent the post-screening provider input. Rejected text
is never emitted into the baseline artifact. Completion failure prevents
admission, matching the old worker. Other old rejections describe limitations,
not failures to satisfy future contracts. No candidate result claims saved
persistence. Maintenance fixtures remain `not_implemented` in this replay;
confirmed organization is not automatic post-use review.

## Metrics And Denominators

Freeze these definitions now; all semantic numerators remain unmeasured. Report
every metric per split and family, with raw counts, exclusions and sample size.
Zero denominators produce `not_applicable`, never 100%. Missing runs produce
`not_run` or `blocked`, never zero errors. Preserve per-case evidence and require
independent claim/condition adjudication; no model self-grading as gold.

| Metric | Numerator / denominator |
| --- | --- |
| Capture admission precision | Independently correct saved candidates / all actually saved candidates |
| Capture opportunity coverage | Gold-save task cases with all required reusable claims saved / gold-save task cases (one opportunity per case, including two-claim identity case) |
| Atomic claim coverage | Correctly saved gold claims / all gold claims in gold-save cases |
| Incorrect support | Saved unsupported or unknown claims / all actually saved claims |
| Condition retention | Preserved applicable gold conditions / applicable gold conditions in saved gold-positive cases; report omitted cases separately via coverage |
| False continuity | Different/unknown-task cases incorrectly using old evidence / all different/unknown continuity cases |
| False split | Same-task cases incorrectly losing needed prior evidence / all same-task continuity cases |
| Unknown | Unknown decisions / all reviewed cases, separate capture and maintenance |
| Exact duplicate error | Incorrect duplicate or missed exact duplicate decisions / explicit exact-identity decisions; semantic duplicates excluded |
| Maintenance false revision | Incorrect update/merge/delete decisions / all actual update/merge/delete decisions |
| Maintenance false delete | Incorrect delete decisions / all actual delete decisions |
| Missed maintenance | Gold-authorized update/merge/delete cases without correct verified outcome / all gold-authorized update/merge/delete cases |
| Maintenance condition loss | Lost still-valid unique facts/conditions / all still-valid unique facts/conditions in revised participating records |
| Latency and cost | p50/p95 per completed review; report review count, actual dispatch count, input/output tokens and total cost; unknown token/cost values stay null |

The capture and maintenance populations must never be pooled. Tuning currently
registers 16 capture tasks (8 save, 8 skip) and 12 maintenance tasks. Holdout
registers 4 capture tasks (2 save, 2 skip) and 4 maintenance tasks. Gold-authorized
maintenance opportunities are 2 tuning (one update, one delete), 1 holdout
(update). Unknown source-loss cases are a separate safety population: 4 tuning,
1 holdout. Same-task continuity: 1 tuning; different/unknown: 2 tuning and 1
holdout. No holdout model execution is needed to register these planned counts.
Merge correctness and transaction failure are safety scenarios, not semantic
dedup acceptance. Precision, claims, conditions, duplicate and maintenance rates
use actual eligible outputs as their runtime denominators, which are not yet
available; do not substitute the number of fixtures for those denominators.

| Family | Tuning capture | Holdout capture | Tuning maintenance | Holdout maintenance |
| --- | ---: | ---: | ---: | ---: |
| Source acquisition | 2 | 1 | 0 | 0 |
| Claim support | 4 | 1 | 0 | 0 |
| Failed then fixed | 2 | 0 | 0 | 0 |
| Runbook | 1 | 1 | 0 | 0 |
| Multi-turn | 3 | 1 | 0 | 0 |
| Exact identity | 1 | 0 | 0 | 0 |
| Source integrity | 1 | 0 | 0 | 0 |
| Secret | 1 | 0 | 0 | 0 |
| Unicode | 1 | 0 | 0 | 0 |
| Source disappearance | 0 | 0 | 4 | 1 |
| Post-use maintenance | 0 | 0 | 8 | 3 |

Deterministic gates are separate from semantic rates: count unauthorized access
or writes, stale writes, second writes, forged provenance reaching commit,
marked-secret units entering provider input/persistence, activity raw-evidence
leaks, recursive capture and leftover children. Future host runs require each
count zero and must report attempted-access/write/event denominators. The pure
baseline does not exercise these gates end to end. It records old contract
assertions, not a safety score for unexecuted host paths.

The measurement starting budget remains 2 children, 3 generations, 1 write
attempt, 30 seconds, 12 input units, 2 cited units, 800 quote code points and
1200 body code points. No TTL, frame count, byte cap, selection weights, tuning
profile or acceptance threshold is chosen here.

## Remaining QA-0 Evidence

The module receipt is a partial QA-0 deliverable. Native CLI binary version/hash
and isolated real-host baseline (OpenCode 1.19.3 and 1.19.5, actual binary hashes,
all cases and cleanup) remain required. They must use the same immutable base;
existing historical JSON is not a new run. Host acquisition, cancellation,
authorization, persistence/readback, capacity eviction, maintenance transaction
and recovery need their existing host/core seams in later lanes. Invalid
Unicode/span/hash, prompt injection, late verification after 12 units, long
tail/bundle budgeting and global eviction need additional behavioral fixtures
at their frozen contracts; these small families do not claim exhaustive QA-3
through QA-10 coverage. The proposed quality integration entry outside this
directory remains for the parent to authorize/implement; no real provider is
configured and no quality or holdout pass is claimed.

In the module receipt `cleanup.children_started` counts capture worker children,
not the Node test runner's subprocesses. No capture workers or servers are
started. OS test subprocesses exit before the receipt is written.
