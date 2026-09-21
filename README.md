[中文](README-CN.md)

# memocap

memocap is a local-first SQLite memory sidecar for OpenCode. It stores explicit
memories in repository, attached-domain, or universal placements, then recalls
them through one ordered visible stack.

OpenCode is the only officially supported integration. The plugin invokes `memocap` as its sidecar and uses the global CLI. Database lifecycle behavior is defined by
the [schema versioning contract](docs/SCHEMA-VERSIONING.md). Deployment and
remote operation are documented in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Install

Install the global CLI first, then register the OpenCode plugin:

```sh
pnpm add -g @lyy-gh/memocap@0.0.6
opencode plugin @lyy-gh/memocap
```

The global CLI must be on PATH (`PATH`). The plugin invokes `memocap` as its sidecar,
does not open another store, and does not provide a separate host integration.

## Command matrix

The following matrix is the current CLI surface. Placement selectors are
mutually exclusive. `<PLACEMENT>` is `repository:<64 lowercase hex>`,
`domain:<DOMAIN>`, or `universal`.

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--domain <DOMAIN> | --universal] <QUERY>
memocap list [--limit <LIMIT>] [--domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
memocap scope domain create <DOMAIN>
memocap scope domain attach <DOMAIN> [--before <DOMAIN>]
memocap scope domain detach <DOMAIN>
memocap scope domain list [--all]
memocap scope domain delete <DOMAIN>
memocap scope copy --id <ID> --from <PLACEMENT> --to <PLACEMENT> [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap scope move --id <ID> --from <PLACEMENT> --to <PLACEMENT> --yes [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap operation status --recovery <RECOVERY>
memocap status
memocap serve [--bind <BIND>]
memocap ui
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

Removed surfaces are removed, not deprecated. The removed CLI surface includes
`memocap install`, `memocap uninstall`, `--global`, and legacy global or scope
syntax. The removed TUI surface includes write, delete, and legacy menu actions.
The TUI now exposes only `Status`, `List visible memories`, and `Exit`. Codex,
Claude Code, and Pi host adapters and host path state are removed. Legacy
unversioned HTTP routes are removed. They are not compatibility or deprecation
paths. Legacy unversioned HTTP routes are removed.

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

The stack is repository, then attached domains in persisted order, then universal.

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

Remote `scope show` reads `/v1/status` and displays the remote repository's
attached domains and visible-stack counts. See [DEPLOYMENT.md](docs/DEPLOYMENT.md)
for the route list, trust boundary, Compose setup, and recovery procedure.
Remote requests carry a valid remote scope ID, and the server strictly validates
that ID.

When a remote copy or move response is lost, use the issued recovery handle with
`memocap operation status --recovery <RECOVERY>`. `not_found` alone does not prove manual replay is safe, and the operation may remain unknown. Do not
manually replay a lost request from a bare `not_found` result.

## Policy boundaries

The OpenCode skill's least-sharing policy is model guidance. It asks the model
to reject unsafe candidates, choose repository or attached-domain placement,
use universal only for stable cross-domain knowledge, split mixed candidates,
and use repository placement when uncertain. It does not auto-classify content, scan secrets, or guarantee compliance. It is not a compliance guarantee and it does not create or attach domains.

Runtime validation is separate. The CLI and server validate repository IDs,
domain registration, current-repository attachment, exact placements, and
operation fingerprints. Namespace selection is separate again: `--domain`,
`--universal`, and the default visible stack select where a memory is read or
written. Authorization is only the remote bearer-token gate described above.

## Schema and data loss

Read `SCHEMA-VERSIONING.md` before opening a store
created by an earlier build. The sole no-confirmation bulk-delete exception is
an exact recognized pre-versioned schema. Its transaction deletes all old
memory rows, creates schema `1.0`, makes no backup, and prints the required
reset notice. Unknown or incompatible schemas refuse without mutation. There is
no user-facing reset command.

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
