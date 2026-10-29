# Schema Versioning Contract

This document defines the current SQLite lifecycle contract for package
`0.5.0`. Package `0.5.0`, database schema `2.2`, setup manifest format `2`, and receipt
`format_version: 1` are independent identities. This contract does not claim
that the package has been published.

## Main Database

`schema_metadata` is the single schema-version source. One main SQLite database
stores memories and placements, activity events, and repository metadata and
hints. The active schema does not use a separate `.activity.sqlite` database.

Schema `2.2` retains nullable `memories.organized_at` with default `NULL`, introduced in schema `2.1`. A null
value means the record is pending organization. A non-null value records a
successful organization action. New records and copies start with `NULL`; moves
and ordinary content edits preserve the existing value. The organization
workflow is described in the [runtime guide](../skills/memocap/references/memory-organization.md).
Schema validation requires the column with its nullable `TEXT` shape and
`NULL` default. A missing or incompatible column is rejected; it is never
synthesized during inspection or treated as an implicit `NULL` field.

Schema `2.2` adds `repository_identities` and `repository_locations`.
Identity rows use the existing full repository ID as their primary key and store
`display_name`, `name_source`, `origin`, nullable `normalized_remote`, and
`recorded_at`. Locations use `(repository_id, canonical_path)` as their primary
key and store `observed_at` and `source`. Neither table introduces a foreign key
requirement for memories. A location may exist without an identity row.

Identity is optional descriptive metadata, never an addressing key. Names and
remotes may repeat across IDs without merging them. First recorded names and
their sources remain stable; later known descriptors can fill missing optional
metadata. Locations are observations, not proof that a path exists or is
accessible. Missing identity, locations, or paths never invalidates memory.
Reads return `repository_context` keyed by the operation's full repository IDs,
with `identity: null` and `locations: []` where unknown, without probing paths.

A known descriptor is persisted atomically with its corresponding core memory
mutation. ID-only writes create no empty identity row. Delete-only actions do
not create identity or locations. Location observations are best-effort after
core commit; failure produces a warning and never replays the memory mutation.
Descriptors and locations do not change placements, operation fingerprints,
organization snapshots, replay behavior, or authorized targets.

An old `.activity.sqlite` file is outside the main database lifecycle. Normal
preparation does not open, import, rewrite, or delete it, and its history does
not appear in current queries. Its presence or corruption does not affect the
main database. There is no blanket cleanup action.

## Opening and Inspection

Read-write preparation creates a missing database directly at schema `2.2`.
It upgrades only an exact supported schema `2.1`, as specified below.

`memocap status --read-only --json` inspects without running lifecycle
transitions. Its successful format-1 receipt reports:

- A missing main database as `core_status: not_initialized` with null schema
  version and visibility.
- An exact schema `2.1` as `core_status: upgrade_needed` with version `2.1`; it
  does not perform migration.
- A valid schema `2.2` as `core_status: ready` with the actual schema version
  and visible-stack status.

Schemas `2.0` and `1.0`, pre-versioned databases, unknown or future versions, malformed
metadata or required structures, and corrupt databases fail without reset.
Consumers should use exit status and structured receipt fields, not error prose.

`memocap status --read-only` and setup `doctor` do not initialize or migrate a
main database, prune retained activity, or write activity or repository hints.
`memocap activity list/show` use SQLite read-only connections; they do not
prepare the database and may fail when activity tables are absent. Ordinary
memory commands such as `memocap list` use read-write access and can initialize
a missing database or upgrade exact schema `2.1`. SQLite read-only connections
may still coordinate WAL/SHM sidecars; this logical read-only contract does not
promise zero filesystem-level activity. A WAL-backed database can be inspected
without an owner-generated snapshot.

`memocap activity prepare --json` explicitly prepares the local main database.
It creates schema `2.2` or upgrades exact schema `2.1`, then prepares activity
retention. Preparation can prune retained events. Remote preparation is not
available to a client; a server administrator runs it locally against the
server's configured main database.

## The 2.1 to 2.2 Upgrade

