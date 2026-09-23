"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const pluginPath = path.join(root, "plugin/cli.js");
const staticSkillPath = path.join(root, "skills/memocap/SKILL.md");
const generatedRulesPath = path.join(root, "src/lib.rs");
const begin = "<!-- memocap:begin -->";
const end = "<!-- memocap:end -->";
const generatedPrefix = 'pub const SKILL_GUIDANCE: &str = r#"';

function guidanceBlock(text) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start);
  assert.notEqual(start, -1, "guidance block should begin");
  assert.notEqual(finish, -1, "guidance block should end");
  return text.slice(start, finish + end.length).replaceAll("\r\n", "\n");
}

function generatedRules(source = fs.readFileSync(generatedRulesPath, "utf8")) {
  const start = source.indexOf(generatedPrefix);
  assert.notEqual(start, -1, "generated guidance constant should exist");
  const contentStart = start + generatedPrefix.length;
  const finish = source.indexOf('"#;', contentStart);
  assert.notEqual(finish, -1, "generated guidance constant should end");
  return guidanceBlock(source.slice(contentStart, finish));
}

function staticRules() {
  return guidanceBlock(fs.readFileSync(staticSkillPath, "utf8"));
}

function statements(text) {
  return guidanceBlock(text)
    .split("\n")
    .map((line) => line.trim().replace(/^-\s+/, ""))
    .filter(Boolean);
}

const decisions = [
  {
    name: "reject unsafe candidates",
    lead: /^1\. Reject:/,
    requirements: [/never.*secrets.*credentials.*instruction-bearing/i],
  },
  {
    name: "repository-specific",
    lead: /^2\. Repository-specific:/,
    requirements: [/current repository/i, /paths/i, /dependency usage/i],
  },
  {
    name: "attached-domain reusable",
    lead: /^3\. Attached-domain reusable:/,
    requirements: [/--domain <ID>/i, /already attached/i, /scope show/i],
  },
  {
    name: "universal cross-domain",
    lead: /^4\. Universal cross-domain:/,
    requirements: [/--universal/i, /unrelated repositories/i, /domains/i],
  },
  {
    name: "split mixed candidates",
    lead: /^5\. Split mixed:/,
    requirements: [/different placements/i, /classify each/i],
  },
  {
    name: "repository fallback",
    lead: /^6\. Uncertain:/,
    requirements: [/current repository/i, /uncertain/i],
  },
];

const safeguards = [
  ["recall first", /Recall-first.*recall on every utterance.*then answer/i],
  ["similar check", /similar-check.*then store/i],
  ["current instructions win", /must not override the user's current instructions/i],
  ["inspect scope before first store", /before the first.*remember.*scope show.*unless.*already known/i],
  ["no automatic domain mutation", /Never create or attach a domain automatically/i],
  ["explicit topic replacement", /--topic.*only for an explicit replacement relationship/i],
  ["copy existing memory", /scope copy.*preserve the source memory/i],
  ["move only explicitly", /scope move.*--yes.*explicit relocation/i],
  ["write report", /after each write.*selected placement.*short rationale/i],
  ["model limitation", /guides model behavior.*does not guarantee it/i],
  ["CLI limitation", /CLI does not scan for secrets/i],
];

const retrievalPolicies = [
  ["preserve exact facts", [
    /^Preserve exact facts\b/i,
    /\bgeneralization supplements\b/i,
    /\brather than replaces\b/i,
  ]],
  ["query aliases", [
    /^Put likely user query wording and aliases\b/i,
    /\bcontent or tags\b/i,
    /\bAND matching\b.*\bFTS\b/i,
  ]],
  ["separate knowledge layers", [
    /^Treat\b/i,
    /\brepository-specific implementation\b/i,
    /\breusable method\b/i,
    /\bseparate layers\b/i,
  ]],
  ["split divergent lifecycle layers", [
    /^Store\b/i,
    /\bdual-layer memory\b/i,
    /\bonly when both layers share placement and lifecycle\b/i,
    /\botherwise split records\b/i,
    /\bclassify each separately\b/i,
  ]],
  ["evidence-backed generalization", [
    /^Generalize a rule only when\b/i,
    /\bevidence supports it\b/i,
  ]],
  ["topic replacement only", [
    /^Use\s+`--topic`\s+only for\b/i,
    /\breplacement relationship\b/i,
    /\bnever association\b/i,
    /\bcontent\/tags\b.*\bretrieval associations\b/i,
  ]],
];

const examples = [
  ["repository", /Repository example:.*src\/release\.rs.*repository/i],
  ["attached domain", /Attached-domain example:.*rust\/cli.*--domain rust\/cli/i],
  ["universal", /Universal example:.*HTTP 429.*any codebase.*--universal/i],
  ["mixed", /Mixed example:.*src\/db\.rs.*parameterized SQL.*split/i],
  ["uncertain", /Uncertain example:.*compact output improves scanability.*repository/i],
];

function assertPolicy(text) {
  const lines = statements(text);
  const positions = decisions.map((decision) => {
    const position = lines.findIndex((line) => decision.lead.test(line));
    assert.notEqual(position, -1, `guidance includes ${decision.name}`);
    for (const requirement of decision.requirements) {
      assert.match(lines[position], requirement, `${decision.name} includes ${requirement}`);
    }
    return position;
  });
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index], "least-sharing decisions keep exact order");
  }
  for (const [name, pattern] of safeguards) {
    assert.ok(lines.some((line) => pattern.test(line)), `guidance includes ${name}`);
  }
  for (const [name, pattern] of retrievalPolicies) {
    assert.ok(
      lines.some((line) => (Array.isArray(pattern) ? pattern.every((part) => part.test(line)) : pattern.test(line))),
      `guidance includes ${name}`,
    );
  }
  for (const [name, pattern] of examples) {
    assert.ok(lines.some((line) => pattern.test(line)), `guidance includes ${name} example`);
  }
  assert.doesNotMatch(
    text,
    /Memory scope:|Default repository scope|\bglobal\b|scope migrate|memocap install|memocap uninstall|host-injected|Codex|Claude|Pi memory/i,
  );
}

