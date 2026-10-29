# Install and Update

This guide targets package `0.5.0` and Git tag `v0.5.0`. Keep the native CLI,
OpenCode plugin, and managed skill on the same release.

## Requirements

- Node.js 22.20 or later, with npm and npx.
- OpenCode 1.19.3. Setup does not install or upgrade the host.

The complete managed skill comes from the exact npm package; Git is not
required. npm downloads can use the network. A provider is unnecessary for
installation; without a live session, runtime verification remains `not_run`.
If you intend to install the supported host, use its pinned version:

```sh
npm install --global opencode-ai@1.19.3
opencode --version
```

See the [official OpenCode release](https://github.com/anomalyco/opencode/releases/tag/v1.19.3).

## Global and project installation

For a user-level integration:

```sh
npx --yes --package @lyy-gh/memocap@0.5.0 memocap-setup install --global --yes --json
```

For one project, pass its absolute path and quote spaces:

```sh
npx --yes --package @lyy-gh/memocap@0.5.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

Global and project select integration ownership, not memory placement. Memories
still use explicit repository, attached-domain, or universal placement. A project
inheriting one exact matching global owner reuses it without adding a second
plugin entry or skill path. Review reported project configuration before commit.

After prerequisites and authorization, local install/update explicitly prepares
a missing database at schema `2.2` or upgrades current schema `2.1` to `2.2`,
then checks core and activity readiness by readback. Preparation may prune retained
activity. Back up an existing database with SQLite's backup API or another
WAL-aware method before updating. A raw file copy can omit committed WAL data.

## Managed skill and ownership

The exact package worker copies all of `skills/memocap`, including references,
to `<config-root>/memocap/policies/<version>-<full-digest>/memocap`. Both plugin
`skillDirectory` and `skills.paths` select that absolute directory. The plugin
checks every selected file against its package digest. No separate skill-install
command is part of this flow.

Config roots are resolved independently from the configuration file being edited:

- Global: `OPENCODE_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/opencode` or
  `$HOME/.config/opencode`.
- Project: `<project>/.opencode`.

`--config <FILE>` selects a persistent configuration file in an active host
layer; it does not move the skill directory. Setup preserves JSONC comments,
unrelated entries, tuple options, and skill paths using a compare-and-swap edit.
Concurrent edits are retained and reported as conflicts.

Current setup ownership uses manifest format `2`. An installed v0.4.0 format-2
record remains upgradable when it contains inert historical `migration`,
`adoption`, or `steps.legacy_cleanup` fields. These fields do not authorize
legacy takeover or cleanup. Unsupported manifest formats are refused. Unknown,
changed, duplicate, shared, or ambiguous skill sources, remote `skills.urls`, and
inactive config targets stop preflight. `--yes` never bypasses those protections.

## Check and update from v0.4.0

First inspect the selected integration:

```sh
memocap-setup check --global --json
```

Read its `resolved_version` once, review the exact-target plan, and execute that
same version after authorization. These examples target v0.5.0:

```sh
memocap-setup update --to 0.5.0 --global --dry-run --json
memocap-setup update --to 0.5.0 --global --yes --json
```

To bootstrap the target worker explicitly:

```sh
npx --yes --package @lyy-gh/memocap@0.5.0 memocap-setup update --to 0.5.0 --global --yes --json
```

Use `--project "/absolute/path/to/repo"` for project scope. A different-version
runner delegates to the exact `@lyy-gh/memocap@<resolved_version>` worker and
checks its version and report. It never silently selects another target. An
exact matching same-version installation is a no-op; incomplete owned steps can
be repaired without replacing unrelated state. When necessary, select the known
global CLI owner using `--package-manager npm` or `--package-manager pnpm`.

Check, doctor, and setup dry-run make no logical database writes: no schema
upgrade, initialization, activity recording, or pruning. Dry-run does not fetch
the target worker or write configuration, skill, or manifest state. An outer
npx bootstrap may download its pinned runner and write its npm cache first.
Check without `--to` can query the stable registry version. Do not resolve
`latest` again between planning and execution.

The supported upgrade is current managed v0.4.0 format `2`, schema `2.1`, to
v0.5.0 format `2`, schema `2.2`. Older legacy installers, ownership formats, and
schema-major transitions have no automatic recovery path in this release.

## Data and compatibility

Package `0.5.0`, database schema `2.2`, setup manifest format `2`, and receipt
format `1` are separate identities. The additive `2.1` to `2.2` upgrade keeps
existing memories, IDs, placements, domains and attachments, provenance, operation
ledger, activity, repository hints, FTS, and organization state. Identity and
location metadata start empty; existing repository IDs remain authoritative.

The new 0.5.0 CLI reports `upgrade_needed` for `2.1` without changing it.
Before package upgrade, the actual 0.4.0 CLI reports `ready` for `2.1`; setup
accepts that immediate-prior producer for preflight only. Installation requires
the 0.5.0 CLI and an independent `ready`/`2.2` readback after preparation.
Missing databases are created at `2.2`. Pre-versioned, malformed, unknown,
schemas `2.0` and `1.0`, and future schemas are refused without reset. See
[SCHEMA-VERSIONING.md](SCHEMA-VERSIONING.md) for the exact compatibility contract.

Outside setup, a local administrator can run:

```sh
memocap activity prepare --json
```

Unset remote mode first. Remote clients cannot prepare the server database;
its administrator must do so locally. Preparation can prune retained activity.
Activity is bounded operational history: recall/injection events retain at most
30 days and 10,000 events; write metadata is capped at 1,000 events. Gaps are
possible. If activity fails after a core memory write succeeds, report core
success plus its activity warning; never repeat the memory write to fill history.
Old `.activity.sqlite` files remain untouched and are not imported.

Software rollback does not restore database state. Restore is a separate
destructive operation requiring an explicit backup and target choice; never
overwrite newer data with an older backup automatically.

## Verify static and runtime readiness

```sh
memocap --version
memocap-setup doctor --global --json
```

For project scope, use its same explicit path. Read actual `status`, `readiness`,
and `runtime` fields. Doctor exits zero only for `static_ready`.

| Readiness | Meaning |
| --- | --- |
| `static_ready` | CLI, plugin, skill, initialized schema `2.2`, and activity are ready. |
| `not_initialized` | Main database is missing; authorized local preparation is required. |
| `upgrade_needed` | Current schema `2.1` needs explicit local preparation. |
| `activity_not_initialized` or `activity_degraded` | Activity is unavailable; preserve core success and warnings separately. |
| `incomplete` | Required inspection or component state is incomplete. |

Check is informational; its zero exit alone does not mean readiness. Doctor
checks configured files, versions, discovery, ownership, schema, and activity.
It does not prove a running host loaded them. SQLite read-only connections may
coordinate WAL/SHM sidecars; normal WAL inspection needs no owner snapshot.

After restarting OpenCode yourself, open a new session. `opencode debug skill`
must show exactly one selected `memocap` skill. `/memory status` must report
`policy.mode: "managed"`, `policy.directory`, `policy.mainPath`, `policy.version`,
and `policy.digest`. The discovered `SKILL.md` must equal canonical
`policy.mainPath`, its parent must equal `policy.directory`, and version/full
digest must match the installed package. This runtime object has no `source`
field. Observe a real recall receipt before claiming runtime verification.
Without that session report `runtime.status: not_run`; changed plugin/skill
state can require a restart, which setup never performs automatically.

The daily skill is compact. `/memory organize` reads pending records;
`/memory organize -a` includes organized records. The host loads the organization
reference on demand. Exact snapshots, explicit confirmation and permissions,
atomic per-group application, and independent readback govern writes. Policy
injection or a receipt does not prove model understanding or adoption.

## Partial failure and recovery

Setup consists of independently checked steps, not one transaction. A failed
command can leave earlier components installed. Read the full report and inspect
current versions, configuration, ownership, manifest, and backups before retrying.
Resume incomplete work with the same explicit `--to` target. Do not repeat a
write to determine whether it succeeded. Setup never restores a database or a
whole configuration automatically. Unknown schema and denied permissions are stop
conditions; a tool denial does not authorize shell bypass.

`--yes` confirms only the requested installation scope. It does not authorize
user-edit overwrites, other projects or agents, shell profile changes, `sudo`,
provider configuration, model calls, or host installation/restart.

## Uninstall

```sh
memocap-setup uninstall --global --dry-run --json
memocap-setup uninstall --global --yes --json
memocap-setup uninstall --global --remove-cli --yes --json
```

Setup removes only provably owned, unchanged plugin/path registrations and
payloads with matching full digests and no remaining references. Shared or
modified payloads remain and are reported. Databases, activity, backups,
unrelated entries, and other agents remain. The global CLI stays unless
`--remove-cli` is requested and no other integration references it. Use the same
explicit `--project` path for project removal.

## Optional standalone skill for another agent

```sh
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.5.0 --skill memocap --agent '<other-agent-id>' --global --yes
```

This separate path uses the versioned GitHub tree and installs neither the CLI
nor the OpenCode plugin. Update it through its recorded source and matching tag.
It is not another step for managed OpenCode; duplicate visible skills conflict.
Source wrappers `scripts/install.sh` and `scripts/install.ps1` forward arguments
and exit status to the same setup core.

## Windows PowerShell

```powershell
npx --yes --package '@lyy-gh/memocap@0.5.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.5.0' memocap-setup install --project 'C:\work\my repo' --yes --json
memocap-setup check --global --json
memocap-setup update --to 0.5.0 --global --dry-run --json
memocap-setup update --to 0.5.0 --global --yes --json
```
