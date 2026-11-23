# Conditional Native Canary

This directory contains an executable native backend and offline contract tests.
It is disabled by default. No runtime authorization is stored here. Offline fake
results do not establish genuine model quality, native persistence or QA-7.

Run only these offline surfaces while preparing independent review:

```sh
node tests/capture-quality-native/driver.cjs
node tests/capture-quality-native/driver.cjs --prepare
node tests/capture-quality-native/driver.cjs --help
node --test tests/capture-quality-native/*.test.cjs tests/capture-quality-native.integration.test.cjs tests/capture-quality-boundary.test.cjs
```

The controller creates a new private HOME, XDG directories, project and carrier.
It spawns the exact approved host through the exact approved sandbox executable
and policy, using a literal environment. It sets project-discovery and default
plugin disabling flags before preload; their exact-host behavior requires the
independent source audit described below. The user profile must be model-only JSON:
one `openai-b1/gpt-6.1-sol` provider, with credential values supplied through native
absolute `{file:...}` references. The controller never follows those references.
It never derives a profile from an existing mixed user configuration.

This synthetic example passes the validator. The user selects the real base URL,
model metadata and native key reference; preparation never opens the referenced file.
Only the exact conventional `$schema` string is accepted as schema metadata.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai-b1/gpt-6.1-sol",
  "enabled_providers": ["openai-b1"],
  "provider": {
    "openai-b1": {
      "npm": "@ai-sdk/openai-compatible",
      "models": { "gpt-6.1-sol": {} },
      "options": {
        "baseURL": "https://provider.invalid/v1",
        "apiKey": "{file:/user-selected/native-key-reference}",
        "maxRetries": 0
      }
    }
  }
}
```

For that example, a permitted destination might be the exact
`https://provider.invalid/v1/chat/completions` path. This is an inert example,
not an approved endpoint. Inline keys, mixed plugin/MCP profiles, transport
overrides and credential substitutions in other metadata are rejected.
The explicit `models` entry registers this custom provider's model without catalog
discovery. `enabled_providers` is required to restrict discovery to `openai-b1`.
Allowed model metadata may describe the user's actual capabilities; the empty
example uses the source defaults and claims no verified context, cost or provider availability.

`model-profile.cjs` is the shared pure model projector used before helper credential
access and at profile validation. Its contract follows the declared model fields in
`packages/core/src/v1/config/provider.ts` at OpenCode commit
`810c0eba1a7348036f8bdf61e6632d0c36c6876c`: config `parse.ts` returns the decoded
value with `onExcessProperty: "ignore"`. During source preparation, unknown model
TOP-LEVEL fields are omitted without reading their values. Final profiles must
already match the projected model recursively: `validateProfile` rejects raw extras
without reading their values or mutating the caller's profile. Known object key
order does not matter. Its local
metadata projection does not rewrite raw profile bytes supplied to the host.
Known invalid fields fail. This rule is not applied
inside open options/variants: unsupported keys fail categorically. No defaults are
injected. Metadata strings are bounded, well-formed and exclude controls,
substitutions and credential markers. Descriptive metadata and full finite cost
(including `context_over_200k`) and limit structures are retained; required numeric
members follow the source schema, including zero. Null is supported only as an
effort-list entry, never treated as absence. The closed cost struct and its nested
`context_over_200k` explicitly project only declared input/output/cache_read/cache_write
members, omitting unknown source members without reading their values. Both levels
require finite input/output; present cache members must also be finite. Other nested
struct extras remain conservatively refused; open options/variants never use this rule.

The deliberately closed request-option subset is `reasoningEffort` (none, minimal,
low, medium, high, xhigh, max), `reasoningSummary` (auto, concise, detailed),
`textVerbosity` (low, medium, high), `include` (an array containing only
reasoning.encrypted_content), `parallelToolCalls` and `store` (booleans). Variants
accept those same options plus boolean `disabled`; false and empty records/arrays
are preserved. Reasoning controls support effort lists from that same effort set
plus null, toggle, and finite budget_tokens min/max. Interleaving accepts booleans
or reasoning/reasoning_content/reasoning_text, directly or in `{field: ...}`.
Other interleaving/effort strings, model provider overrides, nonempty model headers,
and arbitrary nested options are explicitly unsupported. Empty model headers are
retained. No transport, credential, file or environment option passthrough exists.
These validations do not establish provider support or model quality. Changes to
this projector participate in the runtime implementation fingerprint and invalidate
prior implementation approvals; no old grants or manifests are regenerated.

`fixture.mjs` exports the current `{id, server}` plugin shape. Its server calls
the production `memocap` factory, installs `provider.options.fetch`, guards global
fetch, and delegates the real host `ToolContext.ask`. The task plugin is the only
external plugin identity accepted. Before either spawn, the controller prepares
both install directories (`config/opencode` and `config`), prewrites `.gitignore`,
makes them `0500` and requires actual `W_OK` refusal. Its non-mutating recheck
checks owned identities, modes, exact contents and the literal HOME/XDG layout;
HOME discovery and project configuration must remain absent. Preparation runs
once, with rechecks before both starts.

The host then derives an explicit pre-load result from the pinned source commit
`810c0eba1a7348036f8bdf61e6632d0c36c6876c`, exact observed 1.19.5 executable
digest, implementation/profile digests, model-only validation, prepared roots,
disabled project/default discovery, exact local fixture identity and private auth
absence. It checks only existence of these four macOS managed paths before each spawn:

- `/Library/Application Support/opencode/opencode.json`
- `/Library/Application Support/opencode/opencode.jsonc`
- `/Library/Managed Preferences/liuyuyu/ai.opencode.managed.plist`
- `/Library/Managed Preferences/ai.opencode.managed.plist`

Any present path blocks; its contents are never read or removed. This predicate
supports only this macOS account and audited executable. There is no invented OS
disable flag. The observed binary digest does not cryptographically bind it to
the source commit; this remains an explicit evidence limitation.

Public `/config` must return exactly `plugin: []` for pure preflight and
`plugin: [<local fixture URL>]` for the task, with `mcp: {}` and empty native MCP
status. Optional `plugin_origins` absence remains unknown metadata (count `null`),
and can proceed only with the independently established pre-load result plus
those exact public observations. Present contradictory, additional, malformed
or mismatched origins block even when the pre-load checks passed. No raw config,
credential, origin URL or header value is recorded. A config hook is not used to
undo earlier plugin execution. The old unconditional missing-origins rejection
is now a no-independent-evidence negative, paired with a source-supported positive.

The native launcher proxy and task plugin share a persistent, exclusive batch
journal. The controller creates its consumed marker before any host spawn. The
journal remains after cleanup. Reusing its path is terminal. Retries, auth calls,
background calls and preparation share the 20 natural attempts; support has eight
additional slots, at most one provider dispatch per slot. The combined cap is 28.
All native memory write attempts, including setup, share three reservations.
Reviews retain two children, three generations, three outgoing review attempts,
one write and 30 seconds. The batch includes setup and is limited to 300 seconds.

The read task remains `Find the alpha entry.` The controller maps the original
fictional locator to `<private-root>/project/docs/route.md`, writes the exact
hash-verified tuning bytes, and lets the actual model choose native reads and
normal completion. Capture runs automatically. Joins require genuine selected
source identities, tool events, the actual ask, matching native operation and an
independent readback. Quality credit remains false pending adjudication.

Seven support slots have read-carrier delivery, including original consecutive
requests for the four continuation challenges. Prior context reviews are charged
preparation and cannot write. Short tasks run first. The first extraction still
uses a real native generation; `experimental.text.complete` visibly replaces
only its candidate text. It never manufactures an SDK finish. Production support
prompts are unchanged. All calls count, so the batch may exhaust its fixed budget
before every slot is reached. Such slots retain `seam_not_reached` and no credit.
The queued-command slot lacks an executable original command and remains blocked.

The maintenance fixture lacks an original native request and an executable
independent verification operation. Reading its historical check text is not an
API verification. Its adoption, seed and transaction scenario remain unexecuted.
Actual maintenance decision callbacks, host asks, native transport and receipt
observations are wired, but there is no direct `registry.consume` event hook or
natural maintenance scenario fabricated in this adapter. Canonical identity
comparison is also not independently observed; two support outcomes do not prove
the identity metric.

A future approval JSON must have `kind: "quality-native-runtime-v2"`,
`authorized: true`, a new opaque `batch` (8 to 96 letters, digits, `_` or `-`),
the current `implementation` digest printed by `--prepare`, `private_root`,
`attempt_file`, `credential_reference`, `existing_capability: true`,
`preload_source_audit: "approved_for_exact_host_hash"`,
`egress_policy_reviewed: true`, `preflight_loopback_only: true`, exact `provider_destinations` and
`auth_destinations` arrays, and `profile_sha256`. Each of `host`, `native`,
`sandbox`, `policy` and `preflight_policy` requires an absolute `path` and exact `sha256`; `host` also
requires `version: "1.19.5"`, and `native` requires `version: "0.7.0"`.
Installed SDK and plugin must both be `1.19.3`.
The source audit must establish exact-host discovery, provider dispatch and
preload behavior, including any dependency installation, and the existing policy
must restrict provider/auth egress to the reviewed destinations. This code does
not generate, widen or replace that policy. Pure preflight uses only the separately
reviewed loopback-only `preflight_policy`; non-pure uses the exact-destination `policy`.

After independent review and fresh precise runtime permission, the controller
accepts `--enable`, `--profile-ref`, `--credential-ref`,
`--consent quality-native-canary-v1:fresh-bounded-runtime`, repeated
`--provider-destination`, either `--auth-none` or repeated `--auth-destination`,
`--existing-capability`, `--approval-ref`, `--attempt-file` and `--private-root`.
All missing prerequisites refuse before spawn. Earlier opt-in flags and consumed
startup grants cannot enable this backend.

Cleanup aborts task children, disposes the product instance, signals only the
owned detached process group, waits for exit and verifies dispatched writes,
then restores only owned directory permissions and removes the private root.
Unknown exit retains private data and reports a blocker. It never deletes the
consumed journal or replays a write. Unknown native write results also retain the
private database and mark readback recovery required; no successful outcome is
inferred when its record identity is unavailable. Full tuning and sealed holdout denominators
remain unchanged.

Offline test seams supply an explicit synthetic preparation proof for memory IO;
they do not claim Unix access control. `preload-wiring.test.cjs` separately drives
the controller against actual owned temporary directories with fake host/model/
native adapters: both fake starts observe `W_OK` denial, known exit plus verified
write permits restore/removal, unknown exit/write retains data and read-only
modes, and restore failure is observable. No actual host, provider or SQLite runs.
