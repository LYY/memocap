# Schema Versioning Contract

This document is the authority for SQLite schema lifecycle behavior. Package
release identity and database schema identity are independent.

Package release `0.1.0` does not make the database schema `1.0` become
`0.1.0`. The current schema policy remains `1.0` for every package release that
uses this contract.

The v0.1.0 upgrade preserves the existing complete core schema fingerprint,
including schema metadata and transfer provenance/ledger tables. Compatible
core data is retained and remains usable by the v0.0.10 binary. Returning to
that binary does not restore a database backup and does not provide new receipt
or activity features. Receipt `format_version: 1`, package `0.1.0`, and core
schema `1.0` are separate identities.

## Opening Commands

Schema handling occurs when a local command opens the SQLite database. These
commands are representative entry points:

```text
memocap remember <CONTENT>
memocap recall <QUERY>
memocap list
memocap status
```

There is no standalone schema reset command. Automatic reset is allowed only
when opening an exact recognized pre-versioned database. It is the sole
approved no-confirmation bulk-delete exception.

`memocap status --read-only --json` uses the inspection path instead: it reports
an absent core as `not_initialized`, opens an existing supported core without
running lifecycle transitions, and rejects unknown/corrupt/future core data.
It makes no logical writes to the core or activity store: it does not write data
or schema, initialize or reset the core, migrate schema, prune history, or record
activity. Both stores are inspected through SQLite `READ_ONLY` connections.
SQLite may still coordinate WAL/SHM sidecars during inspection. A WAL-backed
store can be inspected directly without an owner-generated snapshot; this
logical read-only contract does not promise zero filesystem-level activity from
SQLite's ordinary WAL handling.

## Policy Matrix

The following JSON object summarizes the documented lifecycle. Runtime code
does not consume this documentation as configuration.

```json
{
  "contract": "memocap-schema-versioning",
  "schema_version": "1.0",
  "package_version": {
    "example": "0.1.0",
    "manifest_unchanged": false
  },
  "commands": {
    "open": [
      "memocap remember <CONTENT>",
      "memocap recall <QUERY>",
      "memocap list",
      "memocap status"
    ],
    "reset": "automatic only when opening an exact recognized pre-versioned database; no standalone reset command"
  },
  "states": [
    {
      "id": "fresh",
      "action": "create current schema 1.0",
      "data_outcome": "database starts empty",
      "notice": "none"
    },
    {
      "id": "exact_pre_versioned",
      "action": "reset transactionally to current schema 1.0",
      "data_outcome": "all pre-versioned memory rows are deleted; no backup is made",
      "notice": "memocap: reset recognized pre-versioned database to schema 1.0"
    },
    {
      "id": "unknown_pre_versioned",
      "action": "refuse without mutation",
      "data_outcome": "existing database remains unchanged",
      "notice": "error"
    },
    {
      "id": "exact_current",
      "action": "open",
      "data_outcome": "rows remain unchanged",
      "notice": "none"
    },
    {
      "id": "lower_minor",
      "action": "run registered lower-minor migrations transactionally",
      "data_outcome": "registered migrations determine row changes",
      "notice": "none unless migration fails"
    },
    {
      "id": "higher_minor",
      "action": "refuse without mutation",
      "data_outcome": "rows and schema remain unchanged",
      "notice": "error"
    },
    {
      "id": "different_major",
      "action": "refuse without mutation",
      "data_outcome": "rows and schema remain unchanged",
      "notice": "error"
    }
  ],
  "reset_exception": {
    "sole_approved_no_confirmation_bulk_delete_exception": true,
    "recognition": "exact pre-versioned schema fingerprint; SQLite internal names are excluded only when their names literally match sqlite_*",
    "transaction": "immediate transaction; rollback on failure",
    "backup": "none",
    "notice": "memocap: reset recognized pre-versioned database to schema 1.0"
  }
}
```

## Recognition And Data Loss

The pre-versioned reset requires an exact schema fingerprint. A database that
merely resembles the old shape is unknown and must be refused without
mutation. Recognition compares the complete known schema, including tables,
triggers, the FTS virtual table, and its non-internal schema entries. SQLite
internal names are excluded only by the literal `sqlite_*` name rule. A name
such as `sqliteXunexpected` is not an internal name for this purpose and must
prevent recognition.

When the exact fingerprint matches, the reset runs inside an immediate SQLite
transaction. The old memory rows are deleted, the current schema `1.0` is
created, and the transaction commits only after creation succeeds. A failure
rolls back the reset. No backup is created. The stderr notice in the policy
matrix is the required disclosure of this data-loss action.

Unknown schema shapes, malformed metadata, higher minor versions, and
different major versions refuse without changing rows or schema. A lower minor
version may be migrated only through registered migrations, in order and inside
a transaction. A migration failure rolls back.

This policy does not authorize a user-facing bulk delete. Normal memory deletion
still requires the existing explicit deletion command and its target ID.

## Auxiliary Activity Store

Operational metadata is stored separately at `<core filename>.activity.sqlite`
(normally `~/.memocap/memocap.db.activity.sqlite`). Its own marker/schema is
independent of the core; it must not add tables, triggers, or metadata to the
core fingerprint. `memocap activity prepare --json` explicitly creates or
validates local auxiliary storage without initializing the core. Server-side
preparation belongs to the server administrator; remote clients cannot prepare
it through the receipt endpoint.

Unknown, incompatible, or corrupt auxiliary stores fail explicitly without
automatic reset. A core operation that already succeeded remains successful
when auxiliary recording fails, with `activity_status: failed` and a warning.
Do not replay the memory operation to repair the history. Inventory counts are
computed from core rows, not from activity events.

Recall/injection events have a 30-day and 10,000-event retention bound. Write
metadata has a separate 1,000-event bound. Reads exclude expired read events;
write-time pruning enforces the physical bounds. History is not a full audit:
`not_found_or_expired` cannot distinguish expiry, pruning, or missing recording,
and a process failure after core commit can leave a gap. Preparation, uninstall,
and software rollback do not restore or erase core memory. Back up and restore
data only through a separately chosen WAL-aware procedure.
