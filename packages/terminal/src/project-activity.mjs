import { opendir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const FILE_BYTES = 512 * 1024, TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128, MAX_ENTRIES = 2048, MAX_RECORDS = 10000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

// Recognize recorded request objects, not arbitrary JSON or a model catalog.
// No source-code execution, prompt interpretation, or filename-based providers.
export function projectActivityRecord(value, sourceId, file, normalize) {
  if (!object(value)) return null;
  const body = object(value.response) ? value.response : value;
  const usage = body.usage;
  const responses = body.object === 'response';
  const chat = body.object === 'chat.completion';
  const structured = !responses && !chat && id(value.id) && typeof value.occurredAt === 'string';
  if (!responses && !chat && !structured) return null;
  const measured = object(usage) && [usage.input_tokens, usage.output_tokens, usage.prompt_tokens, usage.completion_tokens].some(finite);
  const terminal = ['completed', 'failed', 'running'].includes(value.status);
  if (!measured && !(structured && terminal && (finite(value.httpStatus) || value.event === 'inference.request'))) return null;
  const requestId = structured ? value.requestId : body.id;
  const recordId = structured ? value.id : body.id;
  if (!id(recordId) || !id(body.model ?? value.model)) return null;
  let occurredAt = value.occurredAt;
  if (!occurredAt && (responses || chat)) {
    const seconds = responses ? body.created_at : body.created;
    if (finite(seconds) && seconds < 8640000000000) occurredAt = new Date(seconds * 1000).toISOString();
  }
  if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))) return null;
  // An API-compatible response shape doesn't prove which company served it.
  // Connection, workload, and agent/task fields must be explicitly recorded.
  const status = structured ? value.status : responses
    ? ({ completed: 'completed', failed: 'failed', cancelled: 'failed', incomplete: 'failed', in_progress: 'running', queued: 'running' })[body.status]
    : body.choices?.length && body.choices.every(choice => typeof choice.finish_reason === 'string')
      ? body.choices.some(choice => ['error', 'content_filter'].includes(choice.finish_reason)) ? 'failed' : 'completed' : null;
  if (!['completed', 'failed', 'running'].includes(status)) return null;
  const record = normalize({
    ...value, id: recordId, requestId, occurredAt, status, model: body.model ?? value.model,
    provider: value.provider ?? body.provider,
    workload: value.workload || value.application || file,
    inputTokens: structured && finite(value.inputTokens) ? value.inputTokens : usage?.input_tokens ?? usage?.prompt_tokens,
    outputTokens: structured && finite(value.outputTokens) ? value.outputTokens : usage?.output_tokens ?? usage?.completion_tokens,
    cacheReadTokens: structured && finite(value.cacheReadTokens) ? value.cacheReadTokens : usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens,
    cost: finite(value.cost) ? value.cost : usage?.cost,
  }, sourceId);
  return record && { ...record, evidenceFormat: responses ? 'responses' : chat ? 'chat-completion' : 'structured-request' };
}

