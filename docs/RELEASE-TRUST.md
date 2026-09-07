# npm Trusted Publishing Migration

The registry job uses the GitHub Environment `npm-release`. This workflow change does not modify npm's existing trusted-publisher configuration. A package owner must complete this migration after the workflow is merged and before the next release.

## Required Operator Steps

1. Sign in to the npm account that administers `@lyy-gh/memocap` and enable 2FA for account changes and publishes if it is not already enabled:

   ```bash
   npm profile enable-2fa auth-and-writes
   ```

2. In the `LYY/memocap` GitHub repository, create the `npm-release` Environment before the first release using this workflow. Configure any required reviewers or deployment restrictions there.

3. List the package's trusted publishers. Identify the existing GitHub publisher for `LYY/memocap` and `release.yml` that has no environment claim, then record its ID:

   ```bash
   npm trust list @lyy-gh/memocap
   ```

4. Revoke only that no-environment publisher:

   ```bash
   npm trust revoke --id <no-environment-trust-id> @lyy-gh/memocap
   ```

5. Create the exact replacement. `--allow-publish` grants npm's `createPackage` permission:

   ```bash
   npm trust github @lyy-gh/memocap --repository LYY/memocap --file release.yml --environment npm-release --allow-publish
   ```

6. Confirm the resulting publisher lists repository `LYY/memocap`, workflow `release.yml`, environment `npm-release`, and publish permission:

   ```bash
   npm trust list @lyy-gh/memocap
   ```

Do not run these commands from CI. They change npm registry trust and require the package owner's 2FA confirmation.
