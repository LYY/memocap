# Corrected Lexical Versus Local Semantic Hybrid

Decision on 2026-11-11: **REJECT this candidate configuration**. The one frozen
holdout comparison produced 7/12 successful cases for both corrected lexical
and hybrid, with **zero fixed positives** and zero newly broken positives.
Forbidden environment/topic results and no-answer noise remained. Passing the
measured resource envelopes on this Mac does not satisfy the strict quality
contract. This is an experiment decision, not product release acceptance.
There is no production integration.

## Paired Experiment Evidence

The [acceptance contract](../tests/retrieval-evaluation/ACCEPTANCE.md) and original
v1 `scoring.mjs` were used unchanged, including full-injection concept coverage.
There is no `scorer.mjs` in this checkout; `scoring.mjs` is the scorer actually
imported by `scripts/evaluate-retrieval.mjs`. All seven fixture hashes, both
original baseline reports and the final corrected lexical tuning report remain
unchanged; their hashes are checked in the decision artifact.

The five new reports are:

- [Pre-query grid declaration](../tests/retrieval-evaluation/semantic-paired-20261111-r1-declaration.json): generic algorithm, all twelve configurations and selection rule.
- [Raw tuning](../tests/retrieval-evaluation/semantic-paired-20261111-r1-tuning.json): every query, native receipt, all 22 unfiltered semantic cosines, authorized semantic ranks, every configuration's fused scores and actual rendered result.
- [Frozen selection and ceilings](../tests/retrieval-evaluation/semantic-paired-20261111-r1-freeze.json): timestamp, hashes, configuration, resource contract and measured tuning basis.
- [Single paired holdout](../tests/retrieval-evaluation/semantic-paired-20261111-r1-holdout.json): one corrected native lexical invocation and one frozen hybrid outcome per query, with full raw evidence.
- [REJECT decision](../tests/retrieval-evaluation/semantic-paired-20261111-r1-decision.json): gates, family/origin breakdowns, read diagnostics, retained hashes and complete external experiment source code.

The grid was declared at `2026-11-11T10:04:46Z`; tuning finished at
`2026-11-11T10:05:25.139Z`. Selection was frozen at
`2026-11-11T10:06:22.902Z`, before the driver's exclusive holdout-open marker.
The freeze file's SHA-256 is
`33e37ef2d0b0538b45a7f3372b626d74d3129e5438afe90980a49b0b5186d787`.
Holdout was then opened and evaluated exactly once. No configuration or
retrieval implementation changed afterward. Subsequent work only summarized
recorded outcomes and ran separately labelled exact-read diagnostics.

### Mechanism And Isolation

The corrected CJK width is frozen at three, retaining two-character runs as
two. A copy of the actual native binary was pinned outside the checkout before
running either split, insulating the experiment from concurrent native rebuilds.
Its SHA-256 is
`485c241c1e05278bbfb3cd6e13b53e6d47849cd7a91665211828c0b193f7ba54`;
its receipts identify `package_version: 0.5.0`, even though this work targets
future 0.6 development. The actual protocol SHA-256 is unchanged:
`705b31cf1554f52313855cff5eb7a65239505042651c098e1c19cde2101d8767`.
The freeze also records query builder, renderer, scorer and driver hashes.

Each split used a new synthetic SQLite store under the external asset directory,
with isolated HOME/MEMOCAP/XDG environment and synthetic A/B/domain/universal
placements. All 22 seeded full bodies were read back against the independently
expanded canonical corpus. Existing vectors were source-checked against those
full-body SHA-256 values and dimensions; the model SHA was verified before
loading. There was no download, provider call, real database or remembered
destination access. The pinned model and original vectors were reused unchanged.

