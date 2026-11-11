# Corrected CJK Lexical Recall

This slice fixes lexical discovery against the existing schema 2.2 FTS index.
The selected parameters below are frozen from **tuning only**, before any
holdout run. This task did not read holdout inputs or run holdout evaluation.
Holdout execution remains a separate explicit parent step. No embeddings,
semantic model, learned weights, schema changes, or index rebuild are involved.

## Mechanism and Frozen Choice

`memories_fts` indexes `content` and `tags`, with external content in `memories`.
Its default unicode61 tokenizer treats a contiguous Chinese sentence as one
token. The old quoted `数据库` query consequently cannot find the token
`数据库变更必须保留用户数据`.

Discovery now expands each whitespace-delimited query term containing CJK:

1. Extract contiguous CJK fragments of **three characters**, or the full run
   when it is **two characters**. Single-character runs receive no expansion.
2. Read the current `memories.content` and `memories.tags`, finding alphanumeric
   candidate spans containing a query fragment. For a mixed term without spaces,
   require all its Latin/numeric anchor components in the candidate span too.
3. Keep the original term and deduplicate lowercase alternatives. Quote every
   alternative through the existing FTS query helper. SQLite's actual tokenizer
   still interprets these candidates; this is not a replacement Unicode tokenizer.
4. Join alternatives with OR inside each original term; retain the requested
   All/Any operator between original terms. Execute one FTS MATCH query using
   the existing global `bm25(memories_fts), created_at DESC, id DESC` ordering.

Fragment width is the sole retrieval parameter varied in this experiment:
two versus three characters. Width three was selected because it restores both
Chinese tuning cases without the width-two exact-sentence regression below.
Two-character query runs remain usable, as verified by `证书` and `环境` behavior.
There are no term dictionaries, special phrases, custom ranking weights, or
origin-dependent scores.

Expansion is bounded to **64 distinct fragments per query term** and **256
distinct alternatives per query term, including the original**. Exceeding either
bound returns an explicit failed operation, rather than silently truncating
candidates or making the query match all rows. These are resource ceilings, not
optimized score parameters. Vocabulary extraction scans current rows once per
expandable term, retaining only its matching alternatives and one current field.
It is linear in corpus text size, not an indexed substring search; this baseline
targets the current small personal corpus. It has not been benchmarked for a
large library. The 22 invented evaluation records are not the user's 12 live
records; no live database was accessed.

Empty, whitespace, quotes-only, punctuation-only, and unrelated queries stay
empty. Non-CJK queries use the original query unchanged, preserving English,
exact-error, and precise-path anchors. Kind and exact-placement filtering remain
in discovery; limit and character budget remain global and downstream. There is
no topic shadowing or source-order promotion. Current-row extraction and existing
FTS triggers make updates and deletes immediately effective. A strict read-only
connection regression proves the new discovery requires no DDL or migration.

## Actual Measurement

Authoritative report:
[`cjk-corrected-lexical-tuning.json`](../tests/retrieval-evaluation/cjk-corrected-lexical-tuning.json).
It contains the full raw score, returned/candidate/complete IDs, query terms,
argv, selected discovery, and injection/truncation observations for every case.
The frozen fixture hashes are verified by the evaluator before execution.

```sh
cargo build --offline --bin memocap
node scripts/evaluate-retrieval.mjs --split tuning --output tests/retrieval-evaluation/cjk-corrected-lexical-tuning.json
```

The report was created with exclusive file creation; reruns need a new filename.
No `--library` extra was supplied. All 12 actual receipt discoveries were
`{"kind":"library"}`. The default plugin query mode used the selected protocol's
query extraction and real native binary, with `--match any`, top 3, 6000 CLI
content characters and 6000 plugin reference UTF-16 characters.

| Identity | Measured value |
| --- | --- |
| Binary | `/Users/liuyuyu/program/github/LYY/memocap-memory-recall-v0.6.0/target/debug/memocap` |
| Binary SHA-256 | `485c241c1e05278bbfb3cd6e13b53e6d47849cd7a91665211828c0b193f7ba54` |
| Package reported by binary | `0.5.0` (future 0.6 source work; no release bump) |
| Protocol | `/Users/liuyuyu/program/github/LYY/memocap-memory-recall-v0.6.0/plugin/protocol.js` |
| Protocol SHA-256 | `705b31cf1554f52313855cff5eb7a65239505042651c098e1c19cde2101d8767` |
| Query implementation | `/Users/liuyuyu/program/github/LYY/memocap-memory-recall-v0.6.0/plugin/query.js` |
| Query file SHA-256 | `1954cf8c608c2239021ec02a9bd5bd920442ff2d10fb6251ec82e7da4f4395fe` |
| Query function SHA-256 | `67b441623ab6281de77d9067460c8e3b156107103c7b244f004ee94f0e8f618f` |

