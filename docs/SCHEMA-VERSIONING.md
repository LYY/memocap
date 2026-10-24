# Schema Versioning Contract

This document defines the SQLite lifecycle contract implemented for package
0.2.0. It does not claim that the package has been published.
Package target `0.2.0`, database schema `2.0`, and receipt `format_version: 1`
are independent identities.

## Main Database

`schema_metadata` is the single schema-version source. One main SQLite database
stores core memories and placements, activity events, and repository metadata
and hints. Activity access uses the configured main database path; the active
schema does not use a separate `.activity.sqlite` database.

An old `.activity.sqlite` file is not part of the main database transition.
Generic preparation does not open, import, rewrite, or delete it, and its old
history does not appear in current activity queries. Its presence or corruption
does not block the main database bridge. There is no blanket cleanup action.

The strict `0.0.10` and `0.1.0` binaries cannot open schema `2.0`. Changing the
binary version does not downgrade a database or restore data. There is no
standalone reset command, and pre-versioned databases are refused without reset.

## Opening and Inspection

Schema preparation runs when a read-write connection opens the main database.
The first read-write open of a missing database creates the schema `2.0`
baseline; an exact registered `1.0` database uses the bridge below.

`memocap status --read-only --json` inspects without running those lifecycle
transitions. Its successful format-1 receipt reports:

- A missing main database returns `core_status: not_initialized` with null
  schema version and visibility.
- An exact registered schema `1.0` returns `core_status: upgrade_needed` and
  version `1.0`, leaves visibility null, and skips schema-2-dependent queries.
- A valid schema `2.n` returns `core_status: ready` and the actual schema
  version, then reports the existing visible-stack status.

Unknown major versions, unsupported schema versions, malformed metadata or
known structures, pre-versioned databases, and corrupt main databases fail
without reset. Consumers should use exit status and structured receipt fields,
not error prose.

`memocap status --read-only` and setup `doctor` do not initialize or migrate a
missing or legacy main database, prune retained activity, or write activity or
repository hints. `memocap activity list/show` also use SQLite read-only
connections; they do not prepare the database and may fail when its activity
tables are absent. Ordinary memory commands such as `memocap list` use a
read-write main-database open and can initialize a missing database or bridge
the registered schema `1.0`. SQLite read-only connections may still coordinate
WAL/SHM sidecars; this logical read-only contract does not promise zero
filesystem-level activity. A WAL-backed database can be inspected without an
owner-generated snapshot.

`memocap activity prepare --json` is an explicit local preparation operation.
It creates a missing main schema or bridges exact schema `1.0`, then prepares
activity retention. Preparation can prune retained events. Remote preparation
is not available to a client; a server administrator runs it locally against
the server's configured main database.

## Registered 1.0 Bridge

The only registered migration is the precise legacy schema `1.0` to baseline
`2.0`. It adds the activity event table and retention index plus repository
metadata, and advances `schema_metadata`. It does not rebuild, reset, export, or
import core tables. It preserves memory rows and IDs, placements, domains and
attachments, provenance, the operation ledger, FTS data, and its required
triggers.

Preparation enables foreign keys, starts `BEGIN IMMEDIATE`, and re-reads the
schema while holding the write lock. The registered DDL, version update, and
target validation commit in one transaction. Failure rolls the transaction
back. A competing opener rechecks the committed state; a busy or lock failure
is reported rather than treated as a reset. Repeating preparation on a valid
schema `2.n` database does not downgrade or reapply the bridge.

Only the exact registered legacy `1.0` shape is bridgeable. Pre-versioned,
malformed, unknown, different-major, and other unsupported schema versions are
refused without changing their rows or schema. A user-requested memory deletion
continues to require its explicit target ID and placement.

## Bounded 2.x Compatibility

Schema `2.0` is the new compatibility baseline. A higher `2.n` version opens
only when all baseline-required structures remain compatible. Validation checks
known columns and constraints, foreign keys, required indexes, FTS objects and
triggers, and database integrity. Changed or missing required objects and
tightened known constraints are rejected.

Compatible higher-minor databases preserve additional tables and their values,
plain additional columns, non-unique indexes, and compatible triggers. An added
column must allow existing writes and copies to omit it: it is nullable or has
a compatible non-null default. Additional unique indexes and constrained or
otherwise incompatible added columns are rejected. This is a bounded publisher
compatibility contract, not support for arbitrary handwritten schema changes.
Unknown trigger semantics are trusted only for supported same-major publishers.

Stored activity phases and payloads use closed enums and deny unknown fields.
Future supported `2.n` publishers must keep baseline event decoders able to read
existing stored payloads. Arbitrary activity JSON evolution is not guaranteed.

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

Before bridging, make a backup with SQLite's backup API or another WAL-aware
method. A raw file copy while WAL is active can omit committed data. A software
downgrade is not backup restoration; never restore an older backup over newer
schema `2.0` data. Backup selection and restore are separate, explicit
operations.