The only supported migration is exact schema `2.1` to `2.2`. It
creates the identity and location tables empty, advances
`schema_metadata`, and validates the resulting schema in one transaction. It
does not rebuild or reset core tables. Existing memory rows and IDs, content,
placements, type, tags, topics, timestamps, organization state, domains and
attachments, provenance, operation history, activity, FTS data, required
triggers, extensions, and old repository metadata/hints remain intact. Migration
does not read, transform, promote, or delete old hints; normal runtime does not
use them as a fallback for missing identity.

Preparation enables foreign keys, starts `BEGIN IMMEDIATE`, and re-reads the
schema while holding the write lock. The migration and target validation commit
atomically. Failure rolls back the transaction. A competing opener rechecks the
committed state instead of repeating the upgrade. A busy or lock failure is
reported, never treated as a reset. Repeating preparation on valid schema `2.2`
does not reapply the migration.

Schemas `2.0` and `1.0` are not upgraded directly or through an intermediate schema. A
pre-versioned, malformed, unknown, future, different-major, or otherwise
unsupported schema is refused without changing its rows or schema. There is no
automatic reset, rebuild, export/import, or fallback migration.

Managed setup accepts the actual immediate-prior 0.4.0 CLI's `ready`/`2.1`
receipt during local preflight before upgrading the package. This is not target
readiness: success requires the selected 0.5.0 CLI and an independent
`ready`/`2.2` status readback with activity ready after authorized preparation.
The 0.5.0 CLI reports `upgrade_needed`/`2.1` until preparation completes.

## Organization Lifecycle

Organization is local-only. A configured remote target is rejected before local
or network access; the feature does not change existing remote operations or
add a network protocol.

Organization page and read operations require an existing validated schema
`2.2`. They do not initialize or migrate the database, write repository hints or
activity, or prune retained rows. Schema `2.1` reports `upgrade_required` and is
not prepared by organization. Applying a confirmed group opens the existing
validated `2.2` database and uses `BEGIN IMMEDIATE` to compare every participant
and read-only dependency against its exact snapshot before writing.

Each group commits or rolls back as one transaction. Keep changes only
`organized_at`; refine changes content, `updated_at`, and `organized_at`; merge
updates the same-placement survivor and deletes its sources; delete removes the
target row. Explicit column updates preserve the survivor's ID, placement,
type, tags, topic, creation time, provenance, and existing extensions. Pending
mode accepts only records whose `organized_at` is null. A snapshot conflict,
mode violation, or database error rolls back the entire group; previously
committed groups remain committed. Organization creates no activity or history
event.

The caller independently reads every participant after apply to verify both
survivors and deletions. An uncertain response or readback is reported as
unknown and is never automatically replayed. Absence alone does not prove that
a write did not commit.

## Activity and Recovery

Activity is retained operational metadata, not a complete audit log. Recall and
injection events are bounded to 30 days and 10,000 events; write metadata is
bounded to 1,000 events. Expiry, pruning, or recording failure can leave gaps.
Activity writes and explicit preparation may prune; ordinary core opens and
read-only inspection do not.

Core mutations commit before optional activity or repository-hint recording.
If recording fails, the core result remains successful and the activity warning
is reported separately. Never replay a committed memory operation to create a
history entry. Inventory counts come from core rows, not activity history.

Before upgrading schema `2.1`, make a backup with SQLite's backup API or another
WAL-aware method. A raw file copy while WAL is active can omit committed data.
A software version change is not backup restoration; never restore an older
backup over newer data. Backup selection and restore are separate, explicit
operations.

Historical semantic enrichment is planned only after publishing and installing
0.5.0 locally. First use normal interfaces and explicitly confirmed paths whose
resolved IDs match the existing scopes. If those interfaces are insufficient,
propose one controlled operation with a concrete reviewable change list. This
contract introduces no automatic filesystem scan, persistent backfill command,
or backfill skill, and infers no identity from memory prose or old hints.

## Compatibility Boundary

Only schema `2.2` and the exact `2.1` to `2.2` upgrade are covered here. This
document makes no promise about opening schema `2.2` with older binaries or
reading future minor versions. Read [ADR-0001](adr/0001-single-database-compatible-evolution.md)
for the decision history and current scope.
