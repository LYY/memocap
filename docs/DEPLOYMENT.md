# Deployment and Operations

This guide describes the current operator contract for a domain-aware memocap
server. The server owns one SQLite database. It is not a multi-tenant service.

## Trust boundary

The server listens on the configured bind address and accepts only authenticated
`POST` requests under `/v1`. Every request must carry:

```http
Authorization: Bearer <MEMOCAP_TOKEN>
```

One shared bearer token gates the whole server. It is not ACL, IAM, per-user
authorization, or tenant isolation. Anyone who has the token can address the
server's repository, domain, universal, and operation namespaces, subject to
runtime validation. Run the service on a private network or put it behind a
network policy when a shared token is not enough for your trust boundary.
The remote trust boundary is not ACL, IAM, per-user authorization, or tenant isolation.

Bearer authentication does not provide transport confidentiality or integrity.
The server accepts HTTP and does not terminate TLS, so an untrusted network
path could disclose the token and memory content or alter requests in transit.

The server does not scan memory content for secrets and does not auto-classify
memory placement. The OpenCode skill policy is model guidance only. Runtime
validation, namespace selection, and authorization are separate:

| Boundary | Current rule |
| --- | --- |
| Skill policy | Guides least-sharing placement. It is not a compliance guarantee. |
| Runtime validation | Checks repository IDs, registered and attached domains, exact placements, and operation fingerprints. |
| Namespace selection | Uses the default visible stack or an explicit `--domain`, `--universal`, or transfer placement. |
| Authorization | Uses the one remote bearer token. There is no ACL or IAM layer. |

## Compose deployment

`compose.yaml` builds the image, publishes `127.0.0.1:8787:8787` only on the
host loopback interface, stores data in the `memocap-data` volume, and starts
`serve --bind 0.0.0.0:8787` inside the container. The loopback host publish is
the safe default for local plaintext HTTP clients; the container bind still
allows a private Compose-network proxy to reach `memocap:8787`.

```sh
export MEMOCAP_TOKEN='replace-with-a-long-random-token'
docker compose up -d --build
docker compose ps
```

The token is required before the container starts. Keep it out of committed
files and shell history where practical. The volume is the database boundary:
back it up using your normal volume or filesystem procedure before destructive
maintenance. memocap itself does not create an automatic backup for the
recognized-old-schema reset.

For a local client, install the CLI and select the server explicitly:

```sh
pnpm add -g @lyy-gh/memocap@0.0.8
export MEMOCAP_ADDR=http://127.0.0.1:8787
export MEMOCAP_TOKEN='replace-with-a-long-random-token'
memocap scope show
memocap status
```

When `MEMOCAP_ADDR` is set, the CLI is remote only. A missing token fails the
command. It never silently falls back to a local database. With no address, the
CLI remains local and does not use the network.

## Remote deployment

The loopback default prevents public plaintext host publication. It does not
make a deliberately remote deployment secure without transport protection.
Do not replace the default with `8787:8787` or `0.0.0.0:8787:8787`.

For remote clients, the operator must make a TLS-terminating reverse proxy the
only public listener and keep the raw memocap HTTP port on a trusted private
network. The proxy can reach `http://memocap:8787` on its private Compose
network, or `http://127.0.0.1:8787` when it runs on the host. Configure the
proxy with a valid HTTPS certificate, then set `MEMOCAP_ADDR` to the proxy's
`https://` endpoint and provide the shared `MEMOCAP_TOKEN` to each client.

This deployment guidance is not an implementation of TLS, ACL, IAM, per-user
authorization, or tenant isolation. The one bearer token remains a shared
service credential after TLS termination.

## Domain lifecycle

A domain registry entry is reusable metadata. An attachment binds that entry to
the current repository and gives it an ordered visible-stack position.

```sh
memocap scope domain create rust/cli
memocap scope domain attach rust/cli
memocap scope domain list
memocap scope show
memocap scope domain detach rust/cli
memocap scope domain delete rust/cli
```

Use `--before <DOMAIN>` on attach to insert before an existing attachment. Use
`scope domain list --all` to inspect every registered domain, including domains
not attached to the current repository. A domain must be registered before it
can be attached. Domain deletion is for an unused registry entry and does not
delete memory as a substitute for `forget`.

The `scope show` output includes `active_scope`, `repository_id`, `source`, and
the ordered `attached_domains` list. Repository identity comes from a stable
supported Git remote when possible, falls back to the Git common directory for
ambiguous or unsupported remotes, and uses the canonical non-Git directory path
outside Git.

## Placements and visible stack

Memory placements are:

