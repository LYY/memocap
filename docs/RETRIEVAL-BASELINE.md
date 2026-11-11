# Synthetic Retrieval Baseline: Current 0.5.0

Measured 2026-11-11 on darwin/arm64, Node v26.13.0, using this worktree's existing `target/debug/memocap` (receipt package version `0.5.0`). Source baseline is `33e3f3f4c58d86a70a571e58eafaf3b763b942b9`; the binary SHA-256 is `ab8979b6da12cfd9eac58fc9c2238b0b900d52583a6ee8df20e65f6a7958fa34`. The measured plugin protocol SHA-256 is `61608abd7fd22c9e18ad430dc659ad19e4969d1426181c26751db0491a77a1f2`. These are debug-build measurements, not release performance claims.

The frozen corpus has 22 synthetic records: 10 repository A, 6 repository B, 1 attached domain, 5 universal. There are 24 retrieval queries (12 tuning, 12 holdout), with disjoint family names. There are separately 8 capture admission examples (2 admit, 6 skip); capture was not executed. All service names, paths, IDs and mock destinations are invented. Neither real user data nor Datadog, Metabase, production DBs or deployment endpoints were accessed.

The runner imports the selected plugin protocol's real `queryTerms` and `referenceBlock`, resolves synthetic targets through the CLI, seeds records using actual `remember`, independently reads each placement back using `list`, then executes actual JSON `recall` receipts. These preserved runs selected the original 0.5.0 implementation. Scope is the selected repository, attached domain and universal stack. It does not pretend that 0.5.0 implements authorized whole-library discovery. The fixed budget is `--match any --limit 3 --max-chars 6000`, followed by the selected plugin's 6000-character reference rendering. The preserved baseline therefore includes the old scope ordering and silent content truncation failures.

## Reproduce

From the worktree root, explicitly select an immutable 0.5.0 binary and protocol from the baseline revision. The paths below identify that separately preserved checkout or archive; rebuilding the current product does not preserve the baseline binary automatically.

```sh
node --test tests/retrieval-evaluation/scoring.test.mjs
node scripts/evaluate-retrieval.mjs --binary /path/to/immutable-0.5.0/memocap-native --protocol /path/to/immutable-0.5.0/plugin/protocol.js --split tuning --output /tmp/recall-tuning-new.json
node scripts/evaluate-retrieval.mjs --binary /path/to/immutable-0.5.0/memocap-native --protocol /path/to/immutable-0.5.0/plugin/protocol.js --split holdout --output /tmp/recall-holdout-new.json
```

Output paths must be new: `--output` uses exclusive creation and never overwrites an existing report. Omit `--output` to emit the full report to stdout; a compact split summary goes to stderr. The runner defaults to tuning, never implicitly opens holdout. `--split all` is available for a fixed, already-selected configuration. It verifies the seven frozen input hashes on every invocation (including holdout integrity hashes during tuning, without loading holdout queries or expectations for scoring).

Every run creates a unique temporary root, a new SQLite DB, A/B directories and isolated HOME, MEMOCAP_HOME, MEMOCAP_DATA_DIR and XDG paths. It drops inherited MEMOCAP and Git variables, uses a sandbox working directory and asserts local CLI receipts. Cleanup removes that temporary root in `finally`. Seed duplicate suppression is deliberately bypassed with existing `--force` so the duplicate reference case is measurable. Reports contain only synthetic logical IDs, normalized `<sandbox>` argv and measurements; no SQLite file is preserved.

Runner-only options are `--binary PATH`, `--protocol PATH`, `--split tuning|holdout|all`, `--query-mode plugin|raw`, `--recall-args JSON_ARRAY`, `--output PATH` and `--help`. For example, `--recall-args '["--type","context"]'` passes an existing CLI filter through; the report records it. Budget, match, receipt and target overrides are reserved. The per-case universal selector remains fixed. Future parent-approved retrieval/authority CLI options can be passed through `--recall-args` once they actually exist; this evaluator introduces no product flags. `--query-mode raw` passes the full fixture query to the CLI as a separately labeled diagnostic experiment. A run with changed query mode, protocol hash, binary or extra argv is a new experiment, not a reproduction of these exact baseline settings. The report records the selected protocol path and hash, the direct or reexported query source path and hash, and the executed query function hash. Rebuild/use the intended revision explicitly; the runner does not build or change the product.

After query extraction changed in the development worktree, an independent replay with the immutable 0.5.0 binary and protocol reproduced all 12 tuning cases' query terms, candidates, returned IDs, complete references, scores and rendered lengths. Binary and protocol hashes matched the preserved report. Eight evaluator tests passed, including a selected reexported query implementation exercised through the real old CLI. The original frozen inputs and two saved baseline reports were not rewritten. `sourceResolution.status: not_run` explicitly records that this runner has not yet exercised a partial-reference full-read workflow; it does not change the original scoring rule.

