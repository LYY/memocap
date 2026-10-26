import { packageName, SetupError } from "./arguments.mjs";

export async function delegateWorker(argv, context) {
  const forwarded = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--to") { index++; continue; }
    if (argv[index] !== "--worker" && argv[index] !== "--json") forwarded.push(argv[index]);
  }
  const args = ["--yes", "--package", `${packageName}@${context.target}`, "memocap-setup", ...forwarded, "--to", context.target, "--worker", "--json"];
  const execution = await context.runtime.run("npx", args, { cwd: context.runtime.cwd, env: context.runtime.env });
  let report;
  try { report = JSON.parse(execution.stdout); }
  catch { throw new SetupError("worker_failed", "Exact target worker did not produce a report; no fallback was attempted", { args, code: execution.code, stderr: execution.stderr }); }
  if (report.format_version !== 1 || report.runner_version !== context.target || report.resolved_version !== context.target || typeof report.exit_code !== "number") {
    throw new SetupError("worker_version_mismatch", "Target worker response identity does not match frozen version", { expected: context.target, reported: report.runner_version });
  }
  if (execution.code !== report.exit_code) throw new SetupError("worker_exit_mismatch", "Target worker process/report exit codes differ", { execution, report });
  return { ...report, bootstrap_runner_version: context.report.runner_version, delegated_worker: true };
}

export function sharedImpact(context, inspections = []) {
  const selected = new Set(context.scopes.map((scope) => scope.id));
  for (const inspection of inspections) if (inspection.owner_reused && inspection.owner?.record?.skill?.version === context.target) selected.add(inspection.owner_id);
  const references = Object.entries(context.manifest.installs).filter(([id]) => !selected.has(id)).map(([id, record]) => ({ id, version: record.version, config: record.config, directory: record.directory }));
  context.report.shared_cli.other_known_installs = references;
  context.report.shared_cli.unknown_installs = "not_enumerated";
  if (context.report.shared_cli.version !== context.target && references.length) throw new SetupError("shared_cli_conflict", "Include all known affected scopes explicitly before changing the shared CLI", references);
}
