import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const linuxOnly = new Set([
  "release-ancestry.test.cjs",
  "release-reconciliation.test.cjs",
  "release-registry.test.cjs",
  "release-registry-retry.test.cjs",
]);

export function selectNodeTests(
  platform = process.platform,
  directory = resolve(import.meta.dirname, "../tests"),
) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.cjs"))
    .map((entry) => entry.name)
    .filter((name) => platform === "linux" || !linuxOnly.has(name))
    .sort()
    .map((name) => resolve(directory, name));
}

if (import.meta.main) {
  const execution = spawnSync(process.execPath, ["--test", ...selectNodeTests()], {
    stdio: "inherit",
  });
  if (execution.error) throw execution.error;
  process.exitCode = execution.status ?? 1;
}
