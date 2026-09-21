# Schema Versioning Contract

This document is the authority for SQLite schema lifecycle behavior. Package
release identity and database schema identity are independent.

Package release `0.0.6` does not make the database schema `1.0` become
`0.0.6`. The current schema policy remains `1.0` for every package release that
uses this contract.

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

## Policy Matrix

The following JSON object is machine-parseable and is part of this contract.

```json
{
  "contract": "memocap-schema-versioning",
  "schema_version": "1.0",
  "package_version": {
    "example": "0.0.6",
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
