[中文](README-CN.md)

# memocap

memocap is a local-first SQLite memory sidecar for OpenCode. It stores explicit
memories in repository, attached-domain, or universal placements, then recalls
them across the authorized personal library. A selected repository provides task
context and the default write origin, not a boundary for library recall.

OpenCode is the only officially supported integration. The plugin invokes its
package's absolute bundled CLI launcher and verifies the native version; it does
not resolve an unrelated `memocap` from global PATH. Database lifecycle behavior is defined by
the [schema versioning contract](docs/SCHEMA-VERSIONING.md). Deployment and
remote operation are documented in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Install

Install the v0.6.0 CLI, OpenCode plugin, and runtime skill for your user:

```sh
npx --yes --package @lyy-gh/memocap@0.6.0 memocap-setup install --global --yes --json
```

Requires Node.js 22.20 or later, npm/npx, and OpenCode 1.19.3 or 1.19.5. The
plugin SDK is pinned to 1.19.3. The package contains the complete skill and its
references. Setup copies it into the selected
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
directory; repeat it for recall or `scope resolve`, up to eight targets. Alternatively use
`--repository-id <ID>` for explicit ID-only selection, mutually exclusive with
`--repo`. Writes have one target. Global `--json` returns a format-1 receipt for automation; it is not
supported by `serve` or `ui`. Package `0.6.0`, core schema `2.3`, and receipt
format `1` are independent identities.

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--match all|any] [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--library | --placement <PLACEMENT>...] [--domain <DOMAIN> | --universal] <QUERY>
memocap read <ID> --placement <PLACEMENT>
memocap list [--limit <LIMIT>] [--offset <OFFSET>] [--placement <PLACEMENT> | --domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
memocap scope resolve --json
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
searches the whole personal library by default; `--library` states that scope
explicitly. Repeat `--placement` to search only the exact listed origins, or use
`--domain` or `--universal` for one exact origin. These filters are mutually
exclusive and are never widened. Repository targets provide context and the
default write origin, not a library-read boundary. By contrast, `list` without a
selector uses the current visible stack. `forget` always targets one exact
placement, with the repository as its default.

Installation uses the separate `memocap-setup` executable; its `--global` selects
integration scope, not universal memory. Old `memocap install/uninstall`, legacy
scope syntax, other host adapters, TUI write/delete actions, and unversioned
HTTP routes remain removed.

## Recall, full reads, and permissions

Native `memocap recall` searches the whole personal library by default, including
repository, domain, and universal placements. In local mode this is the local
database; in remote mode it is the configured server's library. `--repo` and
`--repository-id` select repository context and the default write origin; they do
not narrow this default read. Use `--library` to state the broad scope explicitly,
or repeat `--placement` to limit search to exact origins. `--domain` and
`--universal` are exact single-origin filters and cannot be combined with each
other or with the other recall filters. An explicit filter is never silently
replaced with a broader search.

The OpenCode plugin also defaults to the whole authorized library. Its installer
adds persistent grants for exactly these library permissions:

```json
{
  "permission": {
    "memocap_recall": { "library": "allow" },
    "memocap_read": { "library": "allow" }
  }
}
```

Each plugin operation still checks the active agent and parent session's
effective host permission. A deny blocks access; an ask uses OpenCode's native
permission prompt, and a declined ask blocks access. The persistent grants do
not override a conflicting effective permission. Direct local CLI access follows
the operating-system account's file permissions. Remote CLI access has its
separate shared bearer-token gate. Placements and repository IDs select context
or data origins; they are not authorization rules. Permission to read a memory
does not grant permission to open its source files.

Use `memocap read <ID> --placement <PLACEMENT>` or the plugin's
`memocap_read` tool to read one complete, current body by exact ID and origin.
Plugin recall injects at most three references within a total 6,000-character
budget. Each reference is marked `full` or `partial` and carries the hash of the
full source plus an exact `memocap_read` route. Read a `partial` reference in full
before using it as operational guidance; if the hash changed, rely on the current
body and report the change. Native `--max-chars` keeps only a relevance-ordered
prefix of complete records. If the next body, including the first, does not fit,
it and later bodies are omitted.

Long plugin queries reserve room for distinctive path, version, and name anchors
instead of blindly keeping only the first common terms. CJK recall uses bounded
overlapping lexical fragments against current memory text. This is lexical
retrieval, not semantic ranking; semantic ranking is not part of this build.

## Receipts, inventory, and activity

Native recall defaults to `--match all`; `any` matches at least one normalized
term. Plugin recall uses `any`. Results are ranked across the authorized search
scope before result-count and body-size budgets are applied, rather than being
promoted by placement order. Sharing a topic across origins does not automatically
replace or suppress another record. A source origin alone does not prove
applicability; when applicability is unknown, preserve that uncertainty and
check current authoritative information before acting. Verify linked source
documentation before execution; a source pointer grants no file access. Receipts expose targets,
discovery, searched placements, query terms, matched/returned IDs, completeness,
truncation, errors, and activity outcome. A successful current-request plugin
receipt, including a valid empty or cached result, satisfies recall-first without
repeating the same query.

Inventory is separate from default recall. `memocap list`, TUI List, and the
visible-source counts in `status` retain the current visible-stack labels and
topic visibility. Use `scope list --all` for an intentional full
placement inventory, then
`list --placement <PLACEMENT> --limit 20 --offset 0` for exact paged rows.
`status --read-only --json` checks core and activity compatibility without
logical writes: it does not write data or schema, initialize or migrate the main
database, prune history, or record activity. Ordinary memory commands such as
`memocap list` use a read-write open and can initialize a missing database or
upgrade an exact schema `2.2` to `2.3`. `activity list/show` use read-only access and do
not prepare the database. SQLite `READ_ONLY` connections may still coordinate
WAL/SHM sidecars; ordinary WAL inspection needs no owner snapshot.
`activity prepare` explicitly prepares the local main database, creating schema
`2.3` or upgrading the exact supported `2.2` schema. Preparation can prune
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

The plugin exposes `memocap_recall`, `memocap_read`, `memocap_remember`,
`memocap_scope`, and `memocap_organize` tools. `/memory status`, `/memory recall`, `/memory scope <PATH...>`,
`/memory scopes`, `/memory list`, `/memory recent`, and `/memory why` make the
session's target and recall receipt inspectable. Prepared input is not proof of
model understanding or adoption. See the [runtime skill](skills/memocap/SKILL.md)
for permission and explicit target-switching policy.

`memocap_scope` accepts either `paths` or `repository_ids`, with host permission
for each explicit target. The selected repository ID stays fixed through
recall, list, remember, and readback even if its checkout later disappears. This
frozen context does not restrict default whole-library recall.

## Automatic capture

After a normally completed user request, the plugin may run one bounded review
and save at most one concise, evidence-backed memory. You do not need to say
“remember” on every turn, and no write is required on any particular turn.
Useful candidates include durable preferences or decisions and concise routes
from a task through its tool or service/environment to a repository entry. A route can be useful
even when detailed documentation exists; capture the conditions and source
pointer, not a copy of the runbook. Secrets, transient state, unsupported
assistant conclusions, and unverified outcomes are not suitable candidates.

The review uses at most two isolated child sessions, three generation dispatches,
and one native write attempt. It is deliberately bounded and conservative, so it
can skip useful information; it does not verify every natural-language fact or
promise complete capture or a quality score. The lifecycle can fail closed on a
repeated or ambiguous idle event and skip a valid capture. Before writing, a newly
observed real input, busy/retry or error, session deletion, worker error/abort, or
timeout invalidates the old review. Once writing starts, the tool callback and
independent readback must finish; a cancel signal alone does not prove the write
stopped. A denied host permission is
terminal, with no CLI or shell bypass. If the write result is unknown, read first
and never replay it. `/memory status` and `/memory why` expose capture status,
reason, call and attempt counts, and relevant IDs without exposing candidate
content. Automatic capture does not assign a topic, force a write, overwrite an
existing ID, or merge records. See the [capture implementation note](docs/OPENCODE-CAPTURE-IMPLEMENTATION.md)
for current eligibility rules and exact limits.

## Memory organization

Use `/memory organize` to review saved memories. It defaults to all unorganized
records across placements, including shadowed records. `/memory organize --all`
or `/memory organize -a` also includes previously organized records. `/memory help`
shows the available command forms without opening the database.
Use `/memory organize --help` or `/memory organize -h` for the full organization
usage. An empty pending scan reports that there are no unorganized memories and
suggests `-a`; it never starts another scan automatically.

Organization is a local-only feature. When remote mode is configured, the
organization request is refused; it does not fall back to local storage or add
remote organization support. Other supported remote operations are unchanged.
Organization reads and paginates the complete candidate set before reporting a
completed scan. It previews each exact ID, placement, original content, proposed
action, replacement content, rationale, evidence, and scope. No memory changes
until the user confirms a concrete group and the permission-aware organization
tool authorizes it. Changes apply one group at a time and are read back after
commit. Conflicts require a new review. An uncertain write is read before any
further action and is never replayed to verify it.

Keep, refine, and same-placement merge mark surviving records organized only
after the confirmed transaction commits. Delete removes the record. Declined,
failed, conflicted, or evidence-pending records remain unchanged. New memories
and copies start unorganized; moves and ordinary edits preserve organization
state. `--all` only widens the review set. The full workflow and decision rules
are in the on-demand [memory organization guide](skills/memocap/references/memory-organization.md).

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

Schema `2.3` retains optional identity descriptions and location observations
separately from the ID. Returned `repository_context` is keyed by full repository
ID; an unknown description is `identity: null` and missing locations are `[]`.
Names and remotes can repeat without merging identities. Observations never
prove a path still exists and are never scanned during context reads. A missing
description or checkout does not invalidate repository memory:

```sh
memocap --repository-id 'repository:<64 lowercase hex>' recall 'project convention' --json
```

`scope resolve --json` resolves only the explicit path or ID for permission
checks without opening storage or writing Git. Targets stay frozen throughout
each call; descriptions and locations never widen them. The selected repository
is context and a default write origin, not a boundary for default library recall.
Accessing source files still requires a valid path and permission. Historical enrichment is a separate,
confirmed one-time plan after publication and local installation, using normal
interfaces where sufficient.

The visible stack used by inventory and visibility reporting is ordered as
follows:

1. Current repository.
2. Attached domains, in their persisted attachment order.
3. Universal memory.

This ordering does not constrain default recall, which searches the whole
authorized library and ranks results before budgets. `list` and TUI List retain
addressable records and annotate their current topic/replacement visibility.
`status` reports addressable and effective counts for every source and in total.
Topic labels can affect these inventory annotations; recall does not use those
annotations to suppress candidates.

`--topic` labels a record within its placement. Updating an existing record
requires its explicit `--id`; a topic alone does not replace its content. A shared
topic across placements does not copy or delete records or suppress them in recall.

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

Current JSON operations check the server version through `/v1/capabilities`,
then use `/v1/receipt`. CLI and server must match version 0.6.0 before mutation;
there is no old-request fallback or new capability negotiation. See [DEPLOYMENT.md](docs/DEPLOYMENT.md)
for the route list, trust boundary, Compose setup, and recovery procedure.
Remote requests carry a valid remote scope ID, and the server strictly validates
that ID.

When a remote copy or move response is lost, use the issued recovery handle with
`memocap operation status --recovery <RECOVERY>`. `not_found` alone does not prove manual replay is safe, and the operation may remain unknown. Do not
manually replay a lost request from a bare `not_found` result.

## Policy boundaries

The OpenCode skill's memory-admission and least-sharing policy is model guidance.
It favors reusable conventions, enduring preferences, continuing decisions,
and concise evidence-backed routes that reduce future lookup, including when
detailed documentation exists. Preserve conditions and a source pointer rather
than copying a runbook. Temporary state remains in its source system, and
placement is the narrowest scope that supports intended reuse. Admission and
duplicate checks are conservative and may miss useful or equivalent knowledge;
they do not establish natural-language truth or guarantee comprehensive capture.
The policy does not promise complete classification, scan all secrets, guarantee
compliance, or create or attach domains.

Runtime validation is separate. The CLI and server validate repository IDs,
domain registration, current-repository attachment, exact placements, and
operation fingerprints. Local CLI access follows the invoking operating-system
account. OpenCode plugin reads also require the explicit persistent library
grants and active host permission described above. Remote requests have a
separate shared bearer-token gate. Placement and domain selection choose data
origins, not authorization.

## Schema and data loss

Read [SCHEMA-VERSIONING.md](docs/SCHEMA-VERSIONING.md) before opening a store
created by an earlier build. New databases use schema `2.3`; only the exact
supported schema `2.2` upgrades to `2.3`, rebuilding only the activity table and
its required index without changing memory IDs or placements. Schemas `2.1`, `2.0` and `1.0`, pre-versioned, unknown, future,
and malformed databases are refused without reset. Back up with SQLite's backup
API or another WAL-aware method before the `2.2` upgrade. Changing package
versions does not change or restore database data. Never restore an older backup
over newer data. Package `0.6.0`, schema `2.3`, and receipt format `1` are
independent identities.

## Compare

| Project | How it remembers | Hosts |
| --- | --- | --- |
| ClawHub memocap | value-store + recall-first | OpenClaw |
| claude-mem | auto-captures sessions | Claude |
| agentmemory | auto-captures via MCP | multi-host MCP |
| pi-memory | markdown files | Pi |
| this repo | bounded evidence-based capture + whole-library recall | OpenCode, local SQLite or one-token server |

## Source deployment

For a source checkout used by the Compose deployment:

```sh
git clone https://github.com/LYY/memocap
```
