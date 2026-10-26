# Install and Update

This guide covers package target `0.3.0` and tag target `v0.3.0`. Keep the CLI,
OpenCode plugin, and runtime skill on the same release unless you are following
an explicit recovery procedure.

## Requirements

- Node.js 22.20 or later, with npm and npx.
- OpenCode 1.19.3. The installer does not install or upgrade OpenCode.

The managed skill comes from the exact npm package, so Git is not required for
the default install. npm registry access or an npx package download may still
require network access.

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

This installs the user-level CLI, OpenCode integration, and managed runtime skill
from the exact v0.3.0 package. It does not select a memory placement:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --global --yes --json
```

The worker copies `skills/memocap` from that package, including every reference
file, into one versioned directory named with the full payload digest. It
registers the same absolute directory for the plugin and in `skills.paths`.
There is no separate skill-install command in this flow. The installer reports
each CLI, plugin, skill, configuration, and backend step. After prerequisites and
authorization, local install/update prepares a missing or exact schema `1.0` main
database, then verifies it by readback. Preparation may prune retained activity.
Before bridging a legacy database, make a WAL-aware backup as described below.
The outer npx command may download the runner and update its cache before setup
starts.

## Project install

Pass the full project path explicitly. Quote paths that contain spaces:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup install --project "/absolute/path/to/repo" --yes --json
```

This configures the project integration and project managed skill. If the project
inherits one exact, matching global owner, setup reuses it without adding a
project plugin or second skill path. Review the reported owner and project
configuration changes before committing them.

Global and project describe where the integration is installed. They do not
select where memories are stored. Memory placement remains repository,
attached-domain, or universal under the existing scope rules.

## Managed skill and config ownership

The setup worker copies the complete skill from its own exact npm package into
`<config-root>/memocap/policies/<version>-<full-digest>/memocap`. The directory
contains `SKILL.md` and `references/`. The same absolute path is saved as the
plugin tuple's `skillDirectory` and in `skills.paths`; the plugin checks the
selected files against its own package digest and fails visibly if they differ.

The config root is resolved independently from the config file being edited:

- Global: resolved `OPENCODE_CONFIG_DIR`, if set; otherwise
  `$XDG_CONFIG_HOME/opencode` or `$HOME/.config/opencode`.
- Project: `<project>/.opencode`.

`--config <FILE>` selects the persistent configuration file to edit. It does not
move the skill directory, and the file must be part of an active OpenCode config
layer. A project inheriting one exact matching global owner reuses it. A
different or unknown owner, changed or duplicate skill, ambiguous registration,
remote `skills.urls`, or an inactive config target stops preflight before writes.
Config layers append plugin entries, so the installer does not resolve conflicts
by renaming, last-wins assumptions, or `--yes`.

Known format-1 setup manifests are read without changing their bytes. The first
explicit install, update, or uninstall upgrades format 1 to format 2 under the
setup lock. This ownership migration does not recreate a previously removed
canonical skill or rewrite old links and locks. A shared legacy skill still
referenced by other agents stops with `shared_skill_migration_required`; its
files, links, and locks remain untouched. Unknown manifest formats are refused.

## Optional standalone skill for another agent

The standalone Skills CLI remains a separate choice for another agent or a
standalone skill install. Its source and later updates use the versioned GitHub
tree, independent of the npm-managed OpenCode path:

```sh
npx --yes skills@1.7.4 add https://github.com/LYY/memocap/tree/v0.3.0 --skill memocap --agent '<other-agent-id>' --global --yes
```

Replace `<other-agent-id>` with the supported agent identifier. This command does
not install the memocap CLI or OpenCode plugin. For a later standalone update,
use that installation's recorded GitHub source and the matching release tag with
the Skills CLI. This is not a second step for the managed OpenCode install;
adding another visible `memocap` skill to that same OpenCode context can create a
duplicate-source conflict. The source checkout's
`scripts/install.sh` and `scripts/install.ps1` only forward arguments and exit
status to the same setup core.

## Check and update

Check is read-only. It compares the installed CLI, plugin, and skill and records
one resolved stable version for this check:

```sh
memocap-setup check --global --json
```

For an authorized update, copy the exact `resolved_version` from that check.
Review the exact-target dry-run, then execute the same target with `--yes`:

```sh
memocap-setup update --to 0.3.0 --global --dry-run --json
memocap-setup update --to 0.3.0 --global --yes --json
```

Use the exact `resolved_version` returned by `check` in both commands; the
examples pin the current v0.3.0 target. Do not resolve `latest` again between
the plan and execution. The setup command does not prompt interactively when
`--yes` is absent. `check` is informational: read its `readiness` field, not
only its successful command exit, to determine whether the database is ready.

