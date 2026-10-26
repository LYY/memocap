import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { atomicWrite, fingerprint, readJSON, readText } from "./files.mjs";

export function skillLock(scope, runtime) {
  const filename = scope.kind === "project" ? path.join(scope.directory, "skills-lock.json") : runtime.env.XDG_STATE_HOME ? path.join(runtime.env.XDG_STATE_HOME, "skills/.skill-lock.json") : path.join(scope.home, ".agents/.skill-lock.json");
  const lock = readJSON(filename);
  if (lock && (lock.version !== (scope.kind === "project" ? 1 : 3) || !lock.skills || typeof lock.skills !== "object" || Array.isArray(lock.skills))) throw new SetupError("unsupported_skill_lock", `Refusing unknown skills lock: ${filename}`);
  return { filename, entry: lock?.skills.memocap || null, text: readText(filename) };
}

export function legacyPlan(inspection, record, context) {
  const prior = record?.intent?.legacy;
  const legacy = record?.skill?.kind !== "managed" ? record?.skill : null;
  const canonical = legacy?.path || inspection.canonical;
  const present = fs.existsSync(canonical);
  if (!present && !inspection.discovered.length) return prior || (legacy ? { legacy_state: "missing", canonical, fingerprint: legacy.fingerprint, aliases: [], lock: inspection.lock } : null);
  const selected = inspection.selected;
  if (!present) throw new SetupError("unowned_skill", `Legacy canonical is absent but other memocap contents remain: ${canonical}`);
  const proof = legacy?.fingerprint || prior?.fingerprint;
  if (proof && present && fingerprint(canonical) !== proof) throw new SetupError("skill_modified", `Preserving changed legacy skill: ${canonical}`);
  const source = inspection.lock.entry;
  const version = source?.ref?.replace(/^v/, "");
  const installed = context.report.shared_cli;
  const expected = version === installed.version && installed.package_root ? fingerprint(path.join(installed.package_root, "skills/memocap")) : null;
  const provenance = source?.source === "LYY/memocap" && source.sourceType === "github" && ["0.0.10", "0.1.0", "0.2.1", context.target].includes(version) && source.ref === `v${version}` && (source.skillPath === undefined || source.skillPath === "skills/memocap/SKILL.md") && (!source.sourceUrl || ["https://github.com/LYY/memocap.git", `https://github.com/LYY/memocap/tree/v${version}`].includes(source.sourceUrl));
  if ((!prior && (!provenance || !expected || selected?.fingerprint !== expected)) || !selected?.discovery_path) throw new SetupError("unowned_skill", `Cannot prove original legacy contents: ${canonical}`, { lock: source, discovered: inspection.discovered });
  const real = fs.realpathSync(canonical);
  const openCodePaths = new Set([canonical, ...inspection.roots.filter((root) => root.kind === "native").map((root) => path.join(root.path, "memocap"))].map((directory) => path.resolve(directory)));
  const references = [...inspection.discovered, ...inspection.references.filter((reference) => !reference.broken)];
  const shared = references.filter((reference) => !openCodePaths.has(path.resolve(reference.discovery_path)));
  if (shared.length) throw new SetupError("shared_skill_migration_required", "Preserving legacy skill referenced outside this OpenCode installation", { references: shared });
  if (inspection.discovered.some((candidate) => candidate.path !== real)) throw new SetupError("duplicate_skill", "Multiple legacy skill contents are discoverable", inspection.discovered);
  inspection.adoption = { source: "LYY/memocap", ref: source.ref, fingerprint: expected || proof || prior.fingerprint };
  return { legacy_state: "exclusive", canonical, fingerprint: expected || proof || prior.fingerprint, aliases: [...new Set(references.map((reference) => reference.discovery_path))].filter((directory) => path.resolve(directory) !== path.resolve(canonical)), lock: inspection.lock };
}

export function cleanupLegacy(plan) {
  if (!plan || plan.legacy_state === "missing") return { status: "unchanged", legacy_state: plan?.legacy_state || "absent" };
  const lockText = readText(plan.lock.filename);
  if (lockText !== plan.lock.text && lockText !== null && JSON.parse(lockText).skills?.memocap) throw new SetupError("concurrent_change", "Legacy lock changed during cleanup");
  const aliases = [];
  for (const alias of plan.aliases) {
    let stat;
    try { stat = fs.lstatSync(alias); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isSymbolicLink() || (fs.existsSync(alias) && fingerprint(alias) !== plan.fingerprint)) throw new SetupError("skill_modified", `Preserving changed legacy reference: ${alias}`);
    aliases.push(alias);
  }
  const present = fs.existsSync(plan.canonical);
  if (present && fingerprint(plan.canonical) !== plan.fingerprint) throw new SetupError("skill_modified", `Preserving changed legacy skill: ${plan.canonical}`);
  for (const alias of aliases) fs.unlinkSync(alias);
  if (present) fs.rmSync(plan.canonical, { recursive: true });
  if (lockText === plan.lock.text && lockText !== null) {
    const lock = JSON.parse(lockText);
    delete lock.skills.memocap;
    atomicWrite(plan.lock.filename, `${JSON.stringify(lock, null, 2)}\n`, lockText);
  }
  return { status: "changed", legacy_state: "cleaned" };
}
