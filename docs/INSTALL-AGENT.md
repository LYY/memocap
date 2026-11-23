# Agent Install and Update Guide

Use this guide for an authorized memocap install/update targeting package
`0.7.1` and tag `v0.7.1`. Keep native CLI, plugin, and runtime skill on that
exact release. Follow the versioned guide bundled with the target package.
This contract does not claim publication, a local update, or runtime verification.
See [Install and Update](INSTALL.md) for the human guide.

## Authorization and preflight

Resolve the user's requested scope: global integration or one absolute project
path. Installation scope does not authorize memory writes or select memory
placement. `--yes` confirms only that scope; it cannot bypass user edits,
conflicts, ownership, permissions, or other agents' state.

Inspect prerequisites before changing installed state:

```sh
node --version
npm --version
opencode --version
```

Require Node.js 22.20 or later and OpenCode v1. The v1 policy does not imply
every minor or patch release was tested; the pinned SDK is not a host version
requirement. Setup never installs/upgrades
OpenCode, Node.js, or Git. Git is unnecessary for the managed npm skill. If host
changes are needed, obtain that separate authorization. An installed skill alone
provides policy, not the CLI/plugin. For an authorized full integration,
bootstrap the pinned package instead of assuming those commands exist.

## Install

```sh
npx --yes --package @lyy-gh/memocap@0.7.1 memocap-setup install --global --yes --json
```

For project scope:

