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
    const pairs = context.snapshot.simulation.assignments;
    const overrideCount = pairs.filter(pair=>pair.override).length;
    assert.doesNotMatch(markup, /Plan incomplete|Needs a qualifying replacement/);
    const amount = context.snapshot.simulation.windows[0].afterCost.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
    assert.ok(markup.includes(amount));
    if (overrideCount) {
      assert.ok(markup.includes(`${overrideCount} preference overrides`));
      assert.match(markup, /Included in After costs · primary criteria not met/);
      assert.match(markup, /Review exceptions/);
      const rows = markup.slice(markup.indexOf('<tbody>'));
      assert.ok(rows.indexOf(pairs.find(pair=>pair.override).purpose) < rows.indexOf('Actuarial query generation'));
    } else assert.doesNotMatch(markup, /class="comparison-override"/);
    assert.match(markup, /Token cost ·/);
    if (value === 'closed') {
      const main = vm.runInContext('main()', context);
      assert.match(main, /id="model-results"/);
      const inventory = main.slice(main.indexOf('id="model-results"'));
      assert.doesNotMatch(inventory, /gpt-oss|GLM-5.3|Mistral Medium/);
      for (const hours of [1,168,720]) {
        context.hours = hours;
        const ranged = vm.runInContext('state.hours=hours; comparisonPanel()', context);
        assert.match(ranged, /3 preference overrides/);
        assert.doesNotMatch(ranged, /Plan incomplete|NaN|undefined/);
      }
      vm.runInContext('state.hours=0;',context);
    }
    vm.runInContext('openInspector = (title, subtitle, body) => { globalThis.drawer = body; }; showPrices();', context);
    assert.match(context.drawer, /Review 26 candidates/);
    assert.doesNotMatch(context.drawer, /Every swap clears|never waive a gate/);
    if (overrideCount) {
      assert.match(context.drawer, /Criteria overridden/);
      assert.match(context.drawer, /Selected · override/);
      assert.match(context.drawer, /No comparable evidence/);
      assert.match(context.drawer, /Missing evidence is uncertainty, not a pass/);
    }
    if (value === 'closed') assert.match(context.drawer, /No verified cost or latency improvement/);
    assert.match(context.drawer, /Published benchmark comparison/);
    assert.match(context.drawer, /Application code · tools, code generation, reasoning/);
    assert.match(context.drawer, /LiveCodeBench/);
    assert.doesNotMatch(context.drawer, /undefined|NaN/);
  }
});
