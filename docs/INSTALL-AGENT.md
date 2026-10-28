# Agent Install and Update Guide

Use this guide only when the user has authorized a memocap installation or
update. It covers package target `0.3.0` and tag target `v0.3.0`. Keep the CLI,
plugin, and runtime skill on one release. For the human-facing explanation, see
[Install and Update](INSTALL.md).

## Authorization boundary

Confirm the requested scope before writing anything:

- Global means this user's OpenCode integration and CLI.
- Project means one explicit absolute project path.
- Memory placement is separate. A global install does not select universal
  memory, and a project install does not authorize reading or writing memories.

`--yes` skips installer prompts within the requested scope. It does not grant
permission to upgrade OpenCode, overwrite user edits, touch other projects or
agents, alter a database, or work around a denied tool permission. If the user
has not selected global or a concrete project path, ask before installing.

## Preflight

Use read-only checks before choosing a command:

```sh
node --version
npm --version
opencode --version
```

Require Node.js 22.20 or later and OpenCode 1.19.3. The setup command does not
install or upgrade OpenCode, Node.js, or Git. Git is not required for the
package-managed skill copy. If OpenCode is absent or has an unsupported version,
report that and ask for authorization before changing it.
The version-pinned host install, when authorized, is documented in the
[user guide](INSTALL.md#requirements).

## Starting from the skill alone

An installed skill provides policy and guide links, not the CLI or OpenCode
plugin. If the user authorized the full integration, bootstrap it with the
version-pinned setup runner instead of assuming `memocap` or `memocap-setup` is
already installed:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --global --yes --json
```

For project scope, use the same command with
`--project "/absolute/path/to/repo"` instead of `--global`. If the user's
authorization covered only the skill, stop after the skill installation and
report that the runtime integration is not installed. The standalone skill path
is optional and separate; see [the user guide](INSTALL.md#optional-standalone-skill-for-another-agent).

## Install

For a new global install:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --global --yes --json
```

For a project install, substitute the user's concrete path:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

The exact npm package is the setup worker and contains the full skill, including
references. Setup copies it to
`<config-root>/memocap/policies/<target>-<full-digest>/memocap`, then registers
that same absolute directory in plugin `skillDirectory` and `skills.paths`. No
separate skills installation or GitHub skill fetch is part of the default flow.
The registry and outer npx bootstrap may use the network.

The installer performs the write steps for the selected scope and returns JSON
on stdout. For a local missing or exact legacy schema, after prerequisites and
authorization it explicitly prepares the main database and verifies the result
by readback. Back up a schema `1.0` database with SQLite's backup API or another
WAL-aware method before authorizing its bridge. Keep diagnostics from stderr
separate. Do not add a manual skill installation or plugin edit after successful
setup.

An inherited project reuses one exact known global owner without creating a
project plugin entry, path, or manifest owner. Different or unknown versions,
changed or duplicate payloads, ambiguous registrations, remote `skills.urls`,
and inactive `--config` targets stop preflight before writes. A known format-1
manifest is upgraded to format 2 only during an explicit mutation under the
setup lock. If its old canonical skill has already been removed, setup does not
restore it. A shared legacy install stops with `shared_skill_migration_required`
and preserves all existing files, links, and locks. `--yes` does not bypass any
of these checks.

## Check and update

Run `check` without mutating installed state:

```sh
memocap-setup check --global --json
```

Read `resolved_version` once from that result. For an authorized update, use
that exact version for dry-run and execution:

```sh
memocap-setup update --to 0.3.0 --global --dry-run --json
memocap-setup update --to 0.3.0 --global --yes --json
```

Use the exact `resolved_version` returned by `check` in both commands; the
examples pin the current v0.3.0 target. For a project, use
`--project "/absolute/path/to/repo"` instead of `--global`. Do not substitute a
second registry lookup for the version already selected by `check`.

Check and dry-run do not prepare, migrate, or prune the database. The setup
core's dry-run does not fetch the target worker or write config, skill, manifest,
or database state. The outer npx runner may fetch its explicitly pinned package
and update the npm cache first.

If an authorized update uses a different-version runner, setup starts an exact
`@lyy-gh/memocap@<resolved_version>` worker and verifies its reported version;
there is no fallback to a different worker target.

If updating an older v0.0.10 installation that has no setup command or new
read-only status interface, preflight reports `inspection_deferred` only. This
is not success or readiness. After authorization, use the exact v0.3.0 runner:

Before running it against a database that may be schema `1.0`, make a WAL-aware
backup.

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup update --to 0.3.0 --global --yes --json
```

For a proven v0.1.0 producer, preflight reports schema `1.0` as
`upgrade_needed`. Back up first. The authorized exact-target update prepares the
local main database and verifies schema and activity status by readback. Remote
clients cannot prepare the server database; the server administrator must do so
locally.

Same-version updates are a no-op when owned components match and may repair an
incomplete owned step. A `--dry-run` does not change installed files, config,
skills, or databases. The outer npx runner can still fetch its pinned package
and write to the npm cache before the setup core starts.

## Read back and report

After a successful install or update, verify the result instead of rerunning
the write command:

```sh
memocap --version
memocap-setup doctor --global --json
```

For project scope, pass the same explicit path to `doctor`. Read back the
installed CLI path and version, plugin entry and effective config source, managed
skill path/version/digest and discovery, core schema status, activity status, and
any backup or conflict details from the actual command output. A component can be
`unchanged`; that is not a failure when it already matches the target.

Preserve the actual readiness result. `static_ready` requires matching
components, a compatible initialized main database, and ready activity. Fresh
install preparation creates schema `2.0`; the installer reads back and requires
both core and activity ready. `not_initialized`, `upgrade_needed`,
`activity_not_initialized`, `activity_degraded`, `incomplete`, and
`inspection_deferred` are not ready. The last value is limited to preflight for
the known local v0.0.10 producer; it is not success evidence. Doctor exits zero
only for `static_ready`. Check, doctor, and dry-run perform no logical database
writes, initialization, bridge, prune, or activity recording. SQLite
`READ_ONLY` inspection may still coordinate WAL/SHM sidecars; ordinary WAL
inspection needs no owner snapshot. Doctor performs no preparation and leaves
`runtime.status: not_run`. A check without `--to` may query the npm registry for
the stable target version.
Treat runtime-not-run separately from installation failure. See the
[readiness table](INSTALL.md#verify) and the
[schema contract](SCHEMA-VERSIONING.md) before interpreting a report.

The JSON report distinguishes step outcomes such as `changed`, `unchanged`,
`failed`, `not_run`, and `outcome_unknown`. A partial result is nonzero and
does not mean all steps were rolled back. Check the current state and backups
before any retry. Resume an incomplete update only with the same explicit
`--to` target. Never repeat `remember` to validate a successful core write.

An agent completion report can use this structure. These are report examples,
not literal setup JSON payloads:

```json
{
  "result": "static_ready",
  "scope": "global",
  "target_version": "0.3.0",
  "cli": "unchanged",
  "plugin": "installed",
  "skill": "installed",
  "runtime": "not_run",
  "restart_required": true
}
```

For a partial failure, name the component and next read-only check:

```json
{
  "result": "partial",
  "scope": "global",
  "target_version": "0.3.0",
  "cli": "unchanged",
  "plugin": "installed",
  "skill": "failed",
  "next_step": "Read skill ownership and current links before retrying the same target."
}
```

## Runtime verification

`doctor` reports configured/static readiness only. It does not prove that a
running OpenCode process loaded the plugin or skill. Do not restart OpenCode
automatically. After the user restarts it, `opencode debug skill` must show the
actual `memocap` skill location. In that session, `/memory status` must report
`policy.mode: "managed"` and the runtime `policy.directory`, `policy.mainPath`,
`policy.version`, and `policy.digest`. Resolve the debug location to the
`SKILL.md` file and compare it with the canonical `policy.mainPath`; compare
its parent directory with `policy.directory`. The version and full digest must
match the installed payload. The runtime policy object has no `source` property. Observe a
real recall receipt before reporting `runtime_verified`. If no provider or live
session is available, report the static result, `runtime.status: not_run`, and
`restart_required` when applicable. Policy rules are appended at compaction,
not forced into every turn; neither a hook nor receipt proves model adoption.

Activity and repository hints share the main database and are bounded operational
history, not a complete audit. An old `<core filename>.activity.sqlite` file is
left untouched and its history is not imported. An activity failure after a
successful memory write must be reported as core success plus an activity
warning. Do not retry the memory write. Neither v0.1.0 nor v0.0.10 can open
schema `2.0`; ordinary software downgrade does not restore database state.
Never restore an older backup over newer data. To prepare a local database
outside setup, back up first if its schema may be `1.0`, then run
`memocap activity prepare --json` with remote mode unset; it may prune retained
activity. Remote preparation is server-admin-only. Data
backup and explicit restore are covered in the
[user guide](INSTALL.md#data-and-compatibility).

## Platform commands

PowerShell uses the same pinned workflow. Quote a project path that contains
spaces:

```powershell
npx --yes --package '@lyy-gh/memocap@0.3.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.3.0' memocap-setup install --project 'C:\work\my repo' --yes --json
memocap-setup check --global --json
memocap-setup update --to 0.3.0 --global --dry-run --json
memocap-setup update --to 0.3.0 --global --yes --json
```

The source checkout's `scripts/install.sh` and `scripts/install.ps1` only
forward arguments and exit status to the same setup core.