```sh
npx --yes --package @lyy-gh/memocap@0.7.1 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

The worker copies its complete bundled skill and references into
`<config-root>/memocap/policies/<version>-<full-digest>/memocap`; plugin
`skillDirectory` and `skills.paths` select that same absolute directory. Do not
add another skill installation or edit the plugin after successful setup.
The outer npx runner and npm registry can use the network/cache.

Global config root is `OPENCODE_CONFIG_DIR`, otherwise
`$XDG_CONFIG_HOME/opencode` or `$HOME/.config/opencode`; project root is
`<project>/.opencode`. `--config` selects an active configuration file without
moving the skill. An inherited project reuses one exact matching global owner.
Unknown/different owners, changed or duplicate skills, ambiguous sources,
remote `skills.urls`, and inactive config targets stop preflight. Preserve
concurrent config edits and report the conflict.

Current ownership uses manifest format `2`. A v0.6.0 format-2 record containing
inert `migration`, `adoption`, and `steps.legacy_cleanup` fields must remain
upgradable; those historical fields authorize no takeover or cleanup. Unsupported
manifest formats are refused. Keep shared/modified payload protections intact.

Authorized local install/update prepares missing schema `2.3` or upgrades
exact `2.2` to `2.3`, then reads core/activity readiness back. Back up an
existing database using SQLite's backup API or another WAL-aware method first.
Preparation can prune retained activity. Remote preparation belongs to the
server administrator and must run locally.

## Managed update from v0.6.0 or v0.7.0 to v0.7.1

Use the exact target package to inspect, plan, and apply the update. The
v0.7.1 runner supports OpenCode v1; no host downgrade is needed to update an
existing installation. The older v0.6.0 runner can reject newer OpenCode v1
releases before reporting the installation state.

```sh
npx --yes --package @lyy-gh/memocap@0.7.1 memocap-setup check --to 0.7.1 --global --json
npx --yes --package @lyy-gh/memocap@0.7.1 memocap-setup update --to 0.7.1 --global --dry-run --json
```

Review `runner_version` and `resolved_version` (both `0.7.1`), the reported
OpenCode and config, and `shared_cli.manager`, which identifies the existing npm
or pnpm owner. After authorization, apply the same exact target:

```sh
npx --yes --package @lyy-gh/memocap@0.7.1 memocap-setup update --to 0.7.1 --global --yes --json
```

Repeat the originally installed scopes in all three commands: use `--global`
for a global install and the same concrete `--project PATH` for each project.
Keep the same `--config FILE` if you used an explicit config override. The runner
discovers the existing CLI owner even when launched with npx; do not select a
different package manager. Do not substitute `latest` for either version pin.
The direct path is managed format `2`, package `0.6.0` or `0.7.0`, schema `2.3`, to
managed format `2`, package `0.7.1`, schema `2.3`. Legacy installer recovery and
schema-major transitions are retired. Existing supported memories, placements,
domains, provenance, FTS, operation ledger, activity, organization state, and
repository identity/location metadata remain intact. This package update makes
no schema change and requires no preparation for a ready schema `2.3` database.
It does not prune activity; existing retention rules still apply to later activity writes.

Check, doctor, and dry-run perform no logical database writes, initialization,
schema changes, activity recording, or pruning. Dry-run also avoids worker
fetches and config/skill/manifest writes; outer npx can still download its
pinned runner first. Both the installed CLI and the target 0.7.1 CLI report
`ready`/`2.3` with activity ready. Completion requires the exact 0.7.1 CLI and
an independent readback of that state after the package update. No schema
preparation runs for this path. Refuse any CLI that reports `ready`/`2.2`;
the superseded 0.5.0 preflight exception is removed. Exact schema `2.2` reported
as `upgrade_needed` still requires separately authorized preparation.
Unsupported schemas `2.1`, `2.0` and `1.0`, future,
malformed, and pre-versioned databases are refused unchanged. See the
[schema contract](SCHEMA-VERSIONING.md).

Same-version installs are a no-op when owned components match and can repair
incomplete owned steps. Preserve unrelated state. After partial/uncertain
results, inspect ownership, versions, config, manifest, and backups before any
retry; resume only the same exact target. Never repeat a write to check success.

## Read back and report

```sh
memocap --version
memocap-setup doctor --global --json
```

Use the same project path when applicable. Report actual CLI path/version,
plugin entry/config source, managed skill path/version/full digest/discovery,
schema/activity readiness, backup/conflict details, and restart requirement.
`unchanged` is valid for an already matching component. Doctor exits zero only
for `static_ready`; check's zero exit is informational.

`static_ready` requires matching components, initialized compatible schema `2.3`,
and ready activity. `not_initialized`, `upgrade_needed`,
`activity_not_initialized`, `activity_degraded`, and `incomplete` are not ready.
SQLite read-only connections may coordinate WAL/SHM sidecars; ordinary WAL
inspection needs no owner snapshot. Doctor does no preparation and leaves
`runtime.status: not_run`. A check without `--to` can query the registry.

Setup reports step outcomes `changed`, `unchanged`, `failed`, `not_run`, and
`outcome_unknown`; a partial result does not imply rollback of earlier steps.
Report successful core writes separately from activity warnings and never replay
`remember` to repair history. Old `.activity.sqlite` files remain untouched and
are not imported. Software rollback is not data restoration; never restore an
older backup over newer data automatically.

An example agent completion report, distinct from literal setup JSON:

```json
{
  "result": "static_ready",
  "scope": "global",
  "target_version": "0.7.1",
  "cli": "unchanged",
  "plugin": "installed",
  "skill": "installed",
  "runtime": "not_run",
  "restart_required": true
}
```

## Runtime verification

Static readiness does not prove a running host loaded the package. After the
user restarts OpenCode, use a new session. `opencode debug skill` must show one
selected `memocap` skill. `/memory status` must report `policy.mode: "managed"`,
`policy.directory`, `policy.mainPath`, `policy.version`, and `policy.digest`.
Resolve discovered `SKILL.md` to the canonical `policy.mainPath`; its parent
must equal `policy.directory`, and version/digest must match installed payload.
The runtime object has no `source` property.

Observe a real recall receipt before claiming runtime verification. Without a
provider/live session, report static readiness and `runtime.status: not_run`.
Policy rules appear at compaction; hooks and receipts do not prove model
understanding or adoption. Organization loads its reference on demand through
`/memory organize` or `/memory organize -a`; follow that workflow's permissions,
exact snapshots, explicit group confirmation, atomic apply, and independent
readback. A failed readback after commit never authorizes replay.

For an authorized standalone skill for another agent, use the separate
[standalone flow](INSTALL.md#optional-standalone-skill-for-another-agent).
Uninstall is similarly explicit; use the [ownership-preserving commands](INSTALL.md#uninstall).
Neither flow authorizes personal memory changes or tool-denial bypasses.

## Windows PowerShell

```powershell
npx --yes --package '@lyy-gh/memocap@0.7.1' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.7.1' memocap-setup install --project 'C:\work\my repo' --yes --json
npx --yes --package '@lyy-gh/memocap@0.7.1' memocap-setup check --to 0.7.1 --global --json
npx --yes --package '@lyy-gh/memocap@0.7.1' memocap-setup update --to 0.7.1 --global --dry-run --json
npx --yes --package '@lyy-gh/memocap@0.7.1' memocap-setup update --to 0.7.1 --global --yes --json
```

Source wrappers `scripts/install.sh` and `scripts/install.ps1` forward arguments
and exit status to the same setup core.
