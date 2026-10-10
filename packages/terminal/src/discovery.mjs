import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, resolve, sep, isAbsolute } from 'node:path';
import { configuredServices } from './services.mjs';
import { SERVICE_CREDENTIAL_FIELDS, SERVICE_ENDPOINT_FIELDS } from './service-registry.mjs';

const LIMIT = 128 * 1024;
const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const credentials = new Set(SERVICE_CREDENTIAL_FIELDS);
const endpoints = new Set([...SERVICE_ENDPOINT_FIELDS, 'OLLAMA_HOST', 'OLLAMA_BASE_URL']);
const sdks = new Set(['openai', '@anthropic-ai/sdk', '@google/genai', '@google/generative-ai', 'groq-sdk', '@cerebras/cerebras_cloud_sdk', '@lmstudio/sdk', 'ollama', 'ollama-js', 'ai', 'litellm', 'anthropic', 'groq', 'cerebras-cloud-sdk', 'baseten', '@huggingface/inference', 'huggingface_hub', 'huggingface-hub', '@mistralai/mistralai', 'mistralai', 'cohere-ai', 'cohere', 'together-ai', 'together', 'fireworks-ai', 'replicate', 'voyageai', 'portkey-ai', 'xai-sdk', '@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-sagemaker-runtime', '@google-cloud/vertexai', 'google-cloud-aiplatform', '@azure/ai-inference', 'azure-ai-inference']);

// Parse literal assignments only. Never source a shell file, expand variables,
// return credential contents, or guess how the application loads its config.
export function envDeclarations(body) {
  const result = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !credentials.has(match[1]) && !endpoints.has(match[1])) continue;
    let value = match[2];
    if (/^["']/.test(value)) { const quote = value[0], end = value.indexOf(quote, 1); if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) continue; value = value.slice(1, end); }
    else value = value.replace(/\s+#.*$/, '').trim();
    if (/[\x00-\x1f$`]/.test(value)) continue;
    result[match[1]] = credentials.has(match[1]) ? (value ? 'present' : '') : value.slice(0, 2049);
  }
  return result;
}
export function loopbackEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) return null;
    return url.origin.replace('://localhost', '://127.0.0.1');
  } catch { return null; }
}
async function boundedFile(root, name) {
  const path = await realpath(resolve(root, name));
  if (!inside(await realpath(root), path)) throw new Error('Outside project');
  if (!(await stat(path)).isFile()) throw new Error('Unsupported file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) throw new Error('Unsupported file');
    const buffer = Buffer.alloc(LIMIT + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMIT) throw new Error('Oversized file');
    return { body: buffer.subarray(0, bytesRead).toString('utf8'), at: info.mtime.toISOString() };
  } finally { await handle.close(); }
}

export async function discoverProject(root) {
  const sources = [], inventory = [], runtimes = new Map();
  const local = (values, sourceId) => {
    for (const field of endpoints) {
      const nativeOllama = field === 'OLLAMA_HOST' || field === 'OLLAMA_BASE_URL';
      const value = values[field];
      const url = loopbackEndpoint(nativeOllama && value && !value.includes('://') ? `http://${value}` : value);
      if (!url) continue;
      // A named protocol declaration takes precedence over an API-compatible alias.
      if (runtimes.get(url)?.type === 'ollama' && !nativeOllama) continue;
      runtimes.set(url, { id: `discovered:${url}`, name: nativeOllama ? `Ollama · ${new URL(url).host}` : url, type: nativeOllama ? 'ollama' : 'discover', url, discoverySource: sourceId, discoveryField: field });
    }
  };
  // Shell-wide endpoint variables are not evidence that this project uses a runtime.
  // Only selected-project declarations and explicit terminal configuration authorize probes.
  for (const name of ['.env', '.env.local', 'package.json', 'requirements.txt']) {
    let file;
    try { file = await boundedFile(root, name); }
    catch (error) {
      if (error.code !== 'ENOENT') sources.push({ id: `project:${name}`, name, kind: 'Project discovery', state: 'unavailable', detail: name, note: 'This supported file could not be read within the project and size limits.', coverage: ['Configuration'], access: 'Selected project' });
      continue;
    }
    const id = `project:${name}`;
    if (name.startsWith('.env')) {
      const declarations = envDeclarations(file.body), identified = configuredServices(declarations);
      local(declarations, id);
      const unknown = identified.unrecognizedEndpoints.filter(field => !loopbackEndpoint(declarations[field]));
      const fields = Object.keys(declarations);
      if (!fields.length) continue;
      for (const item of identified.services) inventory.push({ ...item, sourceId: id, evidence: item.evidence.map(entry => ({ ...entry, sourceId: id })) });
      sources.push({ id, name, kind: 'Project discovery', state: unknown.length ? 'partial' : 'connected', detail: fields.join(' · '), updatedAt: new Date().toISOString(), modifiedAt: file.at, coverage: ['Declared services', 'Local endpoint candidates'], access: 'Selected project', note: 'Literal declarations only; this does not establish that the application loaded this file. Credential contents, expressions, and unrelated settings are discarded. Only recognized HTTPS service identities and safe loopback origins are retained.' + (unknown.length ? ' Some endpoint declarations could not identify a cloud service.' : '') });
    } else {
      let matches;
      try {
        if (name === 'package.json') {
          const parsed = JSON.parse(file.body);
          matches = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies, ...parsed.optionalDependencies }).filter(key => sdks.has(key));
        } else matches = [];
      } catch { sources.push({ id, name, kind: 'Project discovery', state: 'unavailable', detail: name, note: 'The package manifest could not be parsed.', coverage: ['SDK declarations'], access: 'Selected project' }); continue; }
      // requirements use a deliberately small name/version grammar, never URLs or commands.
      if (name === 'requirements.txt') matches = file.body.split(/\r?\n/).map(line => line.match(/^\s*([a-zA-Z0-9_-]+)(?:\s*(?:[<>=!~\[]|$))/)?.[1]).filter(key => sdks.has(key));
      if (matches.length) sources.push({ id, name: 'SDK declarations', kind: 'Project discovery', state: 'detected', detail: `${name} · ${[...new Set(matches)].join(' · ')}`, updatedAt: new Date().toISOString(), modifiedAt: file.at, coverage: ['SDK declarations'], access: 'Selected project', note: 'Supported SDKs are declared here. An SDK does not establish a configured provider, running service, request, or cost.' });
    }
  }
  return { sources, inventory, runtimes: [...runtimes.values()] };
}

export function discoveryCandidates(project, configured = [], ollama, limit = 8) {
  const claimed = new Set([ollama, ...configured.map(item => item.url)].filter(Boolean).map(value => loopbackEndpoint(value) || value));
  return [...new Map([...project.runtimes].map(item => [item.url, item])).values()].filter(item => !claimed.has(item.url)).slice(0, limit);
}
