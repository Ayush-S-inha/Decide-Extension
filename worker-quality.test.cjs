const fs = require('fs');
const vm = require('vm');
const path = require('path');
const workerPath = process.env.WORKER_SOURCE || path.join(__dirname, '..', 'worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const start = source.indexOf('function limitText(');
const end = source.indexOf('async function processDecision(', start);
if (start < 0 || end < 0) throw new Error('Could not locate worker helper functions');
const code = source.slice(start, end) + '\nglobalThis.testApi = { mergeExtractedFacts, normalizeDecision, factDedupAttribute, fallbackCandidateAssessment, isReviewLikeSpecificationValue };';
const context = vm.createContext({ console, Intl, Set, Map });
vm.runInContext(code, context, { timeout: 5000 });
const api = context.testApi;
const tests = [];
const add = (name, passed, detail) => tests.push({ name, passed: Boolean(passed), detail });
function pageWithSignals(signals) {
  const productSections = ['Samsung Galaxy A56 5G (8GB RAM, 128GB Storage)', ...signals.map(s => s.evidence)].join('\n');
  return { id: 'phone', title: 'Samsung Galaxy A56 5G (8GB RAM, 128GB Storage)', url: 'https://www.amazon.in/dp/example', productSections, visibleText: productSections, primarySections: '', goalRelevantText: '', headings: [], structuredData: [], factSignals: signals };
}
function sig(attribute, value) { return { attribute, value, source: 'dom', evidence: `${attribute}: ${value}` }; }
function fact(id, attribute, value, evidence = value) { return { factId: id, itemId: 'phone', attribute, value, unit: '', evidence, confidence: 0.9, sourceUrl: 'https://example.test/phone' }; }

// 1. Known synonymous RAM labels with the same value are deduplicated.
{
  const page = pageWithSignals([sig('RAM Memory Installed Size', '8 GB'), sig('RAM Memory Installed', '8 GB')]);
  const facts = api.mergeExtractedFacts(page, [], 'Compare phones for college');
  const ramFacts = facts.filter(f => api.factDedupAttribute(f.attribute) === 'ram capacity');
  add('Equivalent RAM labels with same value collapse to one fact', ramFacts.length === 1 && ramFacts[0].value === '8 GB', ramFacts.map(f => ({ attribute: f.attribute, value: f.value })));
}
// 2. Same canonical attribute with a conflicting value must remain visible.
{
  const page = pageWithSignals([sig('RAM Memory Installed Size', '8 GB'), sig('RAM Memory Installed', '12 GB')]);
  const facts = api.mergeExtractedFacts(page, [], 'Compare phones for college');
  const ramFacts = facts.filter(f => api.factDedupAttribute(f.attribute) === 'ram capacity');
  add('Conflicting RAM values are preserved rather than silently deduplicated', ramFacts.length === 2 && new Set(ramFacts.map(f => f.value)).size === 2, ramFacts.map(f => ({ attribute: f.attribute, value: f.value })));
}
// 3. Unrelated specs are not canonicalized into RAM or removed.
{
  const page = pageWithSignals([sig('Display Resolution', '2340 x 1080'), sig('Refresh Rate', '120 Hz'), sig('Memory Storage Capacity', '128 GB')]);
  const facts = api.mergeExtractedFacts(page, [], 'Compare phones for college');
  add('Display and storage facts remain intact after duplicate cleanup', ['Display Resolution', 'Refresh Rate', 'Memory Storage Capacity'].every(a => facts.some(f => f.attribute === a)), facts.map(f => ({ attribute: f.attribute, value: f.value })));
}
// 4. A rejected ungrounded assessment becomes a fact-specific, conservative summary.
{
  const item = { id: 'phone', title: 'Samsung Galaxy A56 5G', facts: [fact('phone::p', 'Current listed price', '31999 INR', '₹31,999'), fact('phone::ram', 'RAM Memory Installed Size', '8 GB'), fact('phone::display', 'Display Type', 'AMOLED')] };
  const assessment = api.fallbackCandidateAssessment(item);
  add('Fallback assessment names grounded facts and avoids generic repeated boilerplate', /Current listed price/.test(assessment) && /Display Type/.test(assessment) && !/does not establish every relevant detail/i.test(assessment), assessment);
}
// 5. CPU/GPU labels are recognized by the fallback assessment selector.
{
  const item = { id: 'phone', title: 'Test phone', facts: [fact('phone::gpu', 'GPU', 'Adreno 750'), fact('phone::cpu', 'CPU', 'Snapdragon') ] };
  const assessment = api.fallbackCandidateAssessment(item);
  add('CPU/GPU fallback label matching uses valid word boundaries', /CPU|GPU/i.test(assessment) && !/[\x08]/.test(assessment), assessment);
}

// 6. Empty evidence remains explicitly insufficient; no facts are fabricated.
{
  const assessment = api.fallbackCandidateAssessment({ id: 'empty', title: 'Unknown item', facts: [] });
  add('Fallback assessment with no facts states evidence is insufficient', /does not provide enough grounded detail/i.test(assessment), assessment);
}
// 7. The exact boilerplate phrase from the user's result is replaced even if it passes broad grounding checks.
{
  const item = { id: 'phone', title: 'Samsung Galaxy A56 5G', entityName: 'Samsung Galaxy A56 5G', url: 'https://example.test/phone', facts: [fact('phone::price', 'Current listed price', '31999 INR', '₹31,999'), fact('phone::display', 'Display Type', 'AMOLED')] };
  const allIds = new Set(item.facts.map(f => f.factId));
  const raw = { status: 'no_clear_decision', title: 'Compare', reason: 'This comparison uses selected-page facts.', recommendedItemId: '', criteria: [], candidates: [{ itemId: 'phone', assessment: 'The available evidence does not establish every relevant detail.', fit: 'uncertain', pros: [], cons: [], supportingFactIds: ['phone::price'] }], tradeoffs: [], missingInformation: [], caveats: [], nextStep: '' };
  const result = api.normalizeDecision(raw, [item], allIds);
  add('Repeated generic evidence boilerplate is replaced with a fact-specific fallback', !/available evidence does not establish every relevant detail/i.test(result.candidates[0].assessment) && result.candidates[0].assessment.includes('Current listed price'), result.candidates[0].assessment);
}
// 8. normalizeDecision only uses fallback when the model's candidate assessment is not grounded.
{
  const item = { id: 'phone', title: 'Samsung Galaxy A56 5G', entityName: 'Samsung Galaxy A56 5G', url: 'https://example.test/phone', facts: [fact('phone::price', 'Current listed price', '31999 INR', '₹31,999'), fact('phone::display', 'Display Type', 'AMOLED')] };
  const allIds = new Set(item.facts.map(f => f.factId));
  const raw = { status: 'no_clear_decision', title: 'Compare selected phones', reason: 'The comparison uses evidence from the selected page.', recommendedItemId: '', criteria: [], candidates: [{ itemId: 'phone', assessment: 'This has a score of 9999 and is definitely best.', fit: 'reasonable', pros: [], cons: [], supportingFactIds: ['phone::price'] }], tradeoffs: [], missingInformation: [], caveats: [], nextStep: '' };
  const result = api.normalizeDecision(raw, [item], allIds);
  add('Normalization replaces ungrounded assessment with safe fact-specific fallback', result.candidates[0].assessment.includes('Current listed price') && result.candidates[0].assessment.includes('Display Type'), result.candidates[0].assessment);
  add('Current price survives fact cleanup and assessment fallback', result.candidates[0].supportingFactIds.includes('phone::price'), result.candidates[0].supportingFactIds);
}
// 9. The overall recommendation must not claim independent verification of selected-page facts.
{
  const item = { id: 'phone', title: 'Samsung Galaxy A56 5G', entityName: 'Samsung Galaxy A56 5G', url: 'https://example.test/phone', facts: [fact('phone::price', 'Current listed price', '31999 INR', '₹31,999'), fact('phone::display', 'Display Type', 'AMOLED')] };
  const allIds = new Set(item.facts.map(f => f.factId));
  const raw = { status: 'no_clear_decision', title: 'Compare phones', reason: 'The recommendation is based on the verified facts from the selected pages.', recommendedItemId: '', criteria: [], candidates: [{ itemId: 'phone', assessment: 'The captured listing provides evidence for Current listed price and Display Type. These are page claims, not independent real-world performance tests.', fit: 'reasonable', pros: [], cons: [], supportingFactIds: ['phone::price', 'phone::display'] }], tradeoffs: [], missingInformation: [], caveats: [], nextStep: '' };
  const result = api.normalizeDecision(raw, [item], allIds);
  add('Overall reason does not claim selected-page facts are verified', !/verified facts?/i.test(result.reason) && /captured from the selected pages/i.test(result.reason), result.reason);
}

// 10. Review prose accidentally attached to a specification label must not become a fact.
{
  const review = 'sob ta vishon bhalo ... Tobe back camera te amar ektu kom mone hoyeche ....';
  add('Review-like colloquial text is recognized as invalid for a technical specification', api.isReviewLikeSpecificationValue('Display', review), review);
}
// 11. The guard is scoped to technical specification fields, not arbitrary prose.
{
  const review = 'sob ta vishon bhalo ... Tobe back camera te amar ektu kom mone hoyeche ....';
  add('The review-text guard does not rewrite a field labelled Review Summary', !api.isReviewLikeSpecificationValue('Review Summary', review), review);
}
// 12. Valid concise display values are preserved.
{
  const validValues = [
    ['Display Type', 'AMOLED'],
    ['Display Resolution', '2772 x 1272 pixels'],
    ['Refresh Rate', '144 Hz'],
    ['Display', '6.78-inch 3D curved AMOLED display with 144 Hz refresh rate']
  ];
  add('Valid technical display values are not mistaken for review prose', validValues.every(([attribute, value]) => !api.isReviewLikeSpecificationValue(attribute, value)), validValues);
}
// 13. The bad signal must be removed before deterministic fact recovery.
{
  const review = 'sob ta vishon bhalo ... Tobe back camera te amar ektu kom mone hoyeche ....';
  const page = pageWithSignals([sig('Display', review), sig('Display Type', 'AMOLED'), sig('Refresh Rate', '144 Hz')]);
  const facts = api.mergeExtractedFacts(page, [], 'Compare phones for college');
  add('Structured DOM recovery drops the contaminated display fact but retains valid values', !facts.some(f => f.attribute === 'Display' && f.value === review) && facts.some(f => f.attribute === 'Display Type' && f.value === 'AMOLED') && facts.some(f => f.attribute === 'Refresh Rate' && f.value === '144 Hz'), facts.map(f => ({ attribute: f.attribute, value: f.value })));
}
// 14. The model cannot reintroduce the same bad display value from broad page text.
{
  const review = 'sob ta vishon bhalo ... Tobe back camera te amar ektu kom mone hoyeche ....';
  const page = pageWithSignals([sig('Display', review)]);
  const facts = api.mergeExtractedFacts(page, [{ attribute: 'Display', value: review, unit: '', evidence: `Display: ${review}`, confidence: 0.9 }], 'Compare phones for college');
  add('Model-extracted review text is also rejected as a display specification', !facts.some(f => /^display$/i.test(f.attribute) && f.value === review), facts.map(f => ({ attribute: f.attribute, value: f.value })));
}
// 15. Overlong review excerpts are rejected from technical specification fields even without ellipses.
{
  const value = 'The screen looks amazing and I personally enjoyed using it every day because the colors feel very vibrant and the viewing experience is great for watching videos';
  add('Long subjective descriptions do not pass as compact technical specs', api.isReviewLikeSpecificationValue('Display Type', value), value);
}

const failed = tests.filter(t => !t.passed);
console.log(JSON.stringify({ total: tests.length, passed: tests.length - failed.length, failed: failed.length, tests }, null, 2));
if (failed.length) process.exitCode = 1;
