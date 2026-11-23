# Real Host Capture Expansion Spike

This opt-in investigation runs a real isolated OpenCode host with the existing
wire provider and unchanged native binary. It never uses a real provider,
personal HOME, personal config, or personal memory database.

Run from the worktree root after building the unchanged native baseline:

```sh
cargo build --bin memocap
MEMOCAP_CAPTURE_PACKAGED_HOST=1 MEMOCAP_CAPTURE_EXPANSION_SPIKE=1 node --test tests/capture-expansion-spike.integration.test.cjs
MEMOCAP_CAPTURE_PACKAGED_HOST=0 MEMOCAP_CAPTURE_EXPANSION_SPIKE=1 node --test tests/capture-expansion-spike.integration.test.cjs
```

`1` selects the official npm platform binary at 1.19.3. `0` selects the existing
`/opt/homebrew/bin/opencode`, whose version must equal 1.19.5. The existing package
fixture installs its dependencies only in its private sandbox. Test helper module
resolution uses those isolated dependencies if root dependencies are absent.

Each host runs the unchanged 0.6.0 negative control before the scratch prototype.
The negative control must demonstrate full-history acquisition and the absence
of the additional support generation. Those assertion failures are recorded as
expected RED evidence, never as a production pass.

The scratch package replaces only its own worker acquisition and native guard
acquisition with an observed hook/event snapshot, and inserts a tools-disabled
support prompt in the extraction child. The existing generation budget, native
permission checks, write barrier, readback, and activity outcome are preserved.
`receipt.json` records exact replacement text and SHA-256 hashes. No production
file or existing harness file is modified.

The event cache retains only user messages seen by `chat.message` and assistant
messages with the current observed user as direct parent. Synthetic parts and
worker observations are excluded. Oversized tool content is dropped while its
actual host completion state is retained. All limits are explicit SPIKE profiles
in `observed.mjs`; they are not tuned product defaults. This spike does not prove
model quality, durable lifecycle behavior, or the final expanded evidence schema.
The runtime imports the cache from its copied scratch package; the tracked
`observed.mjs` is the reproducible prototype source asset.

Each mode completes fresh 32-turn and 128-turn sessions, with a large tool result
followed by a route document on the last turn. Capture SDK traffic is selected by
the actual capture module call stack, so ordinary parent context traffic is
excluded. The artifacts contain exact capture requests/responses and input
bytes. Raw telemetry remains under the ignored scratch run directory.

The generation scenario checks one parent HTTP request, three worker HTTP
requests, two fresh worker children, one real `ToolContext.ask`, one native write,
native readback, and the recorded `saved` activity. In the prototype, the fourth
worker generation must throw in `chat.params` before reaching provider HTTP. The
save must remain recorded even when the prompt rejects after the native write.

The prototype also probes malformed extraction, forged evidence source IDs,
misleading save/exit prose, real cancellation during the native handshake,
resume, and new-user invalidation of an old generation. Probes assert review
metadata and native spawn counts instead of natural-language prompt wording.

The four top-level evidence files live in `.omo/evidence/capture-expansion/`:
`acquisition-1193.json`, `acquisition-1195.json`, `generation-1193.json`, and
`generation-1195.json`. A failed assertion produces `blocked_or_failed` artifacts.
Only a completed non-skipped opt-in run can produce a scratch mechanism pass;
every artifact independently marks final production proof as `not_run`.

Cleanup closes the real host, fake provider, control server, and sandbox registry,
removes the private sandbox including its SQLite database and all child sessions,
and removes the scratch dependency symlink. Every run records its cleanup receipt.
