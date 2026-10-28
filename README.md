[中文](README-CN.md)

# memocap

memocap is a local-first SQLite memory sidecar for OpenCode. It stores explicit
memories in repository, attached-domain, or universal placements, then recalls
them through one ordered visible stack.

OpenCode is the only officially supported integration. The plugin invokes its
package's absolute bundled CLI launcher and verifies the native version; it does
not resolve an unrelated `memocap` from global PATH. Database lifecycle behavior is defined by
the [schema versioning contract](docs/SCHEMA-VERSIONING.md). Deployment and
remote operation are documented in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Install

Install the v0.3.0 CLI, OpenCode plugin, and runtime skill for your user:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --global --yes --json
```

Requires Node.js 22.20 or later, npm/npx, and OpenCode 1.19.3. The package
contains the complete skill and its references. Setup copies it into the selected
OpenCode config root, then points both the plugin and `skills.paths` at that same
managed directory. The default path does not use Git or the `skills` CLI, though
npm registry access or an npx package download may be needed. Setup does not
install or upgrade OpenCode. See [the installation guide](docs/INSTALL.md) for
project installs, optional standalone skills, checks, updates, recovery, and data
handling.
Agents should follow [the agent guide](docs/INSTALL-AGENT.md) for authorized
non-interactive installation and updates.

## Command matrix

The following matrix is the current CLI surface. Placement selectors are
mutually exclusive. `<PLACEMENT>` is `repository:<64 lowercase hex>`,
`domain:<DOMAIN>`, or `universal`.

Global `--repo <PATH>` selects a concrete repository instead of the working
directory; repeat it only for recall, up to eight targets. Writes have one
target. Global `--json` returns a format-1 receipt for automation; it is not
supported by `serve` or `ui`. Package `0.3.0`, core schema `2.0`, and receipt
format `1` are independent identities.

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--match all|any] [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--domain <DOMAIN> | --universal] <QUERY>
memocap list [--limit <LIMIT>] [--offset <OFFSET>] [--placement <PLACEMENT> | --domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
memocap scope list --all
memocap scope domain create <DOMAIN>
memocap scope domain attach <DOMAIN> [--before <DOMAIN>]
memocap scope domain detach <DOMAIN>
memocap scope domain list [--all]
memocap scope domain delete <DOMAIN>
memocap scope copy --id <ID> --from <PLACEMENT> --to <PLACEMENT> [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap scope move --id <ID> --from <PLACEMENT> --to <PLACEMENT> --yes [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap operation status --recovery <RECOVERY>
memocap status [--read-only]
memocap activity list [--writes] [--limit <LIMIT>] [--offset <OFFSET>] [--repository <ID>] [--session <ID>] [--operation <ID>]
memocap activity show <OPERATION_ID>
memocap activity prepare
memocap serve [--bind <BIND>]
memocap ui
memocap-setup <install|check|update|doctor|uninstall> [--global | --project <PATH>] [--to <VERSION>] [--dry-run] [--yes] [--json]
```

`scope domain create` registers a reusable domain ID. `attach` binds that
registered domain to the current repository, and `--before` changes its stack
position. `detach` removes only the current repository binding. `list` shows
current attachments; `list --all` shows the registry. `delete` removes an
unused registry entry.

Without a selector, `remember` writes to the current repository scope. `--domain`
requires an attached domain. `--universal` selects universal memory. `recall`
and `list` without a selector use the visible stack. A selector limits them to
one exact domain or universal placement. `forget` always targets one exact
placement, with the repository as its default.

Installation uses the separate `memocap-setup` executable; its `--global` selects
integration scope, not universal memory. Old `memocap install/uninstall`, legacy
scope syntax, other host adapters, TUI write/delete actions, and unversioned
HTTP routes remain removed.

## Receipts, inventory, and activity

Recall defaults to `--match all`; `any` matches at least one normalized term.
For multiple explicit targets, topic shadowing is applied per repository before
the union receives one result and character budget. Receipts expose targets,
searched placements, query terms, matched/returned IDs, truncation, errors, and
activity outcome. A successful current-request plugin receipt, including a valid
empty or cached result, satisfies recall-first without repeating the same query.

Use `scope list --all` only for an intentional full inventory, then
`list --placement <PLACEMENT> --limit 20 --offset 0` for exact paged rows.
`status --read-only --json` checks core and activity compatibility without
logical writes: it does not write data or schema, initialize or migrate the main
database, prune history, or record activity. Ordinary memory commands such as
`memocap list` use a read-write open and can initialize a missing database or
bridge schema `1.0` to `2.0`. `activity list/show` use read-only access and do
not prepare the database. SQLite `READ_ONLY` connections may still coordinate
WAL/SHM sidecars; ordinary WAL inspection needs no owner snapshot.
`activity prepare` explicitly prepares the local main database, creating schema
`2.0` or bridging the exact registered `1.0` schema. Preparation can prune
retained activity. Remote preparation belongs to the server administrator.
See the
[schema versioning contract](docs/SCHEMA-VERSIONING.md) for the full boundary.

Activity and repository hints are retained operational metadata in the main
SQLite database, not a complete audit log. Recall/injection retention is 30 days
and 10,000 events; write metadata is capped at 1,000 events. Gaps can follow
expiry, pruning, or recording failure. A successful core write stays successful
if activity fails; report its warning and never replay the write to repair
history. An existing `<core filename>.activity.sqlite` file is left untouched
and its history is not imported. Any later discard is a separate, user-authorized
choice after old writers are quiescent.