For every query, actual native `recall` used current `queryTerms`, `--match any`,
top three, `--max-chars 6000`, resolved targets and the fixture's exact selector.
Lexical candidates are the actual pre-budget `matched_ids`. The semantic input
is the full original prompt, encoded by the existing `Encoder.encode`; cosine
is the dot product of normalized vectors. All 22 document scores are preserved
before filtering. The union admits semantic candidates only inside the native
receipt's actual `searched_placements`, applying the same trimmed exact kind
filter as native `--type`. All fixture records are `context`; no fixture
exercises a nondefault kind selector, so that dimension has no empirical claim.

The declared grid is `k ∈ {10,60}`, semantic weight `∈ {0.5,1}` and cosine
threshold `∈ {0.30,0.45,0.60}`. Each candidate receives
`1/(k+lexicalRank) + weight/(k+authorizedSemanticRank)`; a missing list or a
semantic score below threshold contributes zero. Ties use lexical rank then ID.
No expected-ID, case-ID, query-specific or environment-keyword rule is used.
All twelve tied on tuning success, forbidden results, negative noise and hit@1;
the predeclared conservative tie-break selected **k=10, weight=0.5, threshold=0.60**.

The top-three prefix must fit native's 6000 Unicode scalar character budget
using whole authoritative bodies: processing stops when the next body does not
fit. The actual plugin `validateMemories` and `referenceBlock` then render under
6000 UTF-16 characters, retaining original full-body hashes and exact read
routes. The driver does not crop a body or relabel partial content as full.

### Quality Results

| Split and arm | Successes | Hit@1 / Hit@3 / MRR | Fixed positives | Broken prior positives | Negative noisy cases / returned items |
| --- | ---: | --- | ---: | ---: | --- |
| Corrected lexical tuning | 11/12 | 1 / 1 / 1 | baseline | baseline | 1/2 / 3 |
| Each of the twelve hybrid tuning configurations | 11/12 | 1 / 1 / 1 | 0 | 0 | 1/2 / 3 |
| Corrected lexical holdout | 7/12 | 0.81818 / 0.81818 / 0.81818 | baseline | baseline | 1/1 / 3 |
| Frozen hybrid holdout | 7/12 | 0.81818 / 0.81818 / 0.81818 | 0 | 0 | 1/1 / 3 |

Both holdout arms had candidate coverage 1. All ten tuning positives remained
successful. `t-unknown-service` still returned `alpha-route`, `issue-route` and
`alpha-conflict`; `t-noanswer` stayed empty. Every configuration's fixed/broken
case lists are empty. Raw tuning provides all per-case scores, including changed
fused scores even when the final successful outcome is unchanged.

Every holdout outcome below is identical between lexical and frozen hybrid:

| Case | Returned logical IDs | v1 outcome |
| --- | --- | --- |
| `h-path` | `path-anchor` | success |
| `h-version` | `version-anchor` | success |
| `h-beta` | `beta-conflict`, `alpha-conflict`, `topic-universal` | fail: forbidden `alpha-conflict` |
| `h-topic` | `topic-universal`, `topic-local`, `alpha-route` | fail: forbidden `topic-local` |
| `h-close-negative` | `beta-conflict`, `alpha-conflict`, `scope-distractor-2` | fail: no-answer noise |
| `h-ranking` | `relevant-global`, `origin-B-fact`, `domain-route` | success |
| `h-cross-fact` | `origin-B-fact` | success |
| `h-origin-filter` | `beta-conflict`, `topic-universal`, `relevant-global` | success; exact universal selector respected |
| `h-stale` | `stale-route`, `alpha-route`, `alpha-conflict` | success |
| `h-duplicate` | `duplicate-two`, `duplicate-one` | success under original any-ID rule |
| `h-tail` | empty | fail: no fully injected `tail-prohibition` |
| `h-unicode` | empty | fail: no fully injected `unicode-tail-prohibition` |

The exact error/path/version anchors remain successful with the expected item
at rank one, and the workload anchor remains first in both tuning late-entity
cases. The universal selector excludes the repository alpha conflict even
though its unfiltered semantic cosine is 0.68837, close to beta's 0.72959.
For unfiltered `h-beta`, those same candidates remain jointly returned: similarity
does not establish environment correctness. `h-topic` similarly retains the
forbidden lexical candidate despite its cosine falling just below 0.60.

