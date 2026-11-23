# Offline QA7 Collector

Public CommonJS API: `const { collect } = require('./tests/capture-quality-acceptance/index.cjs')`.
Call `collect(nativeResult, annotations)`; `collect(null)` reports `not_run` with null metric values.
An explicit finite selection uses `collect(nativeResult, annotations, evaluation)`, where `evaluation`
is the descriptor returned by the existing native population `createEvaluation` factory, or its compiled
population. The collector recompiles its descriptor with that same compiler, discarding supplied closures.
The result must carry the exact `id`, `input_sha256`, `mapping_sha256` and `evaluation_sha256` identity.
Missing selection or a different identity refuses the join. Definitions, case rules, groups and eligibility
denominators come from the selected input; unscored eligibility stays null/blocked, including before a run.
The default remains the original tuning cohort. Imports load its tuning/mapping JSON and local
`scoring.json`; explicit selections additionally use the existing finite compiler and producer modules.
Neither path starts processes, opens databases, loads holdout, or changes the input arguments.
`scoring.json` contains only the exact machine-consumed metric definitions.
Run the finite synthetic public driver with `node tests/capture-quality-acceptance/driver.cjs`.
These examples and tests demonstrate collector behavior, never measured semantic quality.

Inventory comes from the original 28 planned cases, every turn/review/event, native attempts,
commit/write/output records and orphan native tool receipts. Setup seeds have a separate inventory.
Wrong, negative-case and earlier-turn saves remain eligible for precision. Coverage only credits
original positive target-turn claims; two identity claims remain one opportunity. Conditions use
original `gold.conditions`, or the qualified original positive claims when no separate list exists.
The condition denominator is the unique applicable gold conditions in saved positive cases;
a dropped qualifier stays in it. Original gold and counts (16/12, 8/9/2) are never rewritten.

Annotations are independent input, separate from extractor/support decisions. Obtain inventory
keys by first calling `collect(result)`, then pass arrays keyed exactly to those rows. Only keys
under `inventory.reviews` with `semantic: true` require semantic-review annotations. Provenance
must be declared in `adjudicators: [{id, role:'independent', provenance}]`. Each judgment has
`key`, `adjudicator`, nonempty `rationale`, and `resolution:'agreed'`. Disagreement/unknown,
missing, duplicate and foreign keys block affected numerators; known denominators remain.
Code checks attribution and linkage, not adjudicator independence or natural-language truth.
Malformed envelopes, arrays, claims and fact records produce structured blocked/null metrics.
Rejected boundary values and each row's original `annotation` remain inspectable; inventory is preserved.

For each `preserved:false` condition, an independent output annotation may additionally supply
`admission_omission:{status:'bounded_partial'|'invalidating'|'unknown',rationale:<nonempty string>}`.
`bounded_partial` labels only an explicitly unasserted remainder of the compound gold. It must
not remove authorization, environment, exclusions, or preconditions necessary to the actual
saved claim. This is an independent human judgment, not machine proof of a safe omission.
The collector validates structure and existing attribution/provenance; it cannot establish that
the semantic label is honest. No text heuristic supplies this label.

Only admission uses the validated `bounded_partial` exception. Missing omission fields grant
no exception; `invalidating` still rejects. Explicit `unknown` or malformed omission judgments
block admission with the known saved-output denominator retained. Preserved conditions need no
exception. Context, durability, complete fact inventory, support, and applicable case rules
remain required. Coverage still requires every original condition in one record, and retention
still counts every gold condition, including false omissions. Two bounded partials may therefore
score admission 2/2 while compound/atomic coverage stays 0/1 and retention stays 3/5. This grants
no quality acceptance or retrospective upgrade to old annotations. The synthetic public fixture
in `admission-partials-fixture.cjs` exercises this distinction without private evidence.

| Array | Required judgment fields |
| --- | --- |
| `outputs` | `segmentation_complete:true`; nonempty `claims:[{id,text,support,gold_claim,rationale}]`; `context:'valid'/'invalid'/'unknown'`; `durability:'durable'/'ephemeral'/'unknown'`; `conditions:[{id,preserved:boolean,rationale}]` exactly covering the row's `required_conditions` |
| `decisions` | `correct:boolean`, per-issued-decision rationale and provenance |
| `proposals` | `correct:boolean` for every raw proposal, including malformed or unsupported raw text |
| `reviews` | `unknown:boolean`; target-turn continuity cases also require `false_continuity:boolean` or `false_split:boolean` |
| `mutations` | `participants:[{id,placement,pre_content_hash,post_content_hash,inventory_complete:true,facts:[{id,text,still_valid:boolean,preserved:boolean,rationale}]}]` for every actually mutated pre-participant, including erroneous deletions/revisions |

`support` is `supported`, `unsupported`, or `unknown`. A `gold_claim` is a zero-based index in
that case's original gold claims, or null for extras. Each claim is independently segmented and
compared with actual saved content/sources, not inferred from the case's save/skip label.
An independently resolved `support:'unknown'` counts as incorrect support; unresolved adjudicator
disagreement blocks that numerator. Context/durability unknown blocks precision and coverage.
For mutations, hash exact pre/post snapshot `content` with SHA-256; deletion has null post hash.
Inventory completeness is an adjudicator assertion, and all still-valid unique facts/conditions
remain in the loss denominator even when the mutation itself was wrong.

