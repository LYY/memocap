# Offline population operationalization

Run from the feature worktree root with Node only:

```sh
node --test tests/capture-quality-population/dispatcher.test.cjs
node tests/capture-quality-population/driver.cjs
```

`node tests/capture-quality-population/evidence.cjs` runs only the new offline
suite and module driver, then creates the ignored operationalization report.
It refuses to overwrite an existing report. Earlier observed RED outcomes are
recorded as historical command observations; the script freshly executes GREEN.

`mapping.json` exhaustively binds the 16 capture and 12 maintenance cases to
hash-verified frozen tuning pointers. It defines transport execution, not exact
historical host behavior. All paths, commands and URLs are inert fixture data.
The driver imports only local test modules and Node builtins. It neither runs
existing harnesses nor opens network, host, native, provider or database access.

`createDispatcher(id).model` exposes only `input()` and `execute(name, args)`.
The case ID selects test setup outside model input. Only original user and
assistant conversation, primary snapshots, comparison snapshots and operation
results can cross this facade. Gold, proposed candidate bodies, identity claims,
expected readback bodies and case labels stay in evaluator/test metadata.
Operations are explicitly whitelisted per mapping. Results discriminate
`response` (local fake transport), `blocked` (coded failure), and `control`
(test-control event). A blocked result contains no factual verification output.

The outer `control(event)` and `audit()` APIs are test-only. Never expose control,
the sidecar's execution script, the raw fixture, or the driver report to a model.
q1/q2 submission queues a job; only explicit outer control completes it; a
subsequent independent status operation can then emit the frozen GET output.
Replaying a submission is rejected. The failed route requires an observed error,
a marker installation and a separate verifier before its read is available.
Failed-only and queued-only have no additional repair/completion routes.

Two-approval source revisions require actual local probes: one rejected and two
accepted. Repeating either probe never substitutes for the other. Retirement
checks the alias inventory, exact sole approved replacement and comparison of
normalized fact sets before releasing frozen independent-check text. These
finite semantic inventories are declared test interpretations, not NLP proof:
the obsolete current-route fact is superseded; alpha/entry are covered by the
replacement; approval remains on the replacement; no historical facts exist in
the base fixture. Test controls add an alias, wrong/unapproved/multiple replacement,
or a unique historical fact to demonstrate rejection. Changing inventory
invalidates previous check results. No real mutation permission is implied.

Maintenance has no original user request. Its neutral request is explicitly
**adapter-added operationalization**, not original text. Primary `fixture_used`
is the frozen flag, never a native adoption receipt. Recalled-unused never queues
a review; comparison participants never acquire uses. Unavailability remains a
local missing/404/timeout/denied outcome and cannot establish invalidity. Denial
ends all operations and controls; there is no alternate route.

Snapshot-conflict simulates only version comparison after a separately declared
concurrent event; lost-response exposes an unknown/matches/differs/unavailable
readback outcome with zero additional writes. Neither supplies new semantic
evidence. No write operation exists. Controlled recovery outcomes are labels,
not actual observed database bodies; the original expected body remains sealed
from the model facade. A future host adapter must supply genuine receipts.

Partial-read preserves the original framed output exactly. Its carrier maps
opaque unobserved lines 1-9 and observed offset 10; it never claims to know the
original full file. Requests asserting full disclosure or a different offset
are rejected. The complete synthetic secret-shaped user unit is retained as
original data; this module sends nothing to a provider and does not claim the
future secret screening boundary was exercised. Runbook text is read only.

The identity fixture remains one natural opportunity with two claims. Separate
controlled key probes are a different stratum and remain unrun here. Identical
replay and a second natural request are absent and blocked. Missing full partial
content, snapshot semantic verification, lost-response fresh semantic evidence,
and native adoption/host/model results remain blocked or unrun with original
denominators retained. The driver asserts byte equality and operational state;
it does not score model quality or implement plan task #24.

The historical contract's package-lock hash already differs from this worktree's
observed bytes. The sidecar pins the observed task baseline separately; the
driver retains both hashes and reports `contract_match: false`. It rejects
subsequent drift rather than treating this mismatch as a historical hash pass.
