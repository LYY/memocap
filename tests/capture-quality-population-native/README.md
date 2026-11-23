# Bounded Population Native Transport

The concrete opt-in entry is `runtime.cjs:runNative(input, newGrant)`, also exported
by `driver.cjs`. It iterates the original 28 tuning cases through `adapter.cjs`
and `concrete-host.cjs`. Genuine OpenCode, model, native and database execution
is **NOT_RUN**. Nothing here grants permission to run it.

The offline commands are:

```sh
node --experimental-vm-modules --test tests/capture-quality-population-native/*.test.cjs
node tests/capture-quality-population-native/verify-offline.cjs
node tests/capture-quality-population-native/driver.cjs
```

The public offline driver exercises all 28 frozen cases and 23 adversarial groups
using explicitly synthetic host events. `wired` is transport wiring only. Every
absent decision stage remains `blocked_missing_observation`; it is not model
quality, permission, persistence, host compatibility or QA-7 acceptance. The tests
also import the installed SDK with injected fetch, execute the REAL production
factory in a VM with an inert bridge, use in-memory HTTP streams for the concrete
control protocol, and exercise owned carriers and an inert Node subprocess.
They do not start OpenCode, a listener, a native binary, a provider or SQLite.

## Concrete Composition

`authorization.cjs` admits a NEW exact user grant before runtime input inspection,
private filesystem creation, listening or spawning. The grant binds the source
digest, frozen tuning/inventory digests, canonical model profile, exact HTTPS
endpoints, explicit loopback address, 28 private case roots, one-use attempt path,
and the host, native and Node artifacts plus an explicit matching `isolation`
descriptor: `{ kind: 'ordinary-host-v1', permissions: 'ordinary-os-account',
os_file_network_restrictions: false }`. Missing, mismatched and old sandbox-only
grants are refused. Ordinary OS permissions do not restrict OS file or network
access. Private HOME/XDG/DB, controlled plugin/native asks and fixed provider
transport remain application controls, not an OS sandbox. The consumed
canary ID is rejected. Environment flags cannot become permission. The current
concrete source audit covers OpenCode 1.19.5; the broader production observer
still supports 1.19.3 and 1.19.5. A future invocation must supply the explicit
native 0.7.0 artifact; the installed older binary is not substituted.

`concrete-host.cjs` owns the private configuration and ordinary host lifecycle.
It reuses the unchanged `capture-quality-native/preload-preparation.cjs` owned
preload checks, locks the empty config directories, and installs
`plugin-entry.mjs` as an actual `{ id, server }` OpenCode plugin. Plugin options
contain private transport identity and paths. They are not model prompt data.
`process.cjs` directly spawns the pinned host with `serve` arguments, a literal
environment, private cwd, `shell: false` and its own process group. It observes
startup and confirmed process-group exit. Confirmed exit
permits cleanup; unknown exit, setup write or native write preserves recovery.

Inside OpenCode, `plugin-runtime.cjs` installs `createFixture` and the REAL
`production-factory.cjs`. This factory injects the charged native invocation into
recall, organization and maintenance. The quality-only organization surface
refuses generic `apply` before dispatch. Ordinary product organization
permissions are unchanged.

`control.cjs` implements bind/wait through a bounded authenticated private Unix
HTTP transport. These are implemented protocol operations, not SDK methods or a
caller-supplied install callback. The controller validates actual source events
and one-use prepared materialization plans. `owned.cjs` writes only the exact
returned UUID carrier files inside the owned project. Decisions are observed and
charged synchronously inside the plugin before native dispatch; bounded batches
transfer those observations to the controller. Missing batches cannot become
successful evidence.

`native-runtime.cjs` uses the actual production `createBridge().run` with the
explicit private database, native artifact, Node executable and project. Actual
caller JSON and the production synchronous `beforeSpawn` barrier remain intact.
Setup seeds require a native write receipt plus independent full read and exact
organization snapshot readback. A seed is setup only and never a capture.
The first Node verification and each command/version handshake are reserved
separately. Unknown writes are not retried.

`egress.cjs` restricts SDK calls to the exact host origin and provider calls to
the explicit HTTPS endpoints with observed session custody. Provider retry is
disabled, redirects are manual, 401/403 and redirects are terminal, and normal
TLS hostname verification remains enabled. Transport custody headers are removed
before provider dispatch. No key contents are logged or copied into evidence.

