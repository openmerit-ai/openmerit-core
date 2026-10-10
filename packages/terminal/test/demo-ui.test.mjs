import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { demoSnapshot, PRICE_DATE } from '../src/enterprise-sample.mjs';
import { PREFERENCES, preferenceFor } from '../src/demo-policy.mjs';
import * as history from '../src/history.mjs';
import * as brands from '../client/brands.mjs';

// Execute the actual view functions. Stub browser mounts, not the selection logic.
test('every demo preference renders its real plan, costs, decisions and evidence', async () => {
  const source = (await readFile(new URL('../client/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('void start();', '');
  const selectSource = (await readFile(new URL('../client/select.js', import.meta.url), 'utf8')).replace(/export /g, '');
  const context = vm.createContext({ ...history, ...brands, PREFERENCES, preferenceFor, PRICE_DATE, URLSearchParams,
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
    if (['default','closed'].includes(value)) assert.match(markup, /25 (offers reviewed|model\/service offers)/);
    if (value === 'closed') {
      assert.match(markup, /No qualifying plan/);
      assert.doesNotMatch(markup, /% lower/);
      const main = vm.runInContext('main()', context);
      assert.match(main, /No qualifying After plan/);
      assert.doesNotMatch(main, /id="model-results"/);
    } else {
      assert.match(markup, /4 model changes · 1 service change · 5 retained/);
      assert.match(markup, /215,363.17/);
      if (value !== 'default') assert.match(markup, /Same choices as Default/);
    }
    vm.runInContext('openInspector = (title, subtitle, body) => { globalThis.drawer = body; }; showPrices();', context);
    assert.match(context.drawer, /Review 25 candidates/);
    assert.match(context.drawer, /Published benchmark comparison/);
    assert.doesNotMatch(context.drawer, /undefined|NaN/);
  }
});
