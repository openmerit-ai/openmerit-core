import { opendir, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const FILE_BYTES = 512 * 1024, TOTAL_BYTES = 4 * 1024 * 1024, MAX_FILES = 128, MAX_RECORDS = 10000, FILE_RECORDS = 312;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function piUsageRecord(entry, session, normalize) {
  const message = entry?.message, usage = message?.usage;
  if (entry?.type !== 'message' || (typeof entry.id !== 'string' || entry.id.length > 64) || message?.role !== 'assistant' || !usage || !message.model || !message.provider || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)) return null;
  const input = [usage.input, usage.cacheRead, usage.cacheWrite].map(nonnegative);
  // Pi records the selected provider connection ID on each assistant message.
  // Preserve that source identity; category resolution stays with the existing
  // inventory/runtime matcher. Generic activity.provider is not a connection.
  return normalize({ id: `pi:${session}:${entry.id}`, occurredAt: entry.timestamp, model: message.model, provider: message.provider, route: message.provider, workload: 'Pi', scope: 'agent', inputTokens: input.every(value => value != null) ? input.reduce((sum, value) => sum + value, 0) : null, outputTokens: nonnegative(usage.output), cacheReadTokens: nonnegative(usage.cacheRead), cost: nonnegative(usage.cost?.total), costKind: 'estimated', currency: 'USD', status: ['error', 'aborted'].includes(message.stopReason) ? 'failed' : 'completed' }, 'pi-history');
}

export function createPiHistory(access, normalize) {
  const readers = new Map();
  return async function read() {
    const permission = await access.status();
    const source = { id: 'pi-history', name: 'Pi usage history', kind: 'Local application', state: permission.state === 'denied' ? 'disabled' : permission.state, detail: permission.path, coverage: ['Models', 'Recorded requests', 'Connection names', 'Tokens', 'Estimated cost'], access: permission.state === 'allowed' ? 'Allowed for this project' : permission.state === 'denied' ? 'Not allowed' : 'Permission required', accessCommand: 'openmerit dash --access', note: 'Optional Pi session usage for this project. Session files can contain conversation text; only assistant usage metadata is retained. No task or agent identity is inferred from a session. Connection names use Pi’s recorded provider ID; types require matching inventory or runtime evidence. SDK cost is an estimate; request timing, hidden hops, and deployments remain unknown.' };
    if (permission.state !== 'allowed') { readers.clear(); return { source, records: [] }; }
    const files = []; let omitted = false, invalid = false, budget = TOTAL_BYTES;
    try {
      const directory = await opendir(permission.path); let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 512) { omitted = true; break; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(permission.path, entry.name), info = await stat(path);
        if (info.mtimeMs >= Date.now() - 86400000) files.push({ path, info });
      }
      files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
      if (files.length > MAX_FILES) omitted = true;
      const chosen = files.slice(0, MAX_FILES), active = new Set(chosen.map(file => file.path));
      for (const key of readers.keys()) if (!active.has(key)) readers.delete(key);
      for (const file of chosen) {
        if (budget <= 0) { omitted = true; readers.delete(file.path); continue; }
        try {
          // Refuse symlink substitution and verify the header's cwd: Pi's folder
          // encoding alone is not an authoritative project identity.
          if (await realpath(file.path) !== file.path) throw new Error('Symlink');
          const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
          try {
            const info = await handle.stat(); if (!info.isFile()) throw new Error('Not a file');
            let reader = readers.get(file.path);
            const identity = `${info.dev}:${info.ino}`;
            if (!reader || reader.identity !== identity || info.size < reader.offset || info.size === reader.offset && info.mtimeMs !== reader.mtime) {
              const head = Buffer.alloc(8192), read = await handle.read(head, 0, head.length, 0), first = head.subarray(0, read.bytesRead).toString('utf8').split('\n')[0];
              const header = JSON.parse(first);
              if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || header.id.length > 64 || typeof header.cwd !== 'string' || await realpath(header.cwd) !== permission.project) throw new Error('Unsupported session');
              reader = { identity, offset: 0, mtime: 0, session: header.id, truncated: false, invalid: false, pending: '', decoder: new StringDecoder('utf8'), records: new Map() };
            }
            let skip = false;
            if (info.size - reader.offset > Math.min(FILE_BYTES, budget)) { reader.offset = info.size - Math.min(FILE_BYTES, budget); reader.pending = ''; reader.decoder = new StringDecoder('utf8'); reader.records.clear(); skip = true; reader.truncated = true; omitted = true; }
            const buffer = Buffer.alloc(Math.min(FILE_BYTES, budget, info.size - reader.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, reader.offset);
            budget -= bytesRead; reader.offset += bytesRead; reader.mtime = info.mtimeMs;
            const lines = (reader.pending + reader.decoder.write(buffer.subarray(0, bytesRead))).split('\n'); reader.pending = lines.pop() || '';
            if (skip) lines.shift();
            for (const line of lines) {
              if (!line.trim()) continue;
              try { const record = piUsageRecord(JSON.parse(line), reader.session, normalize); if (record) reader.records.set(record.id, record); } catch { reader.invalid = true; invalid = true; }
            }
            if (reader.pending.length > 128 * 1024) { reader.pending = ''; reader.invalid = true; invalid = true; }
            for (const [id, record] of reader.records) if (Date.parse(record.occurredAt) < Date.now() - 86400000) reader.records.delete(id);
            while (reader.records.size > FILE_RECORDS) { reader.records.delete(reader.records.keys().next().value); reader.truncated = true; omitted = true; }
            omitted ||= reader.truncated; invalid ||= reader.invalid;
            readers.set(file.path, reader);
          } finally { await handle.close(); }
        } catch { readers.delete(file.path); invalid = true; }
      }
      // Recheck revocation before returning data read during this collection.
      const current = await access.status();
      if (current.state !== 'allowed' || current.path !== permission.path || current.project !== permission.project) {
        readers.clear();
        return { source: { ...source, state: current.state === 'allowed' ? 'partial' : 'disabled', note: 'Access changed during collection. Metadata was discarded; the next poll will check the current permission.' }, records: [] };
      }
      let records = [...new Map([...readers.values()].flatMap(reader => [...reader.records]).map(([id, record]) => [id, record])).values()].filter(record => Date.parse(record.occurredAt) <= Date.now());
      records.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
      if (records.length > MAX_RECORDS) { records = records.slice(0, MAX_RECORDS); omitted = true; }
      return { records, source: { ...source, state: invalid || omitted ? 'partial' : 'connected', updatedAt: new Date().toISOString(), records: records.length, note: source.note + (omitted ? ' The bounded scan omitted older files or records.' : '') + (invalid ? ' Unreadable, malformed, or unsupported sessions were skipped.' : '') } };
    } catch { readers.clear(); return { source: { ...source, state: 'unavailable' }, records: [] }; }
  };
}
