// Read publisher metadata as data. Never evaluate downloaded JavaScript.
import { parser } from '@lezer/javascript';

function literal(node, source) {
  if (!node || !['String', 'TemplateString'].includes(node.name) || node.getChild('Interpolation')) return null;
  const raw = source.slice(node.from + 1, node.to - 1);
  return raw.replace(/\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|.)/gi, (_, c) => {
    if (c[0] === 'u' || c[0] === 'x') return String.fromCodePoint(parseInt(c[1] === '{' ? c.slice(2, -1) : c.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r\n': '' })[c] ?? c;
  });
}

export const benchmarkIdentity = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseEpochDefinitions(source) {
  const records = [];
  const tree = parser.parse(source);
  tree.iterate({ enter(node) {
    if (node.name !== 'ObjectExpression') return;
    const fields = {};
    for (const property of node.node.getChildren('Property')) {
      const key = property.firstChild, name = key.name === 'PropertyDefinition' ? source.slice(key.from, key.to) : literal(key, source);
      if (!['id', 'title', 'slug', 'page_url', 'short_description', 'description', 'methodology', 'domains', 'category'].includes(name)) continue;
      const value = property.lastChild;
      fields[name] = value.name === 'ArrayExpression' ? value.getChildren('TemplateString').concat(value.getChildren('String')).map(n => literal(n, source)).filter(v => v !== null) : literal(value, source);
    }
    if (typeof fields.id === 'string' && typeof fields.title === 'string' && (fields.description || fields.short_description)) records.push(fields);
  } });
  if (records.length < 10) throw new Error('Epoch benchmark descriptions format changed.');
  return Object.fromEntries(records.map(r => [benchmarkIdentity(r.id), { title: r.title, description: [r.short_description, r.description].filter(Boolean).join('\n').slice(0, 4000), methodology: r.methodology?.slice(0, 4000) ?? null, domains: r.domains ?? [], category: r.category ?? null,
    url: new URL(r.page_url ?? `/benchmarks/${encodeURIComponent(r.slug ?? r.id)}`, 'https://epoch.ai').href }]));
}

export async function readEpochDefinitions(read) {
  const html = await read('https://epoch.ai/benchmarks', 'text', 2_000_000);
  const component = html.match(/component-url="(\/_astro\/OverviewSearch\.[\w-]+\.js)"/)?.[1];
  if (!component) throw new Error('Epoch benchmark catalogue entry point changed.');
  const queue = [component], seen = new Set();
  // Follow only bounded same-publisher data modules, not arbitrary page links.
  for (let i = 0; i < queue.length && i < 5; i++) {
    const path = queue[i]; if (seen.has(path)) continue; seen.add(path);
    const source = await read(new URL(path, 'https://epoch.ai').href, 'text', 1_000_000);
    try { return parseEpochDefinitions(source); } catch { /* The wrapper imports the data module. */ }
    for (const m of source.matchAll(/from\s*["']\.\/(benchmarks\.[\w-]+\.js)["']/g)) queue.push(`/_astro/${m[1]}`);
  }
  throw new Error('Epoch benchmark descriptions unavailable.');
}

export function analysisDescriptions(html) {
  let flight = '';
  for (const m of (html ?? '').matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
  return Object.fromEntries([...flight.matchAll(/"([\w]+)SubLabel":("(?:[^"\\]|\\.)*")/g)].map(m => [m[1], JSON.parse(m[2])]));
}

export function methodologySections(html) {
  const plain = value => value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, v => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' })[v]).replace(/\s+/g, ' ').trim();
  const body = html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '');
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)];
  if (headings.length < 3) throw new Error('Benchmark methodology format changed.');
  return headings.map((h, i) => ({ title: plain(h[2]), text: plain(body.slice(h.index + h[0].length, headings[i + 1]?.index ?? body.length)).slice(0, 2200) })).filter(s => s.text).slice(0, 80);
}
