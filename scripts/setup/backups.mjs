import { randomUUID } from "node:crypto";
import { packageName, SetupError } from "./arguments.mjs";
import { pluginSource } from "./config.mjs";
import { atomicWrite, readText } from "./files.mjs";

export function prepareBackups(context, inspections) {
  const needed = context.report.shared_cli.version !== context.target || !context.report.shared_cli.executable_path || inspections.some(({ plugin, skill }) =>
    plugin.entries.length !== 1 || pluginSource(plugin.entries[0]) !== `${packageName}@${context.target}` || skill.observed?.digest !== context.bundle.digest || skill.managed?.version !== context.target);
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
