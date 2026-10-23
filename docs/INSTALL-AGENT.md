# Agent Install and Update Guide

Use this guide only when the user has authorized a memocap installation or
update. It describes v0.1.0. Keep the CLI, plugin, and runtime skill on one
release. For the human-facing explanation, see [Install and Update](INSTALL.md).

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
git --version
opencode --version
```

Require Node.js 22.20 or later and OpenCode 1.19.3. The setup command does not
install or upgrade the host, Node.js, or Git. If OpenCode is absent or has an
unsupported version, report that and ask for authorization before changing it.
The version-pinned host install, when authorized, is documented in the
[user guide](INSTALL.md#requirements).

## Starting from the skill alone

An installed skill provides policy and guide links, not the CLI or OpenCode
plugin. If the user authorized the full integration, bootstrap it with the
version-pinned setup runner instead of assuming `memocap` or
`memocap-setup` is already installed:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --global --yes --json
```

For project scope, use the same command with
`--project "/absolute/path/to/repo"` instead of `--global`. If the user's
authorization covered only the skill, stop after the skill installation and
report that the runtime integration is not installed.

## Install

For a new global install:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --global --yes --json
```

For a project install, substitute the user's concrete path:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

The installer performs the write steps for the selected scope and returns JSON
on stdout. Keep diagnostics from stderr separate. Do not add a manual `skills`
installation or plugin edit after a successful setup unless the report names a
missing component.

## Check and update

Run `check` without mutating installed state:

```sh
memocap-setup check --global --json
```

Read `resolved_version` once from that result. For an authorized update, use
that exact version for dry-run and execution:

```sh
memocap-setup update --to 0.1.0 --global --dry-run --json
memocap-setup update --to 0.1.0 --global --yes --json
```

Replace `0.1.0` with the exact version returned by `check`. For a project, use
`--project "/absolute/path/to/repo"` instead of `--global`. Do not substitute a
second registry lookup for the version already selected by `check`.

The setup core's dry-run does not fetch update payloads or write config, skill,
manifest, or database state. The outer npx runner may fetch its pinned package
and update the npm cache first.

If an authorized update uses a different-version runner, setup starts an exact
`@lyy-gh/memocap@<resolved_version>` worker and verifies its reported version;
there is no fallback to a different worker target.

If updating an older v0.0.10 installation that has no setup command, use the
pinned v0.1.0 runner:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup update --to 0.1.0 --global --yes --json
```

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
installed CLI path and version, plugin entry and effective config source, skill
version/source/discovery, core schema status, activity status, and any backup or
conflict details from the actual command output. A component can be
`unchanged`; that is not a failure when it already matches the target.

Preserve the actual readiness result: `installation_ready` means matching
components and ready activity with an uninitialized core; `static_ready` means
matching components, compatible initialized core, and ready activity.
`incomplete`, `activity_not_initialized`, and `activity_degraded` are not success
substitutes. Doctor exits zero only for the two ready states, performs no
logical data/schema writes, core initialization/reset/migration, activity
pruning, or activity recording. SQLite `READ_ONLY` inspection may still
coordinate WAL/SHM sidecars; ordinary WAL inspection needs no owner snapshot.
Doctor performs no auxiliary preparation and leaves `runtime.status: not_run`.
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
  "target_version": "0.1.0",
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
  "target_version": "0.1.0",
  "cli": "unchanged",
  "plugin": "installed",
  "skill": "failed",
  "next_step": "Read skill ownership and current links before retrying the same target."
}
```

## Runtime verification

Static install readiness does not prove that OpenCode loaded the plugin or that
a model received recall results. Do not restart OpenCode automatically. After
the user restarts it, check `/memory status` in a new session and observe a real
recall receipt before reporting `runtime_verified`. If no provider or session is
available, report the actual readiness, `runtime.status: not_run`, and `restart_required`
when applicable. Never claim that model adoption is guaranteed by a hook or
receipt.

The activity database is separate from the core database and is bounded
operational history, not a complete audit. A sidecar activity failure after a
successful memory write must be reported as core success plus an activity
warning. Do not retry the memory write. A schema `1.0` core store remains
compatible with v0.0.10; ordinary software downgrade does not restore database
state. Data backup and explicit restore are covered in the
[user guide](INSTALL.md#data-and-compatibility).

## Platform commands

PowerShell uses the same pinned workflow. Quote a project path that contains
spaces:

```powershell
npx --yes --package '@lyy-gh/memocap@0.1.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.1.0' memocap-setup install --project 'C:\work\my repo' --yes --json
memocap-setup check --global --json
memocap-setup update --to 0.1.0 --global --dry-run --json
memocap-setup update --to 0.1.0 --global --yes --json
```

The source checkout's `scripts/install.sh` and `scripts/install.ps1` only
forward arguments and exit status to the same setup core.
