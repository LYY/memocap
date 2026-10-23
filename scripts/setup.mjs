#!/usr/bin/env node
import { runSetup } from "./setup/core.mjs";

const report = await runSetup(process.argv.slice(2));
if (report.error) process.stderr.write(`${report.error.code}: ${report.error.message}\n`);
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
else if (process.argv.includes("--help")) process.stdout.write(`${report.usage}\n`);
else {
  process.stdout.write(`${report.operation}: ${report.status}; target ${report.resolved_version || "unknown"}\n`);
  if (report.plan) {
    process.stdout.write(`CLI (${report.plan.cli.scope}): ${report.plan.cli.action}; ${report.plan.cli.manager}; ${report.plan.cli.target_version}\n`);
    for (const scope of report.plan.scopes) process.stdout.write(`${scope.kind}: ${scope.plugin.config}; plugin ${scope.plugin.pin}; skill ${scope.skill.source}\n`);
  }
  for (const step of report.steps) process.stdout.write(`${step.component} (${step.scope}): ${step.status}\n`);
  process.stdout.write(`readiness: ${report.readiness}; runtime: ${report.runtime.status}; restart_required: ${report.restart_required}\n`);
  for (const warning of report.warnings) process.stderr.write(`${warning.code}: ${warning.message}\n`);
}
process.exitCode = report.exit_code;
