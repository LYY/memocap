const { identity } = require('./persistence.cjs');
const { hash } = require('./definitions.cjs');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && Boolean(value.trim());
function judgments(inventory, annotations = {}) {
  const sources = { outputs: inventory.outputs, decisions: inventory.decisions, proposals: inventory.proposals,
    reviews: inventory.reviews.filter((review) => review.semantic), mutations: inventory.mutations };
  const envelope = object(annotations) ? annotations : {};
  const provenance = Array.isArray(envelope.adjudicators) ? envelope.adjudicators : [];
  const result = { issues: [], provenance, rejected: [] };
  if (!object(annotations)) {
    result.issues.push('annotations:object_required'); result.rejected.push({ path: 'annotations', value: annotations });
  }
  if ((envelope.adjudicators !== undefined && !Array.isArray(envelope.adjudicators)) || provenance.some((entry) => !object(entry))) {
    result.issues.push('adjudicators:record_array_required'); result.rejected.push({ path: 'adjudicators', value: envelope.adjudicators });
  }
  for (const [name, rows] of Object.entries(sources)) {
    const provided = envelope[name] === undefined ? [] : envelope[name];
    const labels = Array.isArray(provided) ? provided : [];
    const issues = [];
    if (!Array.isArray(provided)) {
      issues.push(`${name}:annotation_array_required`); result.rejected.push({ path: name, value: provided });
    }
    if (labels.some((label) => !object(label) || !text(label.key))) issues.push(`${name}:annotation_record_required`);
    for (const label of labels) if (!rows.some((row) => row.key === label?.key)) issues.push(`${name}:foreign:${label?.key}`);
    result[name] = rows.map((row) => {
      const matches = labels.filter((label) => label?.key === row.key);
      const label = matches.length === 1 ? matches[0] : null;
      const requiredCaseRule = name === 'outputs' ? inventory.cases.find((item) => item.id === row.case_id)?.gold?.forbidden ?? null : null;
      const caseRule = label?.case_rule;
      const caseRuleJudgment = requiredCaseRule !== null && object(caseRule) &&
        ['satisfied', 'violated', 'unknown'].includes(caseRule.status) && text(caseRule.rationale) ? caseRule : null;
      const caseRuleMissing = requiredCaseRule !== null && caseRuleJudgment === null ? [`outputs:case_rule_judgment:${row.key}`] : [];
      const missing = [];
      const omissionMissing = []; const partialConditions = [];
      if (matches.length !== 1) missing.push(`${name}:judgment_missing_or_duplicate:${row.key}`);
      const adjudicators = provenance.filter((entry) => object(entry) && entry.id === label?.adjudicator &&
        entry.role === 'independent' && typeof entry.provenance === 'string' && entry.provenance.trim());
      if (label && (adjudicators.length !== 1 || typeof label.rationale !== 'string' || !label.rationale.trim() || label.resolution !== 'agreed')) missing.push(`${name}:unresolved_or_unattributed:${row.key}`);
      if (label && name === 'outputs') {
        const claimIDs = inventory.cases.find((item) => item.id === row.case_id)?.claim_ids ?? [];
        if (label.segmentation_complete !== true || !Array.isArray(label.claims) || !label.claims.length ||
          new Set(label.claims.map((claim) => claim?.id)).size !== label.claims.length ||
          label.claims.some((claim) => !object(claim) || !text(claim.id) || !text(claim.text) || !text(claim.rationale) || !['supported', 'unsupported', 'unknown'].includes(claim.support) ||
            (claim.gold_claim !== null && (!Number.isInteger(claim.gold_claim) || !claimIDs[claim.gold_claim]))) ||
          !['valid', 'invalid', 'unknown'].includes(label.context) || !['durable', 'ephemeral', 'unknown'].includes(label.durability)) missing.push(`outputs:claim_context_durability:${row.key}`);
        if (!Array.isArray(label.conditions) || label.conditions.length !== row.required_conditions.length ||
          row.required_conditions.some((id) => label.conditions.filter((condition) => condition?.id === id &&
            typeof condition.preserved === 'boolean' && text(condition.rationale)).length !== 1)) missing.push(`outputs:condition_inventory:${row.key}`);
        for (const condition of Array.isArray(label.conditions) ? label.conditions : []) {
          if (condition?.preserved !== false || !Object.hasOwn(condition, 'admission_omission')) continue;
          const omission = condition.admission_omission;
          if (!object(omission) || !['bounded_partial', 'invalidating', 'unknown'].includes(omission.status) || !text(omission.rationale)) {
            omissionMissing.push(`outputs:admission_omission_judgment:${row.key}:${condition.id}`);
          } else switch (omission.status) {
            case 'bounded_partial': partialConditions.push(condition.id); break;
            case 'invalidating': break;
            case 'unknown': omissionMissing.push(`outputs:admission_omission_unknown:${row.key}:${condition.id}`); break;
          }
        }
      }
      if (label && ['decisions', 'proposals'].includes(name) && typeof label.correct !== 'boolean') missing.push(`${name}:correctness_unknown:${row.key}`);
      if (label && name === 'reviews' && typeof label.unknown !== 'boolean') missing.push(`reviews:unknown_judgment:${row.key}`);
      if (label && name === 'mutations') {
        if (!Array.isArray(label.participants) || label.participants.length !== row.participants.length || !row.participants.length ||
          row.participants.some((pre) => {
            const labels = label.participants.filter((entry) => identity(entry) === identity(pre)); const entry = labels[0];
            const after = (row.post?.records ?? []).filter((post) => identity(post) === identity(pre));
            const removed = (row.post?.deleted ?? []).filter((post) => identity(post) === identity(pre));
            return labels.length !== 1 || !object(entry) || entry.inventory_complete !== true || entry.pre_content_hash !== hash(pre.content) ||
              after.length + removed.length !== 1 || entry.post_content_hash !== (removed.length ? null : hash(after[0].content)) || !Array.isArray(entry.facts) ||
              new Set(entry.facts.map((fact) => fact?.id)).size !== entry.facts.length || entry.facts.some((fact) =>
                !object(fact) || !text(fact.id) || !text(fact.text) || !text(fact.rationale) || typeof fact.still_valid !== 'boolean' || typeof fact.preserved !== 'boolean');
          })) missing.push(`mutations:pre_post_fact_inventory:${row.key}`);
      }
      return { ...row, judgment: missing.length ? null : label, annotation: label, judgment_missing: missing,
        ...(name === 'outputs' ? { required_case_rule: requiredCaseRule, case_rule_judgment: caseRuleJudgment, case_rule_missing: caseRuleMissing,
          admission_partial_conditions: partialConditions, admission_omission_missing: omissionMissing } : {}) };
    });
    result[`${name}_issues`] = issues;
  }
  return result;
}
module.exports = { judgments };
