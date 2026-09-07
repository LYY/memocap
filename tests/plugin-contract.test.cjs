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

function generatedRules() {
  const source = fs.readFileSync(generatedRulesPath, "utf8");
  const start = source.indexOf('r#"{AGENTS_BEGIN}');
  const end = source.indexOf('{AGENTS_END}\n"#', start);
  assert.notEqual(start, -1, "generated rules template should exist");
  assert.notEqual(end, -1, "generated rules template should end");
  return source.slice(start, end);
}

const scopeGuidanceMatrix = [
  {
    name: "repository is default scope",
    accepts: [
      "Default repository scope: store decisions, tasks, agreements, and working context in the current repository by default.",
      "Keep decisions, tasks, agreements, and working context in their active project unless the user explicitly selects global scope.",
      "Repository decisions, tasks, agreements, and working context default to their project scope; `--global` remains an explicit opt-in.",
    ],
    rejects: [
      "Default global scope: store decisions, tasks, agreements, and working context in global memory by default.",
      "Global is default for repository decisions, tasks, agreements, and working context.",
    ],
    positive: [
      /(?:default|unless).*(?:repository|project).*(?:decision|task|agreement|context)/i,
      /(?:decision|task|agreement|context).*(?:repository|project).*(?:default|unless)/i,
      /(?:repository|project).*(?:decision|task|agreement|context).*default(?:s)?.*(?:repository|project)/i,
    ],
    negative: [
      /(?:default|by default).*(?:global|global memory).*(?:decision|task|agreement|context)/i,
    ],
    forbiddenDirections: [
      {
        terms: [/\bglobal(?:\s+(?:scope|memory))?\b/i, /\bdefault\b/i],
        relations: [
          /\bglobal(?:\s+(?:scope|memory))?\s+(?:is\s+)?(?:the\s+)?default\b/i,
          /\bdefault\s+global(?:\s+(?:scope|memory))?\b/i,
          /\b(?:decision|task|agreement|context)[^.]*\bdefault(?:s)?\s+(?:to|in)\s+global(?:\s+(?:scope|memory))?\b/i,
        ],
      },
    ],
  },
  {
    name: "global scope is cross-repository only",
    accepts: [
      "Use `--global` only for stable cross-repository user preferences and conventions.",
      "Reserve global scope for conventions shared across projects.",
      "Stable cross-repository preferences and conventions may use `--global`.",
    ],
    rejects: [
      "Use `--global` only for stable preferences and conventions bound to one repository.",
      "Do not use `--global` for stable cross-repository preferences and conventions.",
      "Stable cross-repository preferences and conventions must not use `--global`.",
    ],
    positive: [
      /(?:--global|global scope).*(?:cross-repository|across projects|shared).*(?:preference|convention)/i,
      /(?:--global|global scope).*(?:preference|convention).*(?:cross-repository|across projects|shared)/i,
      /(?:cross-repository|across projects|shared).*(?:preference|convention).*(?:--global|global scope)/i,
    ],
    negative: [/(?:bound to|one|single|per).*(?:repository|project)/i],
    forbiddenTermSets: [
      [/(?:--global|global scope)/i, /\b(?:do not|don't|never|must not|should not|not)\b/i],
    ],
  },
  {
    name: "both scopes are recalled before response",
    accepts: [
      "Recall current repository and global memories every turn before answering.",
      "Before any answer, load both active project and global memory.",
    ],
    rejects: [
      "Recall only current repository memories every turn; never recall global memories.",
    ],
    positive: [
      /(?:recall|load).*(?:current repository|active project).*(?:global).*(?:every turn|each turn|before (?:answering|responding))/i,
      /(?:before (?:any )?(?:answer|response)|every turn|each turn).*(?:recall|load).*(?:both|current repository|active project).*(?:global)/i,
    ],
    negative: [
      /\bonly\b.*(?:current repository|active project)/i,
      /(?:never|not).*(?:global)/i,
    ],
  },
  {
    name: "topic requires explicit replacement",
    accepts: [
      "Use `--topic` only for an explicit replacement relationship.",
      "Assign `--topic` only when the current note expressly supersedes prior memory.",
    ],
    rejects: [
      "Use `--topic` explicitly for every memory, even when no replacement relationship exists.",
    ],
    positive: [
      /--topic.*(?:only|when).*(?:explicit|expressly).*(?:replacement|supersedes)/i,
      /(?:explicit|expressly).*(?:replacement|supersedes).*--topic/i,
    ],
    negative: [/--topic.*(?:every|all).*(?:no|without).*(?:replacement|supersed)/i],
  },
  {
    name: "migration is explicit and local",
    accepts: [
      "Use local `memocap scope migrate` explicitly for legacy memories or moved repository identity; never auto-classify or auto-migrate.",
      "Run migration locally only when a human explicitly moves legacy entries after repository relocation.",
    ],
    rejects: [
      "Automatically run local `memocap scope migrate` for legacy memories or moved repository identity.",
    ],
    positive: [
      /local(?:ly)?.*(?:scope migrate|migration).*(?:explicit|human).*(?:legacy|moved|relocation)/i,
      /(?:scope migrate|migration).*local(?:ly)?.*(?:explicit|human).*(?:legacy|moved|relocation)/i,
    ],
    negative: [/(?:automatically|auto-migrate).*(?:scope migrate|migration|classify)/i],
  },
];

function includesAll(statement, patterns) {
  return patterns.every((pattern) => pattern.test(statement));
}

function followsScopeRule(statement, rule) {
  return rule.positive.some((pattern) => pattern.test(statement)) &&
    !rule.negative.some((pattern) => pattern.test(statement)) &&
    !(rule.forbiddenTermSets ?? []).some((terms) => includesAll(statement, terms)) &&
    !(rule.forbiddenDirections ?? []).some(
      ({ terms, relations }) =>
        includesAll(statement, terms) && relations.some((pattern) => pattern.test(statement)),
    );
}

function guidanceStatements(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s+/, ""))
    .filter(Boolean);
}

test("memory scope guidance accepts equivalents and rejects inverted rules", () => {
  for (const rule of scopeGuidanceMatrix) {
    for (const statement of rule.accepts) {
      assert.ok(followsScopeRule(statement, rule), `${rule.name} accepts: ${statement}`);
    }
    for (const statement of rule.rejects) {
      assert.ok(!followsScopeRule(statement, rule), `${rule.name} rejects: ${statement}`);
    }
  }
});

test("generated, runtime, and static guidance preserve every memory scope rule", async () => {
  const { RULES } = await import(`${pathToFileURL(pluginPath).href}?contract=scope-guidance`);

  for (const [name, text] of [
    ["generated", generatedRules()],
    ["runtime", RULES],
    ["static", fs.readFileSync(staticSkillPath, "utf8")],
  ]) {
    const statements = guidanceStatements(text);
    for (const rule of scopeGuidanceMatrix) {
      assert.ok(
        statements.some((statement) => followsScopeRule(statement, rule)),
        `${name} guidance includes ${rule.name}`,
      );
    }
  }
});