Verification performed: all five focused counting tests passed; the script passed `node --check`; help, invalid-split rejection and a tuning run with configurable `--type context` were exercised in a terminal. That fresh configurable tuning run reproduced every baseline returned-ID list and score. Frozen hashes, split family separation, capture evidence links and both saved reports were independently read back. Diagnostics reported no errors on the new runner, scorer, counting tests, JSON fixtures/reports and documentation. No product rebuild or broad product test suite was needed for these evaluation-only additions.

## Frozen Rules and Evidence

[ACCEPTANCE.md](../tests/retrieval-evaluation/ACCEPTANCE.md) defines denominators, case success, resource/noise tradeoffs and adoption rules; [freeze.json](../tests/retrieval-evaluation/freeze.json) pins its contents plus corpus, queries, separate expected files and capture labels. They were written before the first holdout run and were not modified after it. No model, tokenizer, weights, candidate multiplier or other tuning parameter was selected. This is an openly readable regression holdout, not an unseen statistical sample.

Positive hit@1/hit@3/MRR concern expected IDs; strict success additionally requires expected concepts to remain in complete injected references and forbidden IDs to be absent. Concept annotation coverage is a conservative check on full synthetic source records, not a model-based semantic evaluator. No-answer cases require zero results. The current receipt's `matched_ids` exposes visible pre-budget candidate coverage only; scope exclusions, topic shadowing and raw lexical candidates are not separately observable. `partial` in these reports is an evaluator observation from comparing injected content to the original fixture, not a field implemented in the current product.

Raw measured reports include exact query terms, normalized argv, returned/matched/injected/partial IDs, missing concepts, selectors, per-case success and latency, summaries by split/family and expected origin:

- [Current tuning report](../tests/retrieval-evaluation/current-0.5.0-tuning.json)
- [Current holdout report](../tests/retrieval-evaluation/current-0.5.0-holdout.json)

| Split | Positive / negative | Strict success | hit@1 | hit@3 | MRR | Visible candidate coverage | No-answer noise | p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tuning | 10 / 2 | 9 / 12 | 8 / 10 | 8 / 10 | 0.800 | 8 / 10 | 1 / 2; 3 items | 25.49 / 28.33 |
| Holdout | 11 / 1 | 5 / 12 | 7 / 11 | 7 / 11 | 0.636 | 9 / 11 | 1 / 1; 3 items | 25.29 / 27.05 |

All positive hits happened at rank 1 in these particular runs, so hit@1, hit@3 and MRR coincide. The counting test separately exercises rank 3. Holdout has wrong-environment exposure in 1 of 2 designated checks (50%); explicit universal filtering leaks 0 IDs. These are reference exposures, not proof of an agent executing the wrong workflow. Both oversized reference cases lose full content: ASCII reference 5999 UTF-16 chars, Unicode/escaped reference 5611. Their IDs rank first but strict success fails because the tail constraint is no longer guaranteed. The product does not label these partial references.

Nearest-rank latency includes process startup, local retrieval and activity receipt work, one sequential sample per case; it excludes seeding, target resolution and rendering. It is descriptive and sensitive to machine load. Both fresh runs used 172032 DB bytes after seed and 180224 after queries. These totals include data, indexes and activity, not a standalone index size. Index-only footprint, peak RSS, model footprint and capture-worker cost are unavailable; no semantic model was run.

## Family Results

`Success` uses the strict rule above. A dash means the metric has no positive denominator. All single-case families are small probes, not estimated population rates.

| Split / family | Cases | Success | hit@1 = hit@3 = MRR | Candidate coverage |
| --- | --- | --- | --- | --- |
| tuning / incident-routing | 2 | 2 | 1.000 | 1.000 |
| tuning / verified-service-routing | 2 | 1 | 0.500 | 0.500 |
| tuning / chinese-paraphrase | 2 | 1 | 0.500 | 0.500 |
| tuning / late-entity | 2 | 2 | 1.000 | 1.000 |
| tuning / exact-error | 1 | 1 | 1.000 | 1.000 |
| tuning / unknown-service | 1 | 0 | - | - |
| tuning / domain-origin | 1 | 1 | 1.000 | 1.000 |
| tuning / distant-negative | 1 | 1 | - | - |
| holdout / exact-path | 1 | 1 | 1.000 | 1.000 |
| holdout / exact-version | 1 | 1 | 1.000 | 1.000 |
| holdout / environment-conflict | 1 | 0 | 0.000 | 1.000 |
| holdout / topic-conflict | 1 | 0 | 0.000 | 0.000 |
| holdout / close-negative | 1 | 0 | - | - |
| holdout / scope-first-ranking | 1 | 0 | 0.000 | 1.000 |
| holdout / cross-origin-convention | 1 | 0 | 0.000 | 0.000 |
| holdout / explicit-origin-filter | 1 | 1 | 1.000 | 1.000 |
| holdout / invalidated-route | 1 | 1 | 1.000 | 1.000 |
| holdout / duplicate-reference | 1 | 1 | 1.000 | 1.000 |
| holdout / tail-integrity | 1 | 0 | 1.000 | 1.000 |
| holdout / unicode-integrity | 1 | 0 | 1.000 | 1.000 |

