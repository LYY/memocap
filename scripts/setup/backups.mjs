import { randomUUID } from "node:crypto";
import path from "node:path";
import { packageName, SetupError } from "./arguments.mjs";
import { pluginSource } from "./config.mjs";
import { atomicWrite, fingerprint, readText } from "./files.mjs";

export function prepareBackups(context, inspections) {
  const expected = fingerprint(path.join(context.runtime.packageRoot, "skills/memocap"));
  const needed = context.report.shared_cli.version !== context.target || !context.report.shared_cli.executable_path || inspections.some(({ plugin, skill }) =>
    plugin.entries.length !== 1 || pluginSource(plugin.entries[0]) !== `${packageName}@${context.target}` || skill.selected?.fingerprint !== expected || (skill.lock.entry?.ref !== `v${context.target}` && skill.lock.entry?.sourceUrl !== `https://github.com/LYY/memocap/tree/v${context.target}`));
  if (!needed) return;
  const snapshots = new Map([[context.manifestPath, context.manifestText], ...inspections.map(({ scope }) => [scope.config, scope.text])]);
  for (const [filename, previous] of snapshots) {
    if (readText(filename) !== previous) throw new SetupError("concurrent_change", `File changed before backup: ${filename}`);
    if (previous === null) continue;
    const backup = `${filename}.memocap-before-${Date.now()}-${randomUUID()}`;
    atomicWrite(backup, previous, null);
    context.report.backups.push(backup);
  }
}