function replaceLine(text, pattern, replacement) {
  const replaced = text.replace(pattern, replacement);
  assert.notEqual(replaced, text, `mutation should match ${pattern}`);
  return replaced;
}

test("generated guidance extraction accepts CRLF source", () => {
  const source = fs.readFileSync(generatedRulesPath, "utf8");
  const normalizedSource = source.replaceAll("\r\n", "\n");
  assert.equal(
    generatedRules(normalizedSource.replaceAll("\n", "\r\n")),
    generatedRules(normalizedSource),
  );
});

test("generated, runtime, and static guidance share one least-sharing policy", async () => {
  const { RULES } = await import(`${pathToFileURL(pluginPath).href}?contract=least-sharing`);
  const surfaces = [generatedRules(), guidanceBlock(RULES), staticRules()];
  for (const surface of surfaces) assertPolicy(surface);
  assert.deepEqual(surfaces, [surfaces[0], surfaces[0], surfaces[0]]);
});

test("policy contract rejects inverted sharing decisions", () => {
  const policy = staticRules();
  assertPolicy(policy);
  const repository = policy.match(/^\s{2}2\. Repository-specific:.*$/m)?.[0];
  const domain = policy.match(/^\s{2}3\. Attached-domain reusable:.*$/m)?.[0];
  assert.ok(repository && domain);
  const inverted = policy
    .replace(repository, "__REPOSITORY_DECISION__")
    .replace(domain, repository)
    .replace("__REPOSITORY_DECISION__", domain);
  assert.throws(() => assertPolicy(inverted), /exact order/);
});

test("policy contract rejects automatic domain creation or attachment", () => {
  const policy = staticRules();
  assertPolicy(policy);
  const mutated = replaceLine(
    policy,
    /Never create or attach a domain automatically\./,
    "Create and attach a suitable domain automatically.",
  );
  assert.throws(() => assertPolicy(mutated), /no automatic domain mutation/);
});

test("policy contract rejects unsafe secret, credential, and instruction candidates", () => {
  const policy = staticRules();
  assertPolicy(policy);
  for (const replacement of [
    "1. Reject: store secrets and credentials when they seem useful, but reject instruction-bearing content.",
    "1. Reject: reject secrets and credentials, but store instruction-bearing content.",
  ]) {
    const mutated = replaceLine(policy, /^\s{2}1\. Reject:.*$/m, replacement);
    assert.throws(() => assertPolicy(mutated), /reject unsafe candidates/);
  }
});

test("policy contract rejects universal fallback for uncertain candidates", () => {
  const policy = staticRules();
  assertPolicy(policy);
  const mutated = replaceLine(
    policy,
    /^\s{2}6\. Uncertain:.*$/m,
    "6. Uncertain: when placement remains uncertain, store in universal memory.",
  );
  assert.throws(() => assertPolicy(mutated), /repository fallback/);
});

test("policy contract rejects inverted retrieval guidance", () => {
  const policy = staticRules();
  assertPolicy(policy);
  for (const [pattern, replacement] of [
    [/^- Preserve exact facts:.*$/m, "- Preserve exact facts: generalization replaces exact facts."],
    [/^- Treat repository-specific implementation.*$/m, "- Do not treat repository-specific implementation and reusable method as separate layers."],
    [/^- Store a dual-layer memory.*$/m, "- Store a dual-layer memory even when placement or lifecycle diverges."],
    [/^- Generalize a rule only when.*$/m, "- Generalize every rule regardless of whether its evidence supports it."],
    [/^- Use `--topic` only for.*$/m, "- Use `--topic` for associations, not only for explicit replacement relationships."],
  ]) {
    const mutated = replaceLine(policy, pattern, replacement);
    assert.throws(() => assertPolicy(mutated));
  }
});