Expected-origin breakdown (duplicate answer alternatives can belong to two origins, so those groups overlap): tuning A 6/7 successes, B 1/2, domain 1/1, no-answer 1/2; holdout A 1/1, B 2/5, universal 3/6, no-answer 0/1. Placement distribution is preserved; records are not moved into universal to make cross-origin cases pass.

## Per-Case Outcomes and Limits

- `t-issue`, `t-issue-en`: find the synthetic Datadog + Metabase entry from Chinese/mixed and English issue requests without those tool names in the prompt. They establish routing retrieval only, not tool authorization or a successful incident investigation.
- `t-alpha-cross`: misses Aster's verified alpha repository entry from context A; `t-alpha-local` finds it from B. Neither prompt supplies a tool name or repo path. Wrong service references also appear in the cross-origin miss.
- `t-db-cn`: Chinese paraphrase misses; `t-db-control`: exact Chinese source matches. This directly exposes the current lexical gap.
- `t-late`: `Deployment` occurs after 12 words and is absent from recorded query terms. The target still ranks first through incidental common-word overlap (`synthetic` and related context). This frozen case demonstrates anchor loss but does not isolate its effect on rank; its passing hit must not be interpreted as robust long-query support. `t-deployment-control` finds the exact early anchor. Keep this limitation visible instead of rewriting the frozen case after observing results.
- `t-error`, `h-path`, `h-version`: expected records rank first. Current plugin tokenization splits path/version punctuation, so these outcomes do not prove a normalized anchor remains an exact phrase internally.
- `t-unknown-service`, `h-close-negative`: each incorrectly returns 3 unrelated or inapplicable references. `t-noanswer` is correctly empty. A higher average hit rate cannot conceal this noise.
- `t-shared`: finds the attached-domain snapshot verification reference.
- `h-beta`: the expected universal beta candidate is visible pre-budget, but alpha/local release references occupy the three result slots. `h-origin-filter` retrieves the beta reference through the explicit universal selector with no alpha leakage.
- `h-topic`: same-topic local content hides an independent universal beta fact. Their shared topic is not evidence of replacement under the approved new design; this intentionally measures the old behavior's failure.
- `h-ranking`: the precise universal attestation candidate is visible before budgeting but displaced by three repository UI release notes.
- `h-cross-fact`: a B-origin Zephyr convention is invisible from A even with its service name in a mixed-language query.
- `h-stale`: finds the invalidated Kestrel route with its no-replacement/verification warning intact. This is a navigation warning, not a valid deployment entry.
- `h-duplicate`: retrieves both equivalent Cedar records; either is accepted as one answer unit. This pass does not imply deduplication is implemented.
- `h-tail`, `h-unicode`: first-place IDs are silently truncated by reference rendering; both fail complete concept preservation. No full-read workflow or capture metric is fabricated.

[Capture labels](../tests/retrieval-evaluation/capture.json) include concise routing despite existing docs, verified service/environment mapping, full-runbook copying, transient output, a secret placeholder, unsupported assistant inference, duplicates and insufficient business evidence. Each label references synthetic evidence. The improvement plan intentionally relaxes the existing policy's docs-exist exclusion for useful navigation; these labels describe the approved target behavior. They cannot measure real-user capture rate, admission precision, coverage, readback success or duplicate rate until an actual worker is tested. No Respire quality comparison follows from these synthetic results.

The frozen acceptance calculation lists paired fixes/regressions, keeps exact-anchor successes, and treats newly introduced negative noise or lost positives as explicit tradeoffs. Safety checks require zero inappropriate environment exposure, selector leakage and partial-as-complete usage. Resource acceptance remains undecided until corrected lexical/tuning measurements support actual device-specific ceilings. This baseline fails several target gates and makes no claim of an implemented improvement.