| Placement | Selector | Meaning |
| --- | --- | --- |
| Repository | `repository:<64 lowercase hex>` | Current repository memory. Default for unselected writes. |
| Domain | `domain:<DOMAIN>` or `--domain <DOMAIN>` | Reusable memory for a domain already attached to this repository. |
| Universal | `universal` or `--universal` | Stable knowledge shared across repositories and domains. |

The default read stack is repository, attached domains in persisted order, then
universal. A repository record with the same non-empty normalized topic shadows
matching records in lower tiers. A domain record shadows matching universal
records. Domains do not shadow one another.

`recall` removes shadowed records before applying `--limit` and `--max-chars`.
`list` and TUI List retain addressable records, including shadowed records, and
show their placement, source order, and shadow cause. `status` reports each
source's addressable and effective counts plus totals. Deleting the shadowing
record restores the next lower visible record.

## Copy, move, and provenance

Use exact placements for transfers:

```sh
memocap scope copy \
  --id 7 \
  --from repository:<REPOSITORY_HASH> \
  --to domain:rust/cli \
  --note 'shared crate guidance'

memocap scope move \
  --id 8 \
  --from domain:rust/cli \
  --to universal \
  --yes
```

Copy preserves the source memory and creates a destination memory. Move retains
the memory ID and changes its placement. Source and destination must differ.
The first transfer provenance is immutable. Later transfer events are separate
operation-ledger rows.

An operation ID may be supplied, or one is derived from the canonical request.
An exact committed request replays its stored result without another mutation,
even after a fresh process or a domain attachment change. Reusing the same
operation ID with a changed request fingerprint returns a conflict and does
not mutate storage.

## Remote protocol

The server exposes these authenticated `POST` routes under `/v1`:

| Route | Purpose |
| --- | --- |
| `/v1/memories/remember` | Store one memory at an exact placement. |
| `/v1/memories/recall` | Recall effective memories from the visible stack or one selected placement. |
| `/v1/memories/list` | List addressable inventory from the visible stack or one selected placement. |
| `/v1/memories/forget` | Delete one ID from one exact placement. |
| `/v1/domains/create` | Register a domain. |
| `/v1/domains/list` | List current attachments or the registry. |
| `/v1/domains/attach` | Attach a registered domain to a repository. |
| `/v1/domains/detach` | Remove a repository attachment. |
| `/v1/domains/delete` | Delete an unused registered domain. |
| `/v1/memories/copy` | Copy one memory between exact placements. |
| `/v1/memories/move` | Move one memory between exact placements. |
| `/v1/operations/status` | Read one operation outcome by repository, operation ID, and request fingerprint. |
| `/v1/status` | Read attached domains and visible-stack counts. |

Legacy unversioned routes such as `/remember`, `/recall`, `/list`, `/forget`,
and `/status` are removed, not deprecated. There is no route fallback and no
remote-to-local fallback.
There is no route fallback and no remote-to-local fallback.

## Response-loss recovery

Copy and move use the operation ledger to make an ambiguous request recoverable.
When the client cannot establish the response outcome, it derives a strict
handle from the repository, operation ID, and request fingerprint. The CLI
uses that handle with:

```sh
memocap operation status --recovery '<RECOVERY_HANDLE>'
```

The status result can be committed, `not_found`, or unknown. An HTTP 500,
transport failure, or status lookup failure can leave the outcome unknown.
`not_found` alone does not prove manual replay is safe, and an operation status
request can itself become unknown. Operation status request can itself become unknown. Do not manually replay a lost request from a
bare `not_found` observation. Keep and use the issued strict handle and repeat
the status procedure according to your incident policy.
not_found alone does not prove manual replay is safe.
operation status request can itself become unknown.

## TUI operations

`memocap ui` and `memocap` without a subcommand open the same three-action menu:

1. `Status`, showing schema version, ordered placements, addressable/effective
   counts, totals, repository ID, and local or remote target.
2. `List visible memories`, showing the shared addressable inventory with
   placement and shadow annotations. Paging is read-only and returns to the
   menu.
3. `Exit`.

Write, delete, and legacy host actions are removed from the TUI, not deprecated.

## Schema and recovery maintenance

Schema policy is authoritative in [SCHEMA-VERSIONING.md](SCHEMA-VERSIONING.md).
The current schema is `1.0`. The only no-confirmation bulk-delete exception is
an exact recognized pre-versioned database. It resets transactionally to schema
`1.0`, deletes all old memory rows, creates no backup, and emits the required
reset notice. A merely similar, malformed, higher-minor, or different-major
database refuses without mutation. There is no standalone reset command.

Before maintenance, record the volume snapshot or backup required by your
deployment policy. For ordinary deletion, use the exact `forget` placement and
ID. For a transfer, record its operation ID and recovery handle in the operator
log.
