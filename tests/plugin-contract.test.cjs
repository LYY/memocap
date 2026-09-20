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

function generatedRules(source = fs.readFileSync(generatedRulesPath, "utf8")) {
  const start = source.indexOf('r#"{AGENTS_BEGIN}');
  const end = source.indexOf("{AGENTS_END}", start);
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
      "Use `--global` only for stable, repository-agnostic knowledge useful in unrelated repositories, such as Go debugging methods.",
      "Reserve global scope for stable knowledge shared across projects.",
      "Stable repository-agnostic knowledge useful in unrelated repositories may use `--global`.",
    ],
    rejects: [
      "Use `--global` for repository-specific knowledge bound to one repository.",
      "Use global scope for stable knowledge useful in only one repository.",
    ],
    positive: [
      /(?:--global|global scope).*(?:unrelated repositories|across projects|shared)/i,
      /(?:unrelated repositories|across projects|shared).*(?:--global|global scope)/i,
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
  {
    name: "scope is classified by usefulness before remembering",
    accepts: ["Before `remember`, classify each memory's scope by usefulness, not simply its source."],
    rejects: ["Before `remember`, classify each memory's scope solely by its source."],
    positive: [/(?:before|prior to).*(?:remember|stor).*(?:classif).*(?:scope)/i],
    required: [
      /(?:usefulness|utility|useful).*(?:not|rather than|instead of).*(?:source|origin|learned)/i,
    ],
    negative: [],
  },
  {
    name: "repository-specific facts retain dependency context",
    accepts: ["Keep repository-specific decisions, working context, and consumer-specific dependency usage in the current repository; name the dependency or path in stored content."],
    rejects: ["Store repository-specific decisions and consumer-specific dependency usage globally without naming the dependency or path."],
    positive: [/repository(?:-| )specific.*(?:decision|working context|context).*(?:current repository|repository scope|keep|stay)/i],
    required: [
      /consumer(?:-| )specific.*dependenc(?:y|ies).*usage/i,
      /(?:name|include).*(?:dependenc(?:y|ies)|path).*(?:stored|content)|(?:dependenc(?:y|ies)|path).*(?:name|include).*(?:stored|content)/i,
    ],
    negative: [],
  },
  {
    name: "global scope is limited to stable repository-agnostic knowledge",
    accepts: ["Use `--global` only for stable, repository-agnostic knowledge useful in unrelated repositories, such as Go debugging methods."],
    rejects: ["Use `--global` for repository-specific knowledge that is not useful in unrelated repositories."],
    positive: [/(?:--global|global scope).*(?:only|reserve).*(?:stable).*(?:repository-agnostic|repository independent|not repository-specific)/i],
    required: [
      /(?:useful|beneficial).*(?:unrelated|different).*(?:repositories|projects)|(?:unrelated|different).*(?:repositories|projects).*(?:useful|beneficial)/i,
      /\bgo\b.*(?:debug|troubleshoot)/i,
    ],
    negative: [],
  },
  {
    name: "source repository alone does not make a fact global",
    accepts: ["A fact is not global merely because it was learned from another repository."],
    rejects: ["A fact is global merely because it was learned from another repository."],
    positive: [/(?:fact|knowledge).*(?:not|never).*(?:global).*(?:merely|solely|just).*(?:learned|source|origin).*(?:another|other).*(?:repository|project)/i],
    negative: [],
  },
  {
    name: "remember example makes global scope optional",
    accepts: ["Remember: `memocap remember --type <type> [--global] \"content\"`"],
    rejects: ["Remember: `memocap remember --type <type> --global \"content\"`"],
    positive: [/\bremember\b.*\[--global\]/i],
    negative: [],
  },
];

function includesAll(statement, patterns) {
  return patterns.every((pattern) => pattern.test(statement));
}

function followsScopeRule(statement, rule) {
  return rule.positive.some((pattern) => pattern.test(statement)) &&
    (rule.required ?? []).every((pattern) => pattern.test(statement)) &&
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

test("generated rules extraction accepts CRLF source", (context) => {
  const source = fs.readFileSync(generatedRulesPath, "utf8");
  const crlfSource = source.replace(/\r?\n/g, "\r\n");
  context.mock.method(
    fs,
    "readFileSync",
    () => 'r#"{AGENTS_BEGIN}\r\n{AGENTS_END}\r\n"#',
  );

  const crlfRules = generatedRules(crlfSource);
  const lfRules = generatedRules(source);

  assert.deepEqual(
    {
      crlfStatements: guidanceStatements(crlfRules).length,
      lfStatements: guidanceStatements(lfRules).length,
      usesCRLF: crlfRules.includes("\r\n"),
    },
    { crlfStatements: 18, lfStatements: 18, usesCRLF: true },
  );
});

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

test("generated, runtime, and static guidance omit the obsolete global restriction that excludes generic methods such as Go debugging", async () => {
  const obsoleteRestriction = "Use `--global` only for stable cross-repository user preferences and conventions.";
  const { RULES } = await import(`${pathToFileURL(pluginPath).href}?contract=obsolete-global-restriction`);

  for (const [name, text] of [
    ["generated", generatedRules()],
    ["runtime", RULES],
    ["static", fs.readFileSync(staticSkillPath, "utf8")],
  ]) {
    assert.ok(!text.includes(obsoleteRestriction), `${name} guidance omits obsolete global restriction`);
  }
});