The plugin exposes `memocap_recall`, `memocap_remember`, and `memocap_scope`
tools. `/memory status`, `/memory recall`, `/memory scope <PATH...>`,
`/memory scopes`, `/memory list`, `/memory recent`, and `/memory why` make the
session's target and recall receipt inspectable. Prepared input is not proof of
model understanding or adoption. See the [runtime skill](skills/memocap/SKILL.md)
for permission and explicit target-switching policy.

## Scope and visible stack

`scope show` prints the active scope, the repository ID, its resolution source,
and attached domains in persisted order:

```text
memocap scope show
```

Repository identity is stable when a supported Git remote is available. An
ambiguous or unsupported remote uses the Git common directory. Outside Git,
memocap uses the canonical non-Git directory path. The printed repository ID
is opaque and is not a user-selected ACL or tenant name.

The default visible stack is ordered as follows:

1. Current repository.
2. Attached domains, in their persisted attachment order.
3. Universal memory.

Recall applies topic shadowing before its limit and character budget. A
repository memory with the same non-empty normalized topic shadows matching
records in every lower tier. A domain memory shadows matching universal
records. Domains do not shadow one another. `list` and TUI List retain
addressable shadowed records and annotate their visibility. `status` reports
addressable and effective counts for every source and in total. Deleting a
shadowing record exposes the next lower record.

`--topic` creates an explicit replacement relationship. It does not filter an
ordinary topic search, copy a record, or delete a lower-tier record.

## Copy, move, and provenance

Copy and move require exact placements. Copy preserves the source record and
creates a destination record. Move retains the memory ID while changing its
placement. `scope move` requires `--yes` because it is destructive at the
source placement:

```sh
memocap scope copy --id 7 --from repository:<REPOSITORY_HASH> --to domain:rust/cli --note "shared crate guidance"
memocap scope move --id 8 --from domain:rust/cli --to universal --yes
```

The first transfer writes immutable first-transfer provenance. Later copy or
move events are recorded separately in the operation ledger. A supplied or
derived operation ID makes an exact committed request idempotent across fresh
processes and attachment changes. Reusing an operation ID with a different
request conflicts without mutation.

## TUI

Run `memocap ui`, or run `memocap` with no subcommand. The menu contains only
`Status`, `List visible memories`, and `Exit`. Status shows schema version,
ordered placements, addressable/effective counts, totals, and the local or
remote target. List uses the same visible inventory as the CLI, including
placement and shadow annotations. Paging returns to the menu without writing
memory.

## Local and remote targets

With no remote address configured, the CLI opens its local SQLite database and
does not use the network. Set `MEMOCAP_ADDR` to select remote mode. Remote mode
also requires `MEMOCAP_TOKEN`; a missing token is an error, and remote mode
does not fall back to local. The address and token are required together.

The server accepts authenticated `POST` requests under `/v1` only. The
`Authorization: Bearer <token>` value gates the whole server. This is one
shared bearer token. The remote trust boundary is not ACL, IAM, per-user authorization, or tenant isolation. Address and token are required together for remote mode. Placement selection and domain attachment determine namespace
selection, not authorization.

Bearer authentication does not provide transport confidentiality or integrity.
The default Compose deployment exposes plaintext HTTP only on host loopback.
Remote clients must use an operator-controlled TLS-terminating reverse proxy or
an equivalent trusted encrypted network boundary; set `MEMOCAP_ADDR` to its
`https://` endpoint. Do not publish the raw HTTP port on all host interfaces.

JSON operations first negotiate `/v1/capabilities`, then use `/v1/receipt`;
unsupported servers fail before a new-semantics operation. Existing `/v1/status`
remains available for legacy clients. See [DEPLOYMENT.md](docs/DEPLOYMENT.md)
for the route list, trust boundary, Compose setup, and recovery procedure.
Remote requests carry a valid remote scope ID, and the server strictly validates
that ID.

When a remote copy or move response is lost, use the issued recovery handle with
`memocap operation status --recovery <RECOVERY>`. `not_found` alone does not prove manual replay is safe, and the operation may remain unknown. Do not
manually replay a lost request from a bare `not_found` result.

## Policy boundaries

The OpenCode skill's memory-admission and least-sharing policy is model guidance.
It admits only stable repository conventions, enduring preferences, and
continuing decisions whose rationale is absent from a durable, authoritative,
cheaply queryable source, then chooses repository, attached-domain, or
universal placement. Temporary state remains in its source system. The policy
does not auto-classify content, scan secrets, or guarantee compliance. It is
not a compliance guarantee and it does not create or attach domains.

Runtime validation is separate. The CLI and server validate repository IDs,
domain registration, current-repository attachment, exact placements, and
operation fingerprints. Namespace selection is separate again: `--domain`,
`--universal`, and the default visible stack select where a memory is read or
written. Authorization is only the remote bearer-token gate described above.

## Schema and data loss

Read [SCHEMA-VERSIONING.md](docs/SCHEMA-VERSIONING.md) before opening a store
created by an earlier build. The exact registered schema `1.0` is bridged to
`2.0` without rebuilding core tables or changing memory IDs and placements.
Pre-versioned, unknown, malformed, and unsupported schemas are refused without
reset. Back up with SQLite's backup API or another WAL-aware method before a
legacy upgrade. The v0.1.0 and v0.0.10 binaries cannot open schema `2.0`; changing
software versions does not restore data. Never restore an older backup over
newer schema `2.0` data.

## Compare

| Project | How it remembers | Hosts |
| --- | --- | --- |
| ClawHub memocap | value-store + recall-first | OpenClaw |
| claude-mem | auto-captures sessions | Claude |
| agentmemory | auto-captures via MCP | multi-host MCP |
| pi-memory | markdown files | Pi |
| this repo | value-store + recall-first | OpenCode, local SQLite or one-token server |

## Source deployment

For a source checkout used by the Compose deployment:

```sh
git clone https://github.com/LYY/memocap
```
