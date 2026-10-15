const fs = require('fs');
const vm = require('vm');
const path = require('path');
const workerPath = process.env.WORKER_SOURCE || path.join(__dirname, '..', 'worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const start = source.indexOf('function limitText(');
const end = source.indexOf('async function processDecision(', start);
if (start < 0 || end < 0) throw new Error('Could not locate worker decision-normalization code');
const segment = source.slice(start, end) + `\nglobalThis.testApi = { normalizeDecision, missingInformationIsStillMissing, decisionTextIsGrounded, ...(typeof currentPriceFactForItem === 'function' ? { currentPriceFactForItem } : {}) };`;
const context = vm.createContext({ console });
vm.runInContext(segment, context, { timeout: 5000 });
const api = context.testApi;
const tests = [];
function check(name, passed, detail) { tests.push({ name, passed: Boolean(passed), detail }); }
function fact(factId, attribute, value, evidence = value) { return { factId, itemId: factId.split('::')[0], attribute, value, unit: /INR/.test(value) ? 'INR' : '', evidence, confidence: 0.99, sourceUrl: `https://example.test/${factId.split('::')[0]}` }; }
function item(id, title, price = null, includeMrp = false) {
  const facts = [fact(`${id}::display`, 'Display Type', 'AMOLED', 'AMOLED display')];
  if (price !== null) facts.push(fact(`${id}::price`, 'Current listed price', `${price} INR`, `₹${Number(price).toLocaleString('en-IN')}`));
  if (includeMrp) facts.push(fact(`${id}::mrp`, 'List price', '39999 INR', 'MRP ₹39,999'));
  return { id, title, entityName: title, url: `https://example.test/${id}`, facts };
}
function normalize(items, missingInformation, supporting = {}) {
  const factIds = new Set(items.flatMap(i => i.facts.map(f => f.factId)));
  const raw = {
    status: 'no_clear_decision', title: 'Compare the selected phones', reason: 'The comparison uses facts from the selected pages.',
    recommendedItemId: '', criteria: ['Display quality'],
    candidates: items.map(i => ({ itemId: i.id, assessment: 'The page provides useful display information.', fit: 'reasonable', pros: ['AMOLED display'], cons: [], supportingFactIds: supporting[i.id] || i.facts.filter(f => f.attribute === 'Display Type').map(f => f.factId) })),
    tradeoffs: [], missingInformation, caveats: [], nextStep: ''
  };
  return api.normalizeDecision(raw, items, factIds);
}

// Reproduces the user's screenshot pattern: AI selected a specification but omitted each price fact ID.
{
  const items = [item('a56', 'Samsung Galaxy A56 5G', 31999), item('iqoo', 'iQOO Z11xa 5G', 28998), item('nord', 'OnePlus Nord CE6', 27999)];
  const result = normalize(items, ['Exact pricing for each device']);
  const allPriceIdsDisplayed = result.candidates.every((candidate, index) => {
    const expectedId = `${items[index].id}::price`;
    return candidate.supportingFactIds.includes(expectedId);
  });
  check('A valid current price is rendered even when the AI omits its fact ID', allPriceIdsDisplayed, result.candidates.map(c => ({ itemId:c.itemId, supportingFactIds:c.supportingFactIds })));
  check('“Exact pricing for each device” is removed when every selected item has a current price', !result.missingInformation.some(v => /pricing/i.test(v)), result.missingInformation);
}
// MRP/list price must not be treated as a current selected variant price.
{
  const items = [item('a56', 'Samsung Galaxy A56 5G', null, true)];
  const result = normalize(items, ['Current price is unknown for Samsung Galaxy A56 5G']);
  check('MRP alone does not satisfy a current-price unknown', result.missingInformation.length === 1, result.missingInformation);
  check('MRP alone is not auto-rendered as the selected current price', !result.candidates[0].supportingFactIds.includes('a56::mrp'), result.candidates[0].supportingFactIds);
}
// A statement about every device must remain when one current price is missing.
{
  const items = [item('a56', 'Samsung Galaxy A56 5G', 31999), item('iqoo', 'iQOO Z11xa 5G', 28998), item('nord', 'OnePlus Nord CE6', null)];
  const result = normalize(items, ['Exact pricing for each device']);
  check('Missing all-device pricing is retained when one selected item lacks a current price', result.missingInformation.some(v => /pricing/i.test(v)), result.missingInformation);
  check('Current prices for other items are still surfaced', result.candidates.filter(c => c.itemId !== 'nord').every(c => c.supportingFactIds.includes(`${c.itemId}::price`)), result.candidates.map(c => ({itemId:c.itemId, supportingFactIds:c.supportingFactIds})));
}
// A selected current price takes priority over a distinct MRP fact.
{
  const items = [item('a56', 'Samsung Galaxy A56 5G', 31999, true)];
  const result = normalize(items, []);
  check('Current price is surfaced while MRP remains excluded from the current-price chip', result.candidates[0].supportingFactIds.includes('a56::price') && !result.candidates[0].supportingFactIds.includes('a56::mrp'), result.candidates[0].supportingFactIds);
}
// A generic “Price” fact backed by an MRP quote is not sufficient to establish current price.
{
  const sourceItem = item('a56', 'Samsung Galaxy A56 5G', null);
  sourceItem.facts.push(fact('a56::genericPrice', 'Price', '39999 INR', 'MRP ₹39,999'));
  const result = normalize([sourceItem], ['Current price is unknown for Samsung Galaxy A56 5G']);
  check('Generic Price/MRP evidence does not clear a current-price unknown', result.missingInformation.length === 1, result.missingInformation);
  check('Generic Price/MRP evidence is not auto-rendered as the current price', !result.candidates[0].supportingFactIds.includes('a56::genericPrice'), result.candidates[0].supportingFactIds);
}
// Two conflicting current-price facts are ambiguous and should not be promoted arbitrarily.
{
  const sourceItem = item('a56', 'Samsung Galaxy A56 5G', null);
  sourceItem.facts.push(fact('a56::priceA', 'Current listed price', '31999 INR', '₹31,999'));
  sourceItem.facts.push(fact('a56::priceB', 'Current listed price', '32999 INR', '₹32,999'));
  const result = normalize([sourceItem], ['Current price is unknown for Samsung Galaxy A56 5G']);
  check('Conflicting current prices are not auto-rendered as a single verified price', !result.candidates[0].supportingFactIds.some(id => id === 'a56::priceA' || id === 'a56::priceB'), result.candidates[0].supportingFactIds);
  check('Unknown remains when current price evidence is ambiguous', result.missingInformation.length === 1, result.missingInformation);
}
// Free-text unknown claims must use the same per-item rule as the visible missing-information list.
{
  const allPriced = [item('a56', 'Samsung Galaxy A56 5G', 31999), item('iqoo', 'iQOO Z11xa 5G', 28998), item('nord', 'OnePlus Nord CE6', 27999)];
  const oneMissing = [item('a56', 'Samsung Galaxy A56 5G', 31999), item('iqoo', 'iQOO Z11xa 5G', 28998), item('nord', 'OnePlus Nord CE6', null)];
  const statement = 'Exact pricing for each device is still unknown';
  check('Global pricing-unknown statement is rejected when every item has a current price', api.decisionTextIsGrounded(statement, allPriced) === false, api.decisionTextIsGrounded(statement, allPriced));
  check('Global pricing-unknown statement remains grounded when any item lacks current price', api.decisionTextIsGrounded(statement, oneMissing) === true, api.decisionTextIsGrounded(statement, oneMissing));
}
// Price insertion must keep the UI's existing ten-chip maximum.
{
  const manyFacts = Array.from({length:12},(_,n)=>fact(`a56::f${n+1}`,`Spec ${n+1}`,`Value ${n+1}`,`Evidence ${n+1}`));
  manyFacts[0] = fact('a56::price','Current listed price','31999 INR','₹31,999');
  const items = [{id:'a56',title:'Samsung Galaxy A56 5G',entityName:'Samsung Galaxy A56 5G',url:'https://example.test/a56',facts:manyFacts}];
  const factIds = new Set(manyFacts.map(f=>f.factId));
  const raw = {status:'no_clear_decision',title:'Compare',reason:'Using evidence.',recommendedItemId:'',criteria:[],candidates:[{itemId:'a56',assessment:'Evidence is available.',fit:'reasonable',pros:[],cons:[],supportingFactIds:manyFacts.slice(1,12).map(f=>f.factId)}],tradeoffs:[],missingInformation:[],caveats:[],nextStep:''};
  const result = api.normalizeDecision(raw,items,factIds);
  check('Price auto-inclusion preserves the existing ten-fact display limit', result.candidates[0].supportingFactIds.length <= 10 && result.candidates[0].supportingFactIds.includes('a56::price'), result.candidates[0].supportingFactIds);
}
const failed = tests.filter(t => !t.passed);
const result = { source: workerPath, summary: { total: tests.length, passed: tests.length-failed.length, failed: failed.length }, tests };
console.log(JSON.stringify(result,null,2));
if (failed.length) process.exitCode = 1;