The selected-address path uses `provider-wire.cjs` from that configured provider
fetch, through `/provider` on the SAME authenticated `control.cjs` listener.
`provider-bridge.cjs` in the existing parent Node 26 process calls
`selected-address.cjs` with the original HTTPS URL, Host and SNI. Its private
direct Agent has an empty `proxyEnv`; `family: 4`, `autoSelectFamily: false` and
the fixed single-address lookup prevent secondary DNS/address attempts. Default
certificate/hostname checks remain enabled. Local SDK requests keep their local
transport. The bundled Bun custom-lookup/TLS combination is not relied upon.

The test-only input and NEW grant must contain equal `network_binding` objects:
`kind: parent-node-selected-address-v1`, the sole exact endpoint
`https://sub2api.big.zone/v1/responses`, `hostname: sub2api.big.zone`, explicit
selected IPv4 `address`, `family: 4`, `port: 443`, and `selection` containing an
`id`, matching `approval_id`, ISO `selected_at`, `resolution_sha256`,
`route_sha256` and `route_interface`. Authorization rejects missing, changed,
future or older-than-five-minute selections before other input access. It does
not resolve, probe, or authorize an address. Historical `198.18.5.40` is only a
synthetic test value here. A consumed canary grant or injected offline fetch is
not proof of an actual child binding. The future wrapper/manifest is separate.

Each provider request body and entire provider response stream has a 262,144-byte
mechanism cap. Requests are read into one fixed-size buffer and charged before
transport dispatch; an oversized request never reaches transport. Responses are
charged per byte chunk before forwarding, with demand-driven reads and no whole
response buffering. Overflow, stream failure, consumer cancellation, abort,
transport uncertainty, redirects and 401/403 stop further provider dispatch on
that egress instance. The first terminal reason survives later cleanup failures.
Abort cancels pending body reads and the transport signal; a late response from
an injected transport that ignores abort is cancelled. Failed bodies error rather
than becoming truncated successful responses. There is no retry or redirect.
The 30-second provider signal covers request reading through response consumption.

The charged dimensions `provider_request_bytes` and `provider_response_bytes`
measure accepted body bytes, including raw SSE/JSON chunks before parsing.
The Node bridge requests identity encoding and refuses unexpected encoding on
either direction; raw IncomingMessage bytes are never silently decompressed.
Rejected overflow chunks are not forwarded or counted as accepted bytes. These
are not TLS, HTTP header or SDK loopback measurements. The transport/upstream owns any chunk it has
already allocated; this wrapper never accumulates an unbounded stream. The cap
is a conservative mechanism profile, not evidence of semantic quality or a grant.

## Custody And Decisions

The original dispatcher remains the authority for finite operation order,
approval counts, job states, repair/check separation and retirement inventory.
No source, gold, ID, denominator or original user turn is changed. The maintenance
root request is explicitly adapter-added neutral text. Logical fixture IDs map
to observed native session/user/message/part/call/tool IDs in external custody
rows. Historical frames are reference material, never new runtime evidence.

Original reads become private files used by the real `read` tool; command/API
observations become finite private Node emitters used by the real `bash` tool.
Only a validated nonsemantic bash `description` is ignored during execution
matching. Command, path, call identity, ordering and source bytes must still
match before preparation and materialization. Partial reads preserve fragment
status. Failed/denied operations remain errors. Genuine host framing is NOT_RUN.

Capture observations are opt-in callbacks at the actual production seams:
raw proposal, private admission result, raw support response, private support
acceptance, identity, and host-frozen supported identity-bound candidate issuance.
Capture has no maintenance opaque proposal token. Raw and accepted outcomes are
separate; a later permission denial does not erase an issuance observation.
Observers are bounded, screened, immutable and default silent. Observer failure
does not change admission or permission. No activity/log persistence was added.
Maintenance keeps its existing bounded four-stage observation mechanism.

The ledger keeps separate capture and maintenance traces. One workflow cannot
fill another's missing stages. Native permission, consume, dispatch, receipt and
independent readback are distinct observations. A final `saved` summary cannot
manufacture any of them. Natural observations and fixed bad-candidate adversaries
remain separate and carry no automatic quality credit.