The required zero gates are **not all satisfied**: holdout no-answer noise is
1/1, forbidden environment occurs in `h-beta` (1/2 environment-check cases),
and forbidden topic exposure occurs in `h-topic`. Explicit-selector leakage and
partial-as-full count are both zero. There are no additional negative noise
items relative to lexical, but existing failures still fail the zero gates.
No positive was newly repaired or newly broken; all four failed positives are
listed above. The strict benefit requirement alone also independently rejects
the candidate.

### Whole Bodies, Partial References And Full Reads

`long-tail` is 7265 scalar/UTF-16 characters; `unicode-tail` is 6116 scalars and
6496 UTF-16 characters. Both exceed native's whole-body budget and are omitted
before plugin rendering. They were found as lexical candidates, but there is
no injected reference or automatic read route in either primary recall result.
Their missing tail concepts remain failures under the original v1 scorer.
No primary recall result was partial; zero partial-as-full therefore does not
claim partial recovery was exercised by a query.

Separate exact-read diagnostics used the already observed matched ID and exact
placement, without another recall or scoring pass. The actual plugin rendered
each full read into a 6000-character block marked `partial` (4241 and 3796 body
UTF-16 characters respectively). Each reference retained its canonical full-body
SHA and `memocap_read` route. Following that actual route through native `read`
and `validateRead` returned the full canonical body, `completeness: full`, and
`record_changed: false` for both. These diagnostics demonstrate integrity and
the existing full-read path once a partial reference exists; they do not turn
an absent recall reference into a workflow success or relax full-injection gates.

### Measured Latency And Footprint

The machine was an Apple M2 Pro, darwin/arm64, 12 logical CPUs, 34,359,738,368
bytes of RAM. Before holdout, the existing **3000 ms query E2E maximum** was
frozen as a hard acceptance limit, including startup for a new encoder process.
Warm p95 was capped at **74.782666 ms**, twice measured corrected lexical tuning
p95. Per-component RSS envelopes were derived by rounding actual tuning peaks
to the next 128/32/16 MiB for Python/Node/native: **939,524,096 / 201,326,592 /
16,777,216 bytes**. These are local experiment envelopes, not proposed universal
product memory budgets. All measured holdout resource gates passed.

| Measurement | Tuning | Single holdout |
| --- | ---: | ---: |
| Native lexical p50 / p95, ms | 31.925 / 37.391 | 34.415 / 41.865 |
| Selected hybrid warm E2E p50 / p95, ms | 35.450 / 49.087 | 38.091 / 49.587 |
| New Python process to ready, ms | 1800.149 | 1098.068 |
| Startup plus first hybrid query, ms | 1849.236 | 1147.655 |
| Python peak RSS, bytes | 904,183,808 | 902,316,032 |
| Node driver peak RSS, bytes | 175,161,344 | 172,556,288 |
| Native CLI peak RSS, bytes | 15,613,952 | 15,564,800 |
| Synthetic DB after seed / evaluation, bytes | 172,032 / 184,320 | 172,032 / 184,320 |

Warm cost includes the actual native process, actual lexical rendering, Python
encoding with full-token diagnostic count, cosine ranking, IPC, fusion, full-body
selection and final plugin rendering. The common native/encode prefix is shared
across the tuning grid; only each configuration's fusion/render work is separately
timed. `/usr/bin/time -l` observes native RSS and its wrapper overhead remains in
the elapsed time. Resolve/seed operations are outside query timing. No corpus-only
encode measurement is presented as query latency. Cold means a new process;
the OS file cache was not flushed. These are twelve-case descriptive nearest-rank
quantiles, not load or production latency guarantees.

RSS values are independent component high-water marks, not a simultaneous total.
The Python process includes SHA verification, two tokenizer objects, full-token
diagnostics and Pydantic; the Node driver retains raw grid/report data. The
approximately 902 MB Python peak is the actual prototype cost, not an estimate
based on weight size or a claim about a future native implementation.