Native persistence requires exactly one dispatch, commit and independent readback per attempt,
matching review/root/user/workflow, resolved permission and consumption, distinct operation IDs,
successful native receipt and exact full readback identity/content/tags. Maintenance additionally
requires every actual request participant to appear exactly once in the post snapshots/deletions,
with a matching independent survivor/null readback, plus every request dependency.
Capture and maintenance require `memocap_remember` and `memocap_maintain` respectively. Every
claimed tool receipt must bind to the commit's actual operation and records. Capture readbacks
do not require session/message fields that the native projection does not provide.
Every output is joined independently to the unique commit and readback. Identical cross-view
saved/commit/write/tool mirrors count one save with all source indices; repetitions within one
source remain separate inspectable rows and block affected metrics. Foreign and contradictory
outputs remain visible. Unknown or
unjoined writes block a saved denominator instead of becoming zero/N/A. A valid no-candidate,
rejected or denied no-write terminal needs no successful-write stages from the ledger.
Issued decisions are deduplicated by opaque proposal ID with task/fingerprint/support linkage;
later denial/conflict does not remove them. Raw proposal rows remain separately inspectable.
Maintenance task identity is exactly `parentID/taskID/epoch`; the current user is the
separate observation `user_id`, bound to the event user and `review_id` fingerprint.
The task may begin on an earlier turn, so `taskID` need not equal the current user.
Issued and validated used snapshots must agree, including every dependency's task.
Observed raw/validated/support binding fields must agree with issuance. Request groups
compare exact fields without treating JSON property order as an operation difference.
The maintenance test constructors now use this production task shape in place of their
invalid synthetic `task.userID` inputs; existing assertions retain their original intent.
Full-snapshot tests exercise update/delete joins and structural merge linkage while
keeping the original two authorized maintenance opportunities.

`metrics` preserves the frozen formulas without thresholds or weighted scores. Every rate exposes
status, numerator, denominator, value, adjudicated partial numerator and exact missingness.
N/A (`not_applicable`) requires a completely observed empty eligible population. Family/lane/stratum
groups retain case/review/output/issued IDs, counts, missingness and unknown rates. Safety/recovery
strata remain named separately; no acceptance gate is selected. `freeze` carries the existing
metric definitions, tuning hash and annotation hash/provenance; no holdout or profile selection.

Latency estimator is declared before future measurements: nearest-rank on sorted completed-review
durations, index `ceil(p*n)-1`, p50=0.50 and p95=0.95; an empty sample has null quantiles.
New `review.started`/`review.finished` observations use one process's `node.performance` clock domain,
with exact parent/user/workflow identity. Capture entry precedes the maintenance coordinator wait;
its existing 30-second execution timer still starts after that wait, and its terminal clock follows
`recordReview`. Maintenance entry precedes origin/read/admission and its terminal clock follows child
abort/delete cleanup. Review attempts and pre-model observations are reported separately from semantic
samples. Missing, repeated, reversed, mismatched or unknown terminal evidence blocks quantiles.
Child response latency, first-child time and placeholder `elapsed_ms:0` are never substituted.

Actual HTTPS invocation emits `provider.dispatch`, including synchronous transport failures, followed
by `provider.finished` on response completion or failure. Admission blocked before invocation emits no
HTTP dispatch. Failure counts require complete unique transport terminals; absent, repeated or unknown
terminals yield null. Observed transport failures and HTTP responses outside 2xx count as failed dispatches.
Only the same dispatch's fully consumed, validated Responses SSE terminal supplies corrected usage.
The observer uses one demand-driven reader, preserves forwarded bytes, and enforces the existing
262,144-byte bound before forwarding. It emits the finish after that reader consumes EOF, rather
than the earlier IncomingMessage END notification. A terminal prefix, cancellation, overflow,
malformed/conflicting/duplicate terminal, incomplete or failed response cannot establish success.
Validated incomplete/failed Responses terminals also count as failed attempts. Unsupported dialects
remain unknown; a configured compatibility server is not presumed to emit Responses envelopes.
SDK child/parent replies, completion observations and private links remain independent metadata;
they cannot supply or substitute actual dispatch usage. Parent transport
clocks and plugin review clocks are separate domains and are never subtracted across processes.
The five fields remain nested under `usage.tokens.{input,output,reasoning,cache_read,cache_write}`.
Each screened terminal usage field has `token_states` equal to `observed` or `absent`; null or
missing optional provider details are absent, while explicit numeric zero is observed. Input/output
are required in completed/incomplete envelopes; failed envelopes may omit usage. Corrected totals
expose per-field `token_states` of `observed` or `unknown`. A valid completed stream with known
input/output and absent detail categories has corrected status `partial`, with those details null.
Missing or invalid stream/provenance evidence has status `blocked`, never `complete`.
`accounting.corrected_run` describes only the supplied observed dispatch scope; it never reconstructs
historical requests. Categories are not assumed disjoint, so `billing_total` is null. Unknown provider
prices, full cost and cumulative financial totals remain null even with completely paired tokens.
Legacy response-only evidence keeps its partial child totals and reported cost, with dispatches and
review quantiles blocked. Native dispatch events are counted separately. Clocks and counters establish
metering, not semantic truth; no raw request, credentials or provider response body is retained by metering.
Current identity traces lack explicit comparison decisions; exact-identity error stays blocked,
with original identical replay explicitly unexercised. A combined summary cannot prove replay.

`actual_quality` remains `not_run` for absent/synthetic input, with null acceptance. Even genuine
input receives no automatic acceptance claim: missing trace/adjudication and unselected gates
remain visible. No measurement, semantic QA7 pass, release acceptance or native run is implied.