Snapshot-conflict is a finite safety control, not proof of native CAS. Genuine CAS
still needs a legitimately issued proposal and independently charged concurrent
setup at the actual transaction boundary. Lost-response cannot reconstruct a
prior native dispatch from an expected body: without the actual prior artifact,
the concrete recovery path refuses `prior_native_dispatch_unobserved`. Neither
stratum adds a semantic opportunity, and neither is counted as a successful run.

## Finite Reservation

`inventory()` derives 31 capture workflow slots and 10 maintenance workflow slots
from 32 original turns. A maintenance review may finish before an independent
capture review starts. Each workflow independently permits at most two children,
three generations, one write attempt and 30 seconds. Product limits are unchanged.

| Reservation | Maximum |
| --- | ---: |
| Parent / worker / combined generations | 99 / 123 / 222 |
| Provider requests / SDK requests | 222 / 5,799 |
| Provider request body bytes / response body bytes | 58,195,968 / 58,195,968 |
| Children / review write attempts | 82 / 41 |
| Memory setup writes / private DB initializations | 15 / 28 |
| Native reads / invocations / reserved subprocesses | 381 / 1,121 / 2,270 |
| Host processes / private control listeners | 28 / 28 |
| Carrier writes / control requests | 84 / 7,168 |
| SDK/observation bytes / control bytes | 1,198,014,464 / 3,758,096,384 |
| Sequential reservation, including setup and cleanup | 3,534,000 ms |

These are finite enforced ceilings, not measurements, expected successful writes
or authorization. Initialization is separate from memory writes. Setup and
negative/early review attempts are included. Per-case caps sum to the population
caps. Every supplied SDK request is bounded before dispatch, responses are
refused rather than truncated, and native command/handshake reservations include
the first Node verification. The 16 capture cases, 8 opportunities, 9 claims,
12 maintenance cases and 2 authorized mutation opportunities remain unchanged.
The consumed old 20+8 requests, 3 writes and 300 seconds cannot cover this run.

Provider byte totals are separate from the SDK/observation byte total: each is
222 requests times 262,144 bytes, for a combined provider body reservation of
116,391,936 bytes. Each case derives both dimensions from its own provider request
slots, and these case reservations sum exactly to the population reservations.
The body cap is not a model context, output-token or quality claim. Lifecycle and
setup reservation changes are reconciled separately; provider bytes do not stand
in for subprocess or native accounting.

Parent precharges enforce both global and per-case provider reservations before
dispatch/forwarding. The child keeps its finite local observations but excludes
these dimensions from observation/result billing; the parent rejects a duplicate
provider charge. The bridge also consumes existing control request/body-byte
budgets and the same 256-call host ceiling. HTTP headers remain outside
`control_bytes`, as in the existing JSON route, and provider header serialization
has an independent 8KiB cap. No numeric reservation increased. Synthetic lifecycle
fixtures now include this binding and an inert `bindProvider`; no negative
permission/setup/lifecycle assertions were relaxed.

The runtime result has `population_status` (`complete` or `incomplete`), all
`planned_case_ids`, `attempted_case_ids`, `completed_case_ids`, and
`unexecuted_case_ids`, exact counts, `stopped_case_id` and `stop_reason`.
Completed means an adapter result was returned, including a safely known blocked
result; it does not mean semantic success. Unknown setup/write or exit stops the
loop before the next case, retains recovery and preserves observed case traces.
A thrown case boundary failure is reported separately in `case_failures` with
unknown recovery/exit; it cannot manufacture an adapter terminal report. An
incomplete CLI run prints its result and exits nonzero. Even complete visitation
keeps `quality_credit: false` pending genuine adjudication. No attempt is reset.

`node tests/capture-quality-population-native/provider-transport-driver.cjs`
exercises the public egress and meter with an in-memory SSE transport, verifies
charged exact-limit bytes, then observes overflow cancellation and no second
dispatch. It performs no real network or runtime operation.

A future authorized runtime entry is `node .../runtime.cjs --run input.json
new-grant.json`. No approval is created by that entry. This assignment executes
only the absent-grant refusal and offline surfaces. Runtime acceptance still
requires independent genuine host/model/native/database evidence.
