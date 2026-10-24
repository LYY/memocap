# Install and Update

This guide covers package target v0.2.0. Keep the CLI, OpenCode plugin, and
runtime skill on the same release unless you are following an explicit recovery
procedure.

## Requirements

- Node.js 22.20 or later, with npm and npx.
- Git, used to fetch the tagged runtime skill.
- OpenCode 1.19.3. The installer does not install or upgrade OpenCode.

If OpenCode is missing, install the exact supported version only when you intend
to change the host installation:

```sh
npm install --global opencode-ai@1.19.3
opencode --version
```

See the [official OpenCode v1.19.3 release](https://github.com/anomalyco/opencode/releases/tag/v1.19.3).
Do not use an unpinned latest-version command for this setup. A model provider
is not required to install memocap. Without a provider, runtime verification
remains `not_run`.

## Global install

This installs the user-level CLI and OpenCode integration. The command is pinned
to v0.2.0 and does not select a memory placement:

```sh
npx --yes --package @lyy-gh/memocap@0.2.0 memocap-setup install --global --yes --json
```

The installer reports the CLI, plugin, skill, and configuration result for each
step. After prerequisites and authorization, install/update prepares a missing
or exact schema `1.0` local main database, then verifies it by readback.
Preparation may prune retained activity. Before bridging a legacy database,
make a WAL-aware backup as described below. Network access is needed for the
pinned npm package and tagged skill. When npx launches
the setup command, npx may fetch the runner package and update its own cache
before the setup core starts.

## Project install

Pass the full project path explicitly. Quote paths that contain spaces:

```sh
npx --yes --package @lyy-gh/memocap@0.2.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

This configures the project integration and project skill. The user-level CLI
may be shared with other projects, so the report identifies that shared effect.
Review project changes before committing them.

Global and project describe where the integration is installed. They do not
select where memories are stored. Memory placement remains repository,
attached-domain, or universal under the existing scope rules.

## Skill-only install

If an agent needs the runtime policy before the rest of memocap is installed,
install only the skill from the matching release tag. Choose one scope:

```sh
# Global skill
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.2.0 --skill memocap --agent opencode --global --yes

# Project skill, run from the project directory
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.2.0 --skill memocap --agent opencode --yes
```

The `skills` CLI manages its shared canonical skill and agent links. Do not
replace a shared skill directory by hand. The installed skill points to these
versioned guides because installing a skill does not copy the repository's
`docs/` directory. Skill-only installation copies policy; it does not install
the CLI, activate the plugin, or establish runtime readiness.

## Manual equivalent

Use the setup command for normal installs and all updates. For a manually
managed installation, pin the CLI and plugin to the same release, then install
the matching skill:

```sh
npm install --global @lyy-gh/memocap@0.2.0
```

If you use pnpm for this global CLI, keep the same package-manager owner:

```sh
pnpm add --global @lyy-gh/memocap@0.2.0
```

Setup can adopt an existing manual integration only when the installed package,
plugin, and skill source and ownership can be verified. Adoption of a proven
v0.1.0 integration was validated with a global pnpm 12 CLI and a release skill
and plugin without setup ownership metadata. Unproven or conflicting state is
reported, not overwritten.

Add the plugin package to the intended OpenCode v1 config. OpenCode accepts JSON
and JSONC, and the v1 config key is `plugin`. See the
[v1.19.3 config reference](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/web/src/content/docs/config.mdx):

```jsonc
{
  "plugin": [
    "@lyy-gh/memocap@0.2.0"
  ]
}
```

Append the package to an existing plugin array. Keep unrelated fields, comments,
existing plugin entries, and plugin options. Global config is normally under
`~/.config/opencode/`; project config belongs in the project root. OpenCode
merges config layers, and a project setting can override a global one. The
`OPENCODE_CONFIG` path, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, or
managed settings can change which config is effective. The installer edits only
its selected persistent target; use `doctor` to inspect the active source and
report an override rather than writing to another layer.

Install the matching skill with the pinned command in [Skill-only install](#skill-only-install).
For a project skill, run that command from the project directory. Use
`memocap-setup doctor` after the manual steps. Manual config editing does not
create installer ownership metadata, so use the setup command for later
updates and recovery.

The source checkout's `scripts/install.sh` and `scripts/install.ps1` are thin
wrappers over the same setup core. They forward the setup arguments and exit
code; they are not separate installers or update mechanisms.

## Check and update

Check is read-only. It compares the installed CLI, plugin, and skill and records
one resolved stable version for this check:

```sh
memocap-setup check --global --json
```

For an authorized update, copy the exact `resolved_version` from that check.
Review the exact-target dry-run, then execute the same target with `--yes`:

```sh
memocap-setup update --to 0.2.0 --global --dry-run --json
memocap-setup update --to 0.2.0 --global --yes --json
```

Use the exact `resolved_version` returned by `check` in both commands; the
examples pin the v0.2.0 target. Do not resolve `latest` again between the plan
and execution. The setup command does not prompt interactively when `--yes` is
absent. `check` is informational: read its `readiness` field, not only its
successful command exit, to determine whether the database is ready.

When an authorized update runs from a different package version, setup starts an
exact-target `@lyy-gh/memocap@<resolved_version>` worker and verifies the worker
and report versions. It does not fall back to another worker version.

The setup core's dry-run does not fetch the target worker or write config,
skill, manifest, or database state. If npx starts the core, it may still fetch
the explicitly pinned runner package and update its own cache first. Check,
doctor, and dry-run never prepare, migrate, or prune the database.

Use `--project "/absolute/path/to/repo"` instead of `--global` for a project
integration. `--yes` confirms only the explicitly selected update scope. It
does not authorize overwriting user edits or changing other projects or agents.
When needed, select the existing global package-manager owner with
`--package-manager npm` or `--package-manager pnpm`.

An exact same-version install is a no-op when all owned components match. If an
owned step is incomplete, the installer can repair that same version without
replacing unrelated user state.

### Upgrade from v0.0.10

The v0.0.10 CLI does not include the setup command or the new read-only status
interface. Its higher-target preflight reports `inspection_deferred` only; this
is not a successful readiness result. Bootstrap the exact v0.2.0 runner with
the authorized update, then inspect and prepare through the target setup logic.
Before running it against a database that may be schema `1.0`, make a WAL-aware
backup:

```sh
npx --yes --package @lyy-gh/memocap@0.2.0 memocap-setup update --to 0.2.0 --global --yes --json
```

Use `--project "/absolute/path/to/repo"` for a project integration. The target
installer reports schema `1.0` as `upgrade_needed`, prepares the local main
database, and verifies the result.

## What changes

The CLI is a user-level package and may be shared across projects. The setup
core reuses its existing npm or pnpm owner when it can identify one. `--global`
or `--project` selects the OpenCode plugin entry, managed skill, and per-scope
installation metadata and backups. The installer does not edit shell profiles,
run with `sudo`, install Node.js or Git, configure a provider, make model calls,
or restart OpenCode. Conflicting plugin versions or user edits are reported
instead of silently overwritten.

OpenCode supports JSONC comments and merges configuration layers. The installer
edits its owned plugin entry while preserving other entries, options, comments,
and user fields. It reports when a later layer changes the effective plugin
configuration. Non-persistent runtime config and managed config are not written
to an unrelated file to simulate success.

The `skills` command owns shared skill installation and linking. Existing
canonical skills and installations for other agents are preserved. If ownership
or a conflicting copy cannot be established safely, resolve that conflict
before updating.

## Data and compatibility

Package `0.2.0`, schema `2.0`, and receipt format `1` are independent
identities. The exact registered schema `1.0` bridges atomically to `2.0`,
preserving core rows and IDs, placements, domains and attachments, provenance,
the operation ledger, and FTS. Missing main databases are prepared at schema
`2.0`. Pre-versioned, malformed, unknown, or unsupported schemas are refused
without reset. See [SCHEMA-VERSIONING.md](SCHEMA-VERSIONING.md) for the bounded
same-major compatibility contract.

Activity and repository hints now share the main SQLite database. Activity is
bounded operational history, not a complete audit log. Recall/injection history
is limited to 30 days and 10,000 events; write metadata is capped at 1,000
events. Pruning, expiry, and recording failures can leave gaps. If activity
storage fails after a core memory write succeeds, report the memory write as
successful with an activity warning. Do not repeat `remember` to repair activity
history. An existing `<core filename>.activity.sqlite` file is not opened,
imported, rewritten, or deleted by generic preparation, and its history is not
available through the new database. Any later discard is a separate,
user-authorized choice after old writers are quiescent.

To prepare a local database outside setup, first make a WAL-aware backup if its
schema may be `1.0`, then run `memocap activity prepare --json` with remote mode
unset. It creates schema `2.0` or bridges exact schema `1.0`, then prepares
activity retention and may prune old events. A remote client cannot prepare the
server database; its administrator must run the command locally.

Before bridging a legacy database, use SQLite's backup API or another
WAL-aware procedure. A raw copy can omit committed data while the database uses
WAL. Restoring data is a separate, destructive action and requires an explicit
choice of backup and target. Software rollback alone does not restore database
state.

## Verify

Run the read-only doctor for the selected scope:

```sh
memocap-setup doctor --global --json
```

For a project installation, pass its explicit path with `--project`. Static
readiness checks installed files, versions, config, skill discovery, and main
database compatibility and activity availability. It does not prove that an
OpenCode session loaded the new plugin or that a model received recalled memory.

Read the actual `status`, `readiness`, and `runtime` fields:

| Readiness | Meaning |
| --- | --- |
| `static_ready` | Components match, the main database is compatible, and activity is ready. A fresh install reaches this after schema `2.0` preparation and readback. |
| `not_initialized` | The main database is missing and is not ready. Authorized local install/update can prepare it; remote preparation belongs to the server administrator. |
| `upgrade_needed` | The exact registered schema `1.0` needs the explicit local bridge. Back up first; remote preparation belongs to the server administrator. |
| `activity_not_initialized` or `activity_degraded` | Activity is not ready. Treat warnings separately from core success and never replay a successful write. |
| `incomplete` | Inspection or required component/update state is incomplete. |
| `inspection_deferred` | Higher-target preflight of the known local v0.0.10 producer only. It is not success or readiness; install the target and read back its result. |

Doctor exits zero only for `static_ready`; all other readiness values, including
`not_initialized`, `upgrade_needed`, `activity_degraded`, `incomplete`, and
`inspection_deferred`, are not ready. Check and doctor make no logical database
writes; they do not initialize, bridge, prune, or record activity. Dry-run also
does not prepare the database. An authorized local install/update explicitly
prepares a missing or exact legacy main database, then reads it back and requires
both core and activity to be ready. Remote clients cannot prepare the server's
database. `runtime.status` remains `not_run` until a new OpenCode session
verifies status and a real recall. SQLite `READ_ONLY` connections may still
coordinate WAL/SHM sidecars. Ordinary inspection of a WAL-backed database works
without an owner-generated snapshot; this does not promise zero filesystem-level
activity from SQLite's normal WAL handling.

After restarting OpenCode yourself, use a new session to check `/memory status`
and perform an actual recall. Report `runtime_verified` only after observing
that runtime result. Without an available provider or a real session, report
the actual static readiness and `runtime.status: not_run`. A changed plugin or skill may require a
restart, reported as `restart_required`; the installer never restarts OpenCode.

## Partial failure and recovery

The installer is a sequence of independently checked steps, not one transaction.
A failed command can leave earlier components installed. Read its full result,
then run the read-only check or doctor before trying again. If a network response
or process result is uncertain, read the installed versions, config, skill
ownership, and manifest first. Do not repeat a write just to see whether it
worked.

For an incomplete update, resolve the reported conflict and resume with the same
explicit `--to` version. The installer repairs missing owned steps and keeps
unrelated changes. It does not restore a database or replace the whole config as
automatic rollback. Use the recorded config backup only after reviewing it and
choosing the exact state to restore.

An activity-store warning is separate from core memory success. An unknown core
schema or a denied permission is a stop condition. Do not bypass a tool denial
with a shell command.

## Uninstall

Uninstall removes only integration state the installer can prove it owns and
that has not been changed by the user. It keeps the main database (including
activity), backups, unrelated plugin entries, shared skills, and other agents'
installations. The global CLI is kept unless `--remove-cli` is explicitly
requested. If another integration refers to that CLI, the installer reports
the reference and leaves it in place.

```sh
memocap-setup uninstall --global --dry-run --json
memocap-setup uninstall --global --yes --json
memocap-setup uninstall --global --remove-cli --yes --json
```

Use `--project "/absolute/path/to/repo"` instead of `--global` for a project
integration. Use `--remove-cli` only when the report shows no remaining
references and you explicitly want the user-level CLI removed.

## Windows PowerShell

The same pinned commands work from PowerShell. Quote package arguments and
project paths with single quotes:

```powershell
npx --yes --package '@lyy-gh/memocap@0.2.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.2.0' memocap-setup install --project 'C:\work\my repo' --yes --json
```

For an update, use `memocap-setup check --global --json`, then pass its exact
resolved version to `memocap-setup update --to 0.2.0 --global --dry-run --json`
and, after reviewing the plan, to the matching `--yes` command. The PowerShell
wrapper in a source checkout forwards the same arguments to the same setup core.

```powershell
memocap-setup check --global --json
memocap-setup update --to 0.2.0 --global --dry-run --json
memocap-setup update --to 0.2.0 --global --yes --json
```