Fixed runtime assets remain **135,392,208 bytes**. Installed ONNX Runtime adds
**65,278,097 bytes**; all installed dependency distributions total **147,070,538
bytes**, already including ONNX Runtime. Assets plus all those distributions are
**282,462,746 bytes**, before the Python interpreter, pyc, experimental scripts
and corpus vectors. The 242,838-byte vector JSON is separately inventoried in the
freeze; original asset/runtime manifests retain per-file sizes and hashes.
The five audit reports add about 2.56 MB of repository evidence, not runtime
assets. Numerical disk ceilings are the exact pinned asset/distribution totals.

The existing interpreter and actual native CLI were exercised end to end.
Python query-server diagnostics report no errors or warnings; JS experiment
drivers have no errors (import/template style hints, and an unused import in
the freeze helper, remain nonfunctional diagnostics). No production build or
dependency changes were needed. Python/native integration, license packaging,
and macOS/Linux/Windows distribution remain unproven. The result supplies no
reason to incur that integration work for this rejected candidate.

## Preserved Readiness Evidence

The sections below retain the earlier corpus-only readiness measurements and
provenance. At that earlier cutoff, no tuning/holdout queries or expectations
had been opened and no query-to-document similarities had been computed. Those
historical timing numbers are not the query measurements above.

## Reproduction Artifacts

All experiment assets, code and outputs are outside the checkout:

```text
/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode/memocap-semantic.XEF9ebX0/
  runner.py                 actual tokenizer -> ONNX CPU -> mean -> L2 runner
  runner.py.lock            uv dependency versions, artifact URLs/bytes/SHA-256
  model_quantized.onnx      sole downloaded model weight artifact
  tokenizer.json            tokenizer pipeline, including normalizer/postprocessor
  tokenizer_config.json
  config.json
  README.md                 pinned Xenova card
  upstream-README.md        pinned upstream card/license declaration
  upstream-pooling.json     pinned upstream pooling configuration
  xenova-metadata.json      pinned revision's public file/LFS metadata
  vectors.json              22 ID + canonical body SHA-256 + vector records
  manifest.json             actual run, assets and installed runtime file hashes
  verification.json         independent readback checks
  pyrightconfig.json        local ephemeral dependency resolution for type checking
```

With that directory as the working directory, rerun the corpus encoding with:

```sh
uv run --python 3.13.18 --frozen --script runner.py \
  /Users/liuyuyu/program/github/LYY/memocap-memory-recall-v0.6.0/tests/retrieval-evaluation/corpus.json
```

This intentionally regenerates `vectors.json` and `manifest.json`; elapsed
times and therefore their file hashes will change. Preserve the recorded run
before rerunning if its exact evidence is needed. These are temporary local
artifacts, not a repository-distributed runner or a production dependency.
Recreation elsewhere requires the runner, its lock, and the named pinned assets.
No model weights, dependency manifests or ignore rules were added to the repo.

## Candidate And Provenance

