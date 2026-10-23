# Install and Update

This guide describes the v0.1.0 release. Keep the CLI, OpenCode plugin, and
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
to v0.1.0 and does not select a memory placement:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --global --yes --json
```

The installer reports the CLI, plugin, skill, and configuration result for each
step. It does not change the core memory database. Network access is needed for
the pinned npm package and tagged skill. When npx launches the setup command,
npx may fetch the runner package and update its own cache before the setup core
starts.

## Project install

Pass the full project path explicitly. Quote paths that contain spaces:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
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
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.1.0 --skill memocap --agent opencode --global --yes

# Project skill, run from the project directory
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.1.0 --skill memocap --agent opencode --yes
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
npm install --global @lyy-gh/memocap@0.1.0
```

If you use pnpm for this global CLI, keep the same package-manager owner:

```sh
pnpm add --global @lyy-gh/memocap@0.1.0
```

Add the plugin package to the intended OpenCode v1 config. OpenCode accepts JSON
and JSONC, and the v1 config key is `plugin`. See the
[v1.19.3 config reference](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/web/src/content/docs/config.mdx):

```jsonc
{
  "plugin": [
    "@lyy-gh/memocap@0.1.0"
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
memocap-setup update --to 0.1.0 --global --dry-run --json
memocap-setup update --to 0.1.0 --global --yes --json
```

Replace `0.1.0` in both commands with the version returned by `check`. Do not
resolve `latest` again between the plan and execution. The setup command does
not prompt interactively when `--yes` is absent.

When an authorized update runs from a different package version, setup starts an
exact-target `@lyy-gh/memocap@<resolved_version>` worker and verifies the worker
and report versions. It does not fall back to another worker version.

The setup core's dry-run does not fetch update payloads or write config, skill,
manifest, or database state. If npx starts the core, it may still fetch the
runner package and update its own cache first.

Use `--project "/absolute/path/to/repo"` instead of `--global` for a project
integration. `--yes` confirms only the explicitly selected update scope. It
does not authorize overwriting user edits or changing other projects or agents.
When needed, select the existing global package-manager owner with
`--package-manager npm` or `--package-manager pnpm`.

An exact same-version install is a no-op when all owned components match. If an
owned step is incomplete, the installer can repair that same version without
replacing unrelated user state.

### Upgrade from v0.0.10

The v0.0.10 CLI does not include the setup command. Bootstrap the pinned v0.1.0
runner and update through that release's setup logic:

```sh
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup update --to 0.1.0 --global --yes --json
```

Use `--project "/absolute/path/to/repo"` for a project integration. This is a
v0.1.0 release command, not a command available from v0.0.10 alone.

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

The v0.1.0 CLI keeps the core SQLite schema at `1.0` with its existing complete
schema fingerprint. A normal software upgrade or downgrade does not restore a
database backup. A v0.0.10 CLI can still use the compatible core store, but it
does not provide v0.1.0 plugin behavior, structured receipts, or activity
features.

Operational activity is stored separately in `<core filename>.activity.sqlite`,
normally `~/.memocap/memocap.db.activity.sqlite`. It holds bounded operational
history and repository display hints, not a complete audit log. Recall/injection
history is limited to 30 days and 10,000 events; write metadata is capped at
1,000 events. Pruning, expiry, and recording failures can leave gaps. If activity storage
fails after the core memory write succeeds, report the memory write as successful
with an activity warning. Do not repeat `remember` to repair activity history.

Before an optional data backup, use SQLite's backup API or another
WAL-aware procedure. A raw copy can omit committed data while the database uses
WAL. Restoring data is a separate, destructive action and requires an explicit
choice of backup and target. Software rollback alone does not restore or remove
the activity database.

## Verify

Run the read-only doctor for the selected scope:

```sh
memocap-setup doctor --global --json
```

For a project installation, pass its explicit path with `--project`. Static
readiness checks installed files, versions, config, skill discovery, and core
schema compatibility and auxiliary activity availability. It does not prove that an OpenCode session loaded the new
plugin or that a model received recalled memory.

Read the actual `status`, `readiness`, and `runtime` fields:

| Readiness | Meaning |
| --- | --- |
| `installation_ready` | Components match and activity is ready; core memory has not been initialized. |
| `static_ready` | Components match, core schema is compatible, and activity is ready. |
| `incomplete` | Required components or backend inspection are incomplete or versions differ. |
| `activity_not_initialized` | Auxiliary storage is absent; a remote server administrator must prepare it. |
| `activity_degraded` | Auxiliary inspection failed; investigate without replaying successful core writes. |

Doctor exits zero for `installation_ready` or `static_ready`, and nonzero for
an incomplete/degraded installation. Its database inspection makes no logical
writes: it does not change core or activity data/schema, initialize or reset
core data, migrate schema, prune history, or record activity. It also never warms
the binary cache, prepares activity, or runs a model request. Authorized local
install/update can prepare auxiliary storage explicitly while keeping core data
unchanged. `runtime.status` remains `not_run`: runtime QA has not happened, which
is separate from installation failure. SQLite `READ_ONLY` connections may still
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
that has not been changed by the user. It keeps the core database, activity
database, backups, unrelated plugin entries, shared skills, and other agents'
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
npx --yes --package '@lyy-gh/memocap@0.1.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.1.0' memocap-setup install --project 'C:\work\my repo' --yes --json
```

For an update, use `memocap-setup check --global --json`, then pass its exact
resolved version to `memocap-setup update --to 0.1.0 --global --dry-run --json`
and, after reviewing the plan, to the matching `--yes` command. The PowerShell
wrapper in a source checkout forwards the same arguments to the same setup core.

```powershell
memocap-setup check --global --json
memocap-setup update --to 0.1.0 --global --dry-run --json
memocap-setup update --to 0.1.0 --global --yes --json
```
