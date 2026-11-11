import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scoreCase, summarize } from "../tests/retrieval-evaluation/scoring.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests/retrieval-evaluation");
const { values } = parseArgs({options: {
  binary:{type:"string", default:path.join(root, "target/debug/memocap")},
  protocol:{type:"string", default:path.join(root, "plugin/protocol.js")},
  split:{type:"string", default:"tuning"},
  "query-mode":{type:"string", default:"plugin"},
  "recall-args":{type:"string", default:"[]"},
  output:{type:"string"}, help:{type:"boolean"},
}});
if (values.help) {
  console.log("node scripts/evaluate-retrieval.mjs [--binary PATH] [--protocol PATH] [--split tuning|holdout|all] [--query-mode plugin|raw] [--recall-args JSON_ARRAY] [--output REPORT.json]");
  process.exit(0);
}
assert.ok(["tuning", "holdout", "all"].includes(values.split), "Invalid split");
assert.ok(["plugin", "raw"].includes(values["query-mode"]), "Invalid query mode");
const extraArgs = JSON.parse(values["recall-args"]);
assert.ok(Array.isArray(extraArgs) && extraArgs.every((arg) => typeof arg === "string"));
const reserved = new Set(["--limit", "--max-chars", "--match", "--repo", "--repository-id", "--targets-json",
  "--json", "--domain", "--universal", "--caller-json", "--"]);
assert.ok(extraArgs.every((arg) => !reserved.has(arg.split("=")[0])), "Budget, selector and receipt overrides are reserved");
const binary = path.resolve(values.binary);
const protocol = path.resolve(values.protocol);
const protocolSource = readFileSync(protocol, "utf8");
const { queryTerms, referenceBlock, validateMemories } = await import(pathToFileURL(protocol).href);
const queryExport = protocolSource.match(/export\s*\{\s*queryTerms\s*\}\s*from\s*["']([^"']+)["']/u);
const querySource = queryExport ? fileURLToPath(new URL(queryExport[1], pathToFileURL(protocol))) : protocol;
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const load = (name) => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
const frozen = load("freeze.json");
for (const [name, hash] of Object.entries(frozen.sha256)) {
  assert.equal(digest(path.join(fixtures, name)), hash, `Frozen fixture changed: ${name}`);
}
const records = load("corpus.json").records.map((record) => ({...record,
  content:record.content + (record.repeat ? record.repeat.text.repeat(record.repeat.count) : "") + (record.suffix ?? ""),
}));
assert.equal(new Set(records.map((record) => record.id)).size, records.length);
const splits = values.split === "all" ? ["tuning", "holdout"] : [values.split];
const cases = splits.flatMap((split) => {
  const expectations = load(`${split}.expected.json`);
  const queries = load(`${split}.queries.json`);
  assert.deepEqual(Object.keys(expectations).sort(), queries.map((query) => query.id).sort());
  return queries.map((query) => ({...query, split, expected:expectations[query.id]}));
});
for (const query of cases) {
  assert.ok(["A", "B"].includes(query.context));
  assert.ok(query.selector === undefined || JSON.stringify(query.selector) === '["--universal"]');
  for (const id of [...query.expected.expectedIDs, ...(query.expected.forbiddenIDs ?? [])]) {
    assert.ok(records.some((record) => record.id === id), `Unknown fixture ID: ${id}`);
  }
}
const sandbox = mkdtempSync(path.join(tmpdir(), "memocap-retrieval-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("MEMOCAP_") && !key.startsWith("GIT_") && !["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)));
Object.assign(env, {HOME:sandbox, MEMOCAP_HOME:sandbox, MEMOCAP_DB:path.join(sandbox, "fixture.db"),
  MEMOCAP_DATA_DIR:path.join(sandbox, "data"), XDG_CONFIG_HOME:path.join(sandbox, "config"),
  XDG_DATA_HOME:path.join(sandbox, "data"), XDG_CACHE_HOME:path.join(sandbox, "cache")});