export function createProjectActivity(root, normalize, { exclude = [] } = {}) {
  const readers = new Map();
  return async function collect() {
    const files = [], issues = []; let visited = 0, omitted = false, budget = TOTAL_BYTES;
    const canonicalRoot = await realpath(root);
    const excludedPaths = exclude.map(path => join(canonicalRoot, relative(root, path)));
    const allowed = path => path.startsWith(canonicalRoot + sep);
    async function scan(path, depth) {
      let directory;
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) return;
        directory = await opendir(path);
        for await (const entry of directory) {
          if (++visited > MAX_ENTRIES) { omitted = true; break; }
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const child = join(path, entry.name);
          if (entry.isDirectory() && depth > 0) await scan(child, depth - 1);
          else if (entry.isFile() && /\.jsonl(?:\.\d+)?$/.test(entry.name) && !excludedPaths.includes(child)) {
            const info = await lstat(child);
            if (info.isFile() && !info.isSymbolicLink()) files.push({ path: child, info });
          }
          if (visited >= MAX_ENTRIES) { omitted = true; break; }
        }
      } catch (error) { if (error.code !== 'ENOENT') issues.push(relative(canonicalRoot, path)); }
    }
    // Fixed project-local log roots. Never recursively inspect the repository,
    // home directory, dependency trees, credentials, or arbitrary databases.
    for (const name of ['logs', 'runs', 'results']) {
      if (visited >= MAX_ENTRIES) break;
      await scan(join(canonicalRoot, name), 2);
    }
    files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.path.localeCompare(b.path));
    if (files.length > MAX_FILES) omitted = true;
    const chosen = files.slice(0, MAX_FILES), active = new Set(chosen.map(file => file.path));
    for (const path of readers.keys()) if (!active.has(path)) readers.delete(path);
    const sources = [], records = [];
    for (const file of chosen) {
      const name = relative(canonicalRoot, file.path), sourceId = `project-log:${hash(name)}`;
      const source = { id: sourceId, name: 'Project request log', kind: 'Project activity', detail: name,
        access: 'Selected project', coverage: ['Recorded requests', 'Reported identities', 'Tokens', 'Reported or estimated cost'],
        note: 'Supported request metadata read from an existing JSONL log. Names and measurements are copied from recorded fields. Prompts, outputs, headers, and credentials are discarded. No account API or inference call is made.' };
      try {
        if (!allowed(file.path) || await realpath(file.path) !== file.path) throw new Error('Outside project or symlink');
        const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error('Not a regular file');
          let reader = readers.get(file.path);
          const identity = `${info.dev}:${info.ino}`;
          if (!reader || reader.identity !== identity || info.size < reader.offset || info.size === reader.offset && info.mtimeMs !== reader.mtime) {
            reader = { identity, offset: 0, mtime: 0, pending: '', decoder: new StringDecoder('utf8'), records: new Map(), invalid: 0, unsupported: 0, truncated: false };
          }
          const limit = Math.min(FILE_BYTES, budget);
          if (limit === 0 && info.size > reader.offset) { omitted = true; sources.push({ ...source, state: 'partial', records: 0, note: source.note + ' Waiting for the next bounded read.' }); continue; }
          let skip = false;
          if (info.size - reader.offset > limit) { reader.offset = info.size - limit; reader.pending = ''; reader.decoder = new StringDecoder('utf8'); reader.records.clear(); reader.truncated = true; skip = true; }
          const buffer = Buffer.alloc(Math.min(limit, info.size - reader.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, reader.offset);
          reader.offset += bytesRead; reader.mtime = info.mtimeMs; budget -= bytesRead;
          const lines = (reader.pending + reader.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
          reader.pending = lines.pop() ?? ''; if (skip) lines.shift();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const record = projectActivityRecord(JSON.parse(line), sourceId, name, normalize);
              if (!record) { reader.unsupported++; continue; }
              reader.records.delete(record.id); reader.records.set(record.id, record);
            } catch { reader.invalid++; }
          }
          if (reader.pending.length > 128 * 1024) { reader.pending = ''; reader.invalid++; }
          while (reader.records.size > 1000) { reader.records.delete(reader.records.keys().next().value); reader.truncated = true; }
          readers.set(file.path, reader);
          const retained = [...reader.records.values()].filter(record => Date.parse(record.occurredAt) <= Date.now());
          records.push(...retained);
          // Even an unsupported log is visible as a coverage gap, never a
          // silently successful connection with zero fabricated requests.
          sources.push({ ...source, state: reader.invalid || reader.unsupported || reader.truncated ? 'partial' : 'connected', records: retained.length,
            updatedAt: new Date().toISOString(), invalid: reader.invalid, unsupported: reader.unsupported, truncated: reader.truncated,
            note: source.note + (reader.truncated ? ' The bounded reader omitted older records.' : '') + (reader.invalid || reader.unsupported ? ' Some lines were malformed or did not match a supported request format.' : '') });
        } finally { await handle.close(); }
      } catch { readers.delete(file.path); sources.push({ ...source, state: 'unavailable', records: 0 }); }
    }
    records.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    if (records.length > MAX_RECORDS) {
      omitted = true;
      const retained = new Set(records.slice(0, MAX_RECORDS));
      for (const [path, reader] of readers) {
        let removed = false;
        for (const [id, record] of reader.records) if (!retained.has(record)) { reader.records.delete(id); removed = true; }
        if (removed) {
          reader.truncated = true;
          const source = sources.find(source => source.detail === relative(canonicalRoot, path));
          if (source) { source.state = 'partial'; source.records = reader.records.size; source.truncated = true; source.note += ' The shared 10,000-record cache limit omitted older records.'; }
        }
      }
    }
    if (omitted || issues.length) sources.push({ id: 'project-log-coverage', name: 'Project log coverage', kind: 'Project activity', state: 'partial', detail: 'logs/ · runs/ · results/', note: 'The bounded scan omitted files or records, or a log directory was unreadable. These sources do not establish complete project usage.' });
    return { records: records.slice(0, MAX_RECORDS), sources };
  };
}