When an authorized update runs from a different package version, setup starts an
exact-target `@lyy-gh/memocap@<resolved_version>` worker and verifies the worker
and report versions. It does not fall back to another worker version.

The setup core's dry-run does not fetch the target worker or write config,
skill, manifest, or database state. If npx starts the core, it may still fetch
the explicitly pinned runner package and update its own cache first. A check
without `--to` may query the npm registry for the stable version. Check, doctor,
and dry-run never prepare, migrate, or prune the database.

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
is not a successful readiness result. Bootstrap the exact v0.3.0 runner with
the authorized update, then inspect and prepare through the target setup logic.
Before running it against a database that may be schema `1.0`, make a WAL-aware
backup:

```sh
npx --yes --package @lyy-gh/memocap@0.3.0 memocap-setup update --to 0.3.0 --global --yes --json
```

Use `--project "/absolute/path/to/repo"` for a project integration. The target
installer reports schema `1.0` as `upgrade_needed`, prepares the local main
database, and verifies the result.

## What changes

The CLI is a user-level package and may be shared across projects. Setup reuses
an identifiable npm or pnpm owner. `--global` or `--project` selects the OpenCode
plugin entry, managed skill, and per-scope ownership metadata. Setup does not
edit shell profiles, run with `sudo`, install Node.js or Git, configure a
provider, make model calls, or restart OpenCode.

The skill is an ordinary package copy under the resolved config root. Its full
directory digest, not just its version, identifies the payload. The same absolute
directory is registered for host discovery and passed to the plugin. JSONC
comments, unrelated plugin entries, tuple options, and skill paths are preserved
by a single compare-and-swap config update. If the selected file changes during
the operation, setup preserves the concurrent bytes and reports the conflict.

The installer inspects local external, native, and explicit skill roots across
the active config layers. Changed, unknown, duplicate, or ambiguous `memocap`
sources are reported before writes. A project that inherits one exact known
global owner reuses it. When a different-version runner is used, the update
starts the exact `@lyy-gh/memocap@<resolved_version>` worker and verifies its
report; it never falls back to another worker. The command does not call
`npx skills add/list/remove`, fetch a GitHub skill tag, or mutate other agents'
links as part of this default path.

`--yes` confirms only the explicitly selected scopes and does not bypass
ownership, conflict, user-edit, or permission checks. Unknown shared consumers
are not enumerated. Resolve reported conflicts through an explicitly authorized
user action, then read current state before resuming the same target.

## Data and compatibility

Package `0.3.0`, schema `2.0`, and receipt format `1` are independent
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
database compatibility and activity availability. It reports configured paths;
it does not prove that a running OpenCode session loaded the plugin or skill.

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

After restarting OpenCode yourself, use a new session and verify the live
instance. `opencode debug skill` must show the actual `memocap` skill location.
In that session, `/memory status` must report `policy.mode: "managed"` and the
actual `policy.directory`, `policy.mainPath`, `policy.version`, and
`policy.digest`. The host location and `policy.directory` must resolve to the
same directory; the version and full digest must match the installed payload.
These are runtime fields, not `doctor` fields, and the policy object has no
`source` property. The skill rules are added at compaction; setup does not force
them into every turn or prove that a model adopted them. Without a real session,
report static readiness and `runtime.status: not_run`. A changed plugin or skill
may require a restart, reported as `restart_required`; the installer never
restarts OpenCode.

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

Uninstall removes only the plugin entry and path registrations the installer can
prove it owns and that have not been changed by the user. It removes a managed
payload only when its full digest still matches and no config, owner, or agent
references it. Shared or modified payloads and legacy skills are retained and
reported. The main database, activity, backups, unrelated plugin entries, and
other agents' installations remain. The global CLI is kept unless
`--remove-cli` is explicitly requested. If another integration refers to that
CLI, the installer reports the reference and leaves it in place.

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
npx --yes --package '@lyy-gh/memocap@0.3.0' memocap-setup install --global --yes --json
npx --yes --package '@lyy-gh/memocap@0.3.0' memocap-setup install --project 'C:\work\my repo' --yes --json
```

For an update, use `memocap-setup check --global --json`, then pass its exact
resolved version to `memocap-setup update --to 0.3.0 --global --dry-run --json`
and, after reviewing the plan, to the matching `--yes` command. The PowerShell
wrapper in a source checkout forwards the same arguments to the same setup core.

```powershell
memocap-setup check --global --json
memocap-setup update --to 0.3.0 --global --dry-run --json
memocap-setup update --to 0.3.0 --global --yes --json
```
