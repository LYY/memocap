# Repository Agent Instructions

## npm Trusted Publisher

`@lyy-gh/memocap` has an active npm trusted publisher bound to:

- repository: `LYY/memocap`
- workflow: `.github/workflows/release.yml`
- GitHub Environment: `npm-release`

Do not use `npm whoami`, `npm trust list`, npm token commands, or npm login
commands to validate this binding. Those commands depend on local npm account
authentication and a `401 Unauthorized` result is not a release failure or
evidence that the trusted publisher is unbound.

The release contract is the `registry` job in `.github/workflows/release.yml`:

- it uses `environment: npm-release`;
- it grants `id-token: write`;
- it publishes with `npm publish --access public --provenance --ignore-scripts`.

The sole release acceptance evidence is a successful GitHub Actions `registry`
job, including its registry metadata, integrity, and provenance verification.
Investigate trusted-publisher configuration only when that job fails. Do not
automatically create, change, or remove npm trust relationships.