The candidate is
[`Xenova/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/2c4055b12046f11709e9df2c122e59ffbdc2f900),
revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`, artifact
`onnx/model_quantized.onnx`. Downloads used unauthenticated public HTTPS
revision URLs, without a Hub client, account credentials or provider setup.
The completed model download took 7.708990 seconds in this session.

| Artifact | Actual bytes | SHA-256 |
| --- | ---: | --- |
| `model_quantized.onnx` | 118,308,126 | `66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc` |
| `tokenizer.json` | 17,082,913 | `b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441` |
| `tokenizer_config.json` | 496 | `3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2` |
| `config.json` | 673 | `05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7` |
| `runner.py` | 8,640 | `52af467bd8c8134a1e80f8763c7eccbab932b37bce08d62b588f07f495ac1f64` |
| `runner.py.lock` | 46,312 | `fde20b7de10171fc9bfb54227566486e975901bbdbf18f306e918166c099716c` |
| `vectors.json` | 242,838 | `10bf29b0f8f7ff3444fbff868d398e7e53bcc0c58d5b3f35470f1b8bdbf7121a` |

The model's actual bytes and SHA-256 agree with the saved revision's public
LFS metadata. The earlier researched size, 118,412,398 bytes, does **not**
describe this pinned artifact. The four model/tokenizer runtime assets above
total 135,392,208 bytes; the model weight size alone excludes its tokenizer.

The Xenova card identifies its upstream but does not independently declare a
license. The linked upstream
[model card](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/blob/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/README.md)
at revision `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` declares
`apache-2.0`, 384 dimensions and attention-mask mean pooling. Its pinned
[`1_Pooling/config.json`](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/blob/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/1_Pooling/config.json)
enables mean tokens and disables CLS, max and mean-sqrt-length pooling.
The upstream revision pins documentation provenance; it is not evidence that
Xenova converted that exact upstream commit.

## Actual Runtime And Encoding

The experiment used uv 0.10.2, the already installed CPython 3.13.18, macOS
26.6.2 arm64 and an Apple M2 Pro. The ephemeral uv environment pinned
`onnxruntime==1.23.2`, `tokenizers==0.22.1`, `numpy==2.3.5` and
`pydantic==2.12.4`. All transitive versions and distribution artifact hashes
are frozen in `runner.py.lock`; all 28 actually installed distributions have
per-file bytes and SHA-256 in `manifest.json`. No PyTorch was installed.

The ONNX Runtime macOS arm64 CPython 3.13 wheel recorded in the lock is
`onnxruntime-1.23.2-cp313-cp313-macosx_13_0_arm64.whl`, 17,196,337 bytes,
SHA-256 `2ff531ad8496281b4297f32b83b01cdd719617e2351ffe0dba5684fb283afa1f`.
This is wheel metadata, not the installed footprint: actual installed ONNX
Runtime files total 65,278,097 bytes. All installed distribution files total
147,070,538 bytes, excluding `.pyc`; this is logical file size, not allocated
disk space, cache size, interpreter footprint or RSS. The local interpreter
executable's path, bytes and hash are recorded in `verification.json`.

The inspected graph requires `input_ids`, `attention_mask` and
`token_type_ids`, each `int64[batch_size, sequence_length]`. The runner uses
the tokenizer's actual `type_ids`, rather than omitting this required input.
Its sole graph output is `last_hidden_state`,
`float[batch_size, sequence_length, 384]`.

The pinned tokenizer JSON supplies tokenization and special tokens. Right
truncation is explicitly 512 tokens including special tokens, with sequential
batch size 1 and no padding. Pooling is
`sum(hidden * attention_mask) / sum(attention_mask)` over tokens, followed
by L2 normalization for subsequent cosine use. Special tokens participate
as in the upstream mask-based pooling example. CPU execution alone is
enabled, fallback is disabled, and intra/inter-op threads are both 1. These
settings describe this run; they are not selected resource acceptance ceilings.

| Measurement | Observed seconds |
| --- | ---: |
| Fresh ONNX session initialization | 0.127275750 |
| Two tokenizer instances loaded, including full-length token counter | 0.574817625 |
| All 22 records: tokenization, inference, pooling/L2, diagnostic full token counts and body/result preparation | 0.536781334 |
| Sum of per-record tokenization/inference/pooling/L2 timers, excluding full token counter | 0.528614710 |

The final measurements came from one sequential corpus run after a typing
correction. Assets had already been downloaded and used; filesystem/OS cache
state was uncontrolled. Import time, artifact hashing, dependency audit and
output serialization are outside these timers. These observations are not
end-to-end CLI query latency, p50/p95, memory measurement or a quality claim.

## Body Integrity And Independent Readback

The frozen `corpus.json` SHA-256 is
`936448108abe6e56b163e21a2a306ca1f7e2b27f6f87834ea4d27be05e0ac860`.
Canonical bodies are the exact `content + repeat.text * repeat.count + suffix`,
matching the evaluator's expansion. Each vector is keyed by logical ID plus
SHA-256 of the full expanded UTF-8 body, without Unicode normalization,
whitespace stripping, summarization or metadata concatenation.

| Record | Full UTF-8 body bytes | Full tokens | Encoded tokens | Full-body SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `long-tail` | 7,265 | 1,872 | 512 | `1007181cec65de44e26ae2e03e08051112e7dd227d8ee6df4cfb008b5c61f468` |
| `unicode-tail` | 17,182 | 4,960 | 512 | `ad20d8e597cd65000cb905957bee0537b45630315a4516a867f845a4c41e4f74` |

Only these two records exceeded 512 tokens. This is **retrieval feature
truncation**: their full bodies and suffixes remain authoritative, while the
vectors omit tail information and cannot prove full-source preservation or
represent the tail prohibitions reliably. The upstream SentenceTransformers
architecture advertises `max_seq_length=128`; this experiment deliberately uses
the pinned Xenova tokenizer's `model_max_length=512`, as specified for this
candidate, and does not claim equivalence to upstream defaults. Retrieval
feature truncation is separate from the eventual extraction/injection budgets;
those budgets must not silently truncate candidate bodies before hashing.

A separate read-only verification process reopened the manifest and vectors,
re-expanded all 22 original records independently, and checked each ID/body
hash, all 11 artifact sizes/hashes and all 3,797 recorded installed runtime
files. The result is 22 unique ID/body-hash keys, shape `(22, 384)`, all finite,
all norms within absolute tolerance `1e-6` of 1 (maximum float32 norm error
`1.1920928955078125e-7`). The two identical certificate bodies produced exactly
equal vectors. No query-to-document similarities were computed.

The independently read-back `manifest.json` SHA-256 is
`5906543a8af6f1bf45d8728f410d665cb9590fd79f98dd071a5714b94c2c8a95`;
`verification.json` records these checks. Python LSP diagnostics were attempted
but the active server did not resolve the ephemeral uv packages. A separate
`basedpyright --project pyrightconfig.json --level error runner.py` check,
with the ephemeral site-packages path, completed with zero errors; broader
diagnostics include third-party binding/type-inference warnings. The runner
has 213 nonblank, noncomment lines, in the 200-250 warning band; it remains
one bounded experiment runner rather than a framework.

## Parent Continuation Contract

The module exposes `Encoder()` and `encode(text) -> Encoded`; importing
`runner` does not run `main()`. After the corrected CJK baseline is frozen,
the parent can import it in a driver using the same ephemeral interpreter:

```text
/Users/liuyuyu/.cache/uv/environments-v2/runner-62575ba291bdd0dc/bin/python
```

Add the experiment directory to that driver's import path. Load `vectors.json`
as a matrix in its recorded order and retain `(id, body_sha256)` alongside
every row. Reuse one `Encoder` session for the parent's later approved query
texts; `encoded = encoder.encode(query_text)` returns a normalized vector,
token counts and `encoded.elapsed_seconds`. Since corpus and query vectors
are normalized, `matrix @ encoded.vector` gives the cosines in corpus order.
At the earlier readiness cutoff this API had not been used for queries; the
paired experiment above subsequently used it in the same ephemeral interpreter.
The parent must separately measure the complete driver/CLI request latency;
the per-encode timer excludes its extra full-token diagnostic count.

Scope/selector and applicability rules, complete authoritative-body fetching,
paired ranking/threshold tuning, numerical resource ceilings and a single
holdout decision were pending at that cutoff and are now recorded above. Vectors
are derived, non-authoritative retrieval features and confer no permission
to broaden scope or execute remembered destinations. No real database, user
memory, configured provider, product index or production CLI was accessed.

Python/ONNX Runtime here is experiment-only. If this model later wins the
paired decision, Rust fastembed/native ORT integration, license packaging,
and static-link/build/distribution feasibility on all three supported OSes
still require a separate integration decision. This macOS prototype supplies
no evidence that those product constraints have been met.