| Tuning metric | Before expansion | Width two | Selected width three, final build |
| --- | ---: | ---: | ---: |
| Successes / all cases | 10/12 | 10/12 | 11/12 |
| Hit@1 / positive cases | 9/10 | 9/10 | 10/10 |
| Hit@3 / positive cases | 9/10 | 9/10 | 10/10 |
| MRR | 0.9 | 0.9 | 1.0 |
| Candidate coverage | 0.9 | 1.0 | 1.0 |
| Noisy negative queries | 1/2 | 1/2 | 1/2 |
| Negative returned items | 3 | 3 | 3 |
| Wall p50 / p95, ms | 25.64 / 27.17 | 25.95 / 30.13 | 27.39 / 31.94 |

Exploratory artifacts are `cjk-before-tuning.json`, `cjk-bigram-tuning.json`,
and `cjk-trigram-tuning.json` in the same directory. The final artifact above
is authoritative. The parent concurrently corrected complete-body budgeting;
the exploratory bigram run predates that correction and returned an oversized
`unicode-tail` first for `t-db-control`. The corrected budget instead rejects
that oversized first body. Both outcomes miss `db-preservation`; neither is
counted as a success. No performance conclusion is drawn from these single
process-per-query timing runs.

## Per-Case Outcomes and Remaining Noise

| Case | Final returned IDs, in order | Result |
| --- | --- | --- |
| t-issue | issue-route | pass |
| t-issue-en | issue-route, domain-route, alpha-route | pass |
| t-alpha-cross | alpha-route, alpha-conflict, topic-local | pass; new candidate noise below budget |
| t-alpha-local | alpha-route, deployment-anchor, alpha-conflict | pass |
| t-db-cn | db-preservation | fixed; previously empty |
| t-db-control | db-preservation | preserved; width two had broken this |
| t-late | deployment-anchor | pass |
| t-deployment-control | deployment-anchor, alpha-route | pass |
| t-error | error-anchor | pass |
| t-unknown-service | alpha-route, issue-route, alpha-conflict | existing negative failure |
| t-shared | domain-route | pass |
| t-noanswer | none | pass |

The width-two failure involves `必须` and `保留`, shared with the long Unicode
record. Repeated matching vocabulary there outweighs the correct sentence under the
unchanged FTS BM25 calculation. Width three removes that expansion for this
query. It does not promise immunity to repeated phrases generally.

The selected width still adds `unicode-tail` as the sixth matched candidate for
`t-alpha-cross`, through the complete two-character query run `环境`. It is not
returned or injected in that case. This additional candidate noise is visible
in the report and was not hidden by changing fixtures or scoring. The unknown
service negative still returns three unrelated routing records; lexical overlap
cannot establish a verified service mapping. No acceptance criteria were relaxed.

This is substring-assisted lexical discovery. A paraphrase with no shared
two/three-character fragment can still miss. Single-character substring search,
semantic inference, general language segmentation, and semantic abstention are
not established by this result.

## Regression Evidence

`tests/cjk_recall.rs` initially failed four CJK-dependent regressions against the
old implementation while empty-query and English/path controls passed. Its final
ten focused tests cover Chinese token/paraphrase recall through plaintext CLI,
local JSON, live loopback remote receipts, the live legacy remote API, and the
native store API on a strict read-only connection; mixed All/Any and glued Latin
anchors; Chinese tags; empty/negative queries; long paths; exact placements and
kind; global complete-body budget; current content after overwrite/delete;
repeated two-character noise; and explicit expansion-limit failure. The shared
server fixture contributes one additional passing test.

Existing library, remote, exact-read, read-only inspection and complete-body
budget suites remain unchanged by this slice and pass. Offline native build,
targeted Clippy with warnings denied, and changed-Rust-file LSP diagnostics pass.
Manual native CLI use in a fresh temporary database also returned the saved
Chinese sentence for both queries; help rendered and an invalid match mode was
rejected before recall.

Tokenizer and ranking behavior were checked against the official
[SQLite FTS5 documentation](https://www.sqlite.org/fts5.html), specifically
unicode61, FTS5 phrases, and bm25(), retrieved through Context7.
