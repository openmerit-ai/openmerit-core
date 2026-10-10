import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { demoSnapshot, PRICE_DATE } from '../src/enterprise-sample.mjs';
import { PREFERENCES, preferenceFor } from '../src/demo-policy.mjs';
import * as history from '../src/history.mjs';
import * as brands from '../client/brands.mjs';
import * as routes from '../client/routes.mjs';
import * as counts from '../client/request-count.mjs';
import * as environment from '../client/environment.mjs';
import { routeIcon } from '../client/route-icons.mjs';

// Execute the actual view functions. Stub browser mounts, not the selection logic.
test('every demo preference renders its real plan, costs, decisions and evidence', async () => {
  const source = (await readFile(new URL('../client/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('void start();', '');
  const selectSource = (await readFile(new URL('../client/select.js', import.meta.url), 'utf8')).replace(/export /g, '');
  const context = vm.createContext({ ...history, ...brands, ...routes, ...counts, ...environment, routeIcon, PREFERENCES, preferenceFor, PRICE_DATE, URLSearchParams,
    location: { hash:'#models', search:'?stage=after' },
    document: { querySelectorAll:()=>[], documentElement:{hasAttribute:()=>true}, addEventListener(){} }, window:{addEventListener(){}},
    morphText: (_key, value) => value,
  });
  // The shared selector is scoped separately to retain its own escape helper.
  vm.runInContext(`globalThis.selectControl = (() => { ${selectSource}; return selectControl; })();`, context);
  vm.runInContext(source, context);
  for (const {value} of PREFERENCES) {
    context.snapshot = demoSnapshot(Date.parse('2026-10-10T12:00:00Z'), 'after', value);
    context.preference = value;
    const markup = vm.runInContext('state.data = snapshot; demoPreference = preference; comparisonPanel();', context);
    assert.match(markup, /Workload decisions/);
    if (value === 'default') assert.match(markup, /26 model\/service offers/);
    if (value === 'closed') assert.match(markup, /26 offers reviewed/);
    if (value === 'closed') {
      assert.match(markup, /Plan incomplete/);
      assert.match(markup, /11 of 14 workloads have a qualifying assignment/);
      assert.match(markup, /7.5M of 9.6M baseline requests/);
      assert.doesNotMatch(markup, /% lower/);
      const main = vm.runInContext('main()', context);
      assert.match(main, /id="model-results"/);
      assert.match(main, /GPT-4.1/);
      assert.match(main, /Needs a qualifying replacement/);
      const inventory = main.slice(main.indexOf('id="model-results"'));
      assert.doesNotMatch(inventory, /gpt-oss|GLM-5.3|Mistral Medium/);
      assert.doesNotMatch(main, /No qualifying After plan|Blocks the After plan|% lower/);
      const cards = vm.runInContext('summary()', context);
      assert.match(cards, /Qualified-workload cost/);
      assert.match(cards, /Partial cost · excludes unresolved workloads/);
      for (const hours of [1,168,720]) {
        context.hours = hours;
        const ranged = vm.runInContext('state.hours=hours; comparisonPanel()', context);
        assert.match(ranged, /Plan incomplete/);
        assert.doesNotMatch(ranged, /% lower|NaN|undefined/);
      }
      vm.runInContext('state.hours=0;',context);
    } else {
      assert.match(markup, /8 model changes · 5 service changes · 5 retained/);
      const amount = context.snapshot.simulation.windows[0].afterCost.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
      assert.ok(markup.includes(amount));
      if (value !== 'default') assert.match(markup, /2 choices differ from Default/);
      if (['open','zdr','china'].includes(value)) assert.match(markup, /Same model mix and cost as/);
      else assert.doesNotMatch(markup, /Same model mix and cost as/);
      assert.match(markup, /Actuarial query generation/);
      assert.match(markup, /Token cost ·/);
      const rows = markup.slice(markup.indexOf('<tbody>'));
      assert.ok(rows.indexOf(value === 'usa' ? 'Claim reconciliation scripts' : 'Actuarial query generation') < rows.indexOf('Claim intake'));
      assert.match(markup, /model \+ service change/);
    }
    vm.runInContext('openInspector = (title, subtitle, body) => { globalThis.drawer = body; }; showPrices();', context);
    assert.match(context.drawer, /Review 26 candidates/);
    assert.match(context.drawer, /Published benchmark comparison/);
    assert.match(context.drawer, /Application code · tools, code generation, reasoning/);
    assert.match(context.drawer, /LiveCodeBench/);
    assert.doesNotMatch(context.drawer, /undefined|NaN/);
  }
});
