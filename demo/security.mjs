import { models, harnessModel, limits, getTask, providerModels } from './runtime/config.mjs';
import { decisionBody } from './runtime/moderation.mjs';

export const allowedModels = new Set([...models.map(m => m.id), harnessModel]);
export const sessionReservationLimit = 1.25;
export function inferenceRequest(input, bytes, taskId = 'support') {
  const task=getTask(taskId);
  const taskModels = new Set([...providerModels({...task,models:task.models.filter(m=>m.api !== 'decisions')}),harnessModel]);
  if (!input || !taskModels.has(input.model)) throw new Error('Model is not allowed.');
  if (!Array.isArray(input.messages) || !input.messages.length || bytes > limits.maxInputBytes) throw new Error('Invalid or oversized inference request.');
  const requested = input.max_tokens ?? input.max_completion_tokens ?? limits.maxOutputTokens;
  if (!Number.isInteger(requested) || requested < 1) throw new Error('Invalid output limit.');
  const maximum = Math.min(requested, getTask(taskId).maxOutputTokens ?? limits.maxOutputTokens);
  const body = { model: input.model, messages: input.messages, max_tokens: maximum,
    stream: input.stream === true, provider: { require_parameters: true, max_price: { prompt: 0.5, completion: 3 } },
    usage: { include: true } };
  for (const key of ['tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'response_format', 'reasoning', 'parallel_tool_calls']) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (body.stream) body.stream_options = { include_usage: true };
  // Conservative admission allowance, separate from the application's measured
  // provider cost. Include tool/message overhead and reserve full output tokens.
  const reservation = ((bytes + 4096) * 0.5 + maximum * 3) / 1e6;
  return { body, reservation };
}

export function decisionRequest(input, bytes, taskId) {
  if (taskId !== 'spam' || input?.model !== 'typesafe/jev-1.13') throw new Error('Decision model is not allowed.');
  if (bytes > 6000 || typeof input.state?.comment !== 'string' || input.state.comment.length < 5 || input.state.comment.length > 1200) throw new Error('Invalid or oversized decision input.');
  // Reconstruct the only permitted question; callers cannot add questions,
  // alternate models, tracing destinations, or provider-price overrides.
  const body = decisionBody(input.state.comment);
  const reservation = (new TextEncoder().encode(JSON.stringify(body)).length + 4096) * .05 / 1e6;
  return {body,reservation};
}

export async function limitedText(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) throw new Error('Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new Error('Request is too large.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
export function sessionCookie(id, maxAge = 600) {
  return `openmerit_demo=${id}; Path=/demo; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
export function readSessionCookie(request) {
  const id = request.headers.get('Cookie')?.match(/(?:^|;\s*)openmerit_demo=([a-f0-9]{64})(?:;|$)/)?.[1];
  return id ?? null;
}
export function response(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