for (const directory of ["A", "B", "config", "data", "cache"]) mkdirSync(path.join(sandbox, directory));
function cli(argv) {
  const started = performance.now();
  const result = spawnSync(binary, [...argv, "--json"], {cwd:sandbox, env, encoding:"utf8", timeout:30000, maxBuffer:4 * 1024 * 1024});
  const wallMs = performance.now() - started;
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `CLI failed: ${JSON.stringify(argv)}\n${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout);
  assert.ok(["ok", "empty", "inserted"].includes(receipt.status), result.stdout);
  assert.equal(receipt.backend, "local");
  return {receipt, wallMs};
}
try {
  const targets = Object.fromEntries(["A", "B"].map((name) => [name,
    cli(["scope", "resolve", "--repo", path.join(sandbox, name)]).receipt.targets]));
  cli(["scope", "domain", "create", "synthetic-ops", "--repo", path.join(sandbox, "A")]);
  for (const name of ["A", "B"]) cli(["scope", "domain", "attach", "synthetic-ops", "--repo", path.join(sandbox, name)]);
  const ids = new Map();
  const placements = new Map();
  for (const record of records) {
    const selector = record.origin === "universal" ? ["--universal"]
      : record.origin === "domain" ? ["--domain", "synthetic-ops"] : [];
    const args = ["remember", record.content, "--force", "--repo", path.join(sandbox, record.origin === "B" ? "B" : "A"), ...selector];
    if (record.topic) args.push("--topic", record.topic);
    const receipt = cli(args).receipt;
    assert.equal(receipt.returned_ids.length, 1);
    ids.set(receipt.returned_ids[0], record.id);
    placements.set(record.id, receipt.results[0].memory.placement);
  }
  for (const placement of new Set(placements.values())) {
    const readback = cli(["list", "--placement", placement, "--limit", "100", "--repo", path.join(sandbox, "A")]).receipt;
    for (const record of records.filter((item) => placements.get(item.id) === placement)) {
      assert.ok(readback.results.some((entry) => ids.get(entry.memory.id) === record.id && entry.memory.content === record.content),
        `Seed readback failed: ${record.id}`);
    }
  }
  const seedBytes = statSync(env.MEMOCAP_DB).size;
  const logical = (id) => { assert.ok(ids.has(id), `Unexpected result ID: ${id}`); return ids.get(id); };
  const rows = cases.map((query) => {
    const terms = values["query-mode"] === "plugin" ? queryTerms(query.prompt) : [query.prompt];
    const argv = ["recall", terms.join(" "), ...extraArgs, "--match", "any", "--limit", "3", "--max-chars", "6000",
      "--targets-json", JSON.stringify(targets[query.context]), ...(query.selector ?? [])];
    const {receipt, wallMs} = cli(argv);
    validateMemories(receipt);
    const block = referenceBlock(receipt, {});
    assert.ok(block.text.length <= 6000);
    const references = JSON.parse(block.text.slice(block.text.indexOf("\n") + 1)).references;
    const complete = references.filter((reference) => reference.content === records.find((record) => record.id === logical(reference.id)).content)
      .map((reference) => logical(reference.id));
    const observed = {returned:receipt.returned_ids.map(logical),
      candidates:Array.isArray(receipt.matched_ids) ? receipt.matched_ids.map(logical) : null, complete};
    const selectorLeakage = query.selector ? observed.returned.filter((id) => records.find((record) => record.id === id).origin !== "universal") : [];
    const score = scoreCase(query.expected, observed, records);
    return {id:query.id, split:query.split, family:query.family, context:query.context, prompt:query.prompt,
      expected:query.expected, expectedOrigins:[...new Set(records.filter((record) => query.expected.expectedIDs.includes(record.id)).map((record) => record.origin))],
      argv:[...argv, "--json"].map((arg) => arg.replaceAll(sandbox, "<sandbox>")),
      queryTerms:receipt.query_terms, ...observed, selectorLeakage, score:{...score, success:score.success && selectorLeakage.length === 0},
       wallMs, status:receipt.status, discovery:receipt.discovery ?? null, searchedPlacements:receipt.searched_placements,
      referenceChars:block.text.length, injected:references.map((reference) => logical(reference.id)),
      partial:references.filter((reference) => !complete.includes(logical(reference.id))).map((reference) => logical(reference.id)),
       truncated:receipt.truncated, sourceResolution:{status:"not_run"}};
  });
  const groups = (key) => Object.fromEntries([...new Set(rows.flatMap(key))].map((name) =>
    [name, summarize(rows.filter((row) => key(row).includes(name)))]));
  const report = {schema:1, measuredAt:new Date().toISOString(), binary, binarySha256:digest(binary),
    packageVersion:cli(["status", "--read-only", "--repo", path.join(sandbox, "A")]).receipt.package_version,
    runtime:process.version, platform:`${process.platform}/${process.arch}`, fixtureFreeze:frozen,
    protocolPath:protocol, protocolSha256:digest(protocol),
    queryImplementation:{path:querySource, sha256:digest(querySource),
      functionSha256:createHash("sha256").update(queryTerms.toString()).digest("hex")},
    queryMode:values["query-mode"], recallArgs:extraArgs,
     scope:"per-case receipt discovery; a null discovery denotes the legacy selected-repository stack",
    budget:{limit:3, cliContentChars:6000, pluginReferenceUTF16Chars:6000},
    observability:{candidateCoverage:"visible pre-budget matched_ids; not raw candidates", indexOnlyBytes:null, peakRSS:null,
      captureMetrics:"not run: labeled fixtures only"},
    databaseBytes:{afterSeed:seedBytes, afterEvaluation:statSync(env.MEMOCAP_DB).size},
    total:summarize(rows), bySplit:groups((row) => [row.split]), byFamily:groups((row) => [row.family]),
    byExpectedOrigin:groups((row) => row.expectedOrigins.length ? row.expectedOrigins : ["no-answer"]), cases:rows};
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) writeFileSync(path.resolve(values.output), output, {flag:"wx"});
  else process.stdout.write(output);
  console.error(JSON.stringify({bySplit:report.bySplit, databaseBytes:report.databaseBytes}));
} finally {
  rmSync(sandbox, {recursive:true, force:true});
}
