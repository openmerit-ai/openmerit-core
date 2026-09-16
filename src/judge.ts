/** Judge: score a model's answer against a rubric. */

import type { TaskImage } from "./task-input.js";
import type { MeritChatClient } from "./providers.js";
import type { ModelRoute } from "./types.js";

const JUDGE_PROMPT = `You are grading a model's answer.
TASK: {task}
RUBRIC: {rubric}
ANSWER: {answer}
Return ONLY json: {{"score": <0..1>, "why": "<one line>"}}`;

/** Extract the first {...} JSON object from model output. */
export function parseObj(txt: string): Record<string, unknown> {
  const m = txt.match(/\{.*\}/s) ?? txt.match(/\{[^}]*\}/s);
  if (!m) throw new Error("no json object found");
  return JSON.parse(m[0]) as Record<string, unknown>;
}

export interface JudgeResult {
  score: number;
  why: string;
}

export async function judge(
  client: MeritChatClient,
  judgeModel: ModelRoute,
  task: string,
  rubric: string,
  answer: string,
): Promise<JudgeResult> {
  const { content } = await client.chat(
    judgeModel,
    JUDGE_PROMPT.replace("{task}", task)
      .replace("{rubric}", rubric)
      .replace("{answer}", answer.slice(0, 16000)),
    1024,
    0,
  );
  try {
    const j = parseObj(content);
    const score = Number(j.score ?? 0);
    return { score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      why: String(j.why ?? "") };
  } catch {
    return { score: 0, why: "unparseable judge output" };
  }
}

/** Grade OCR answers against the actual uploaded pixels, not answer text alone. */
export async function judgeWithImages(
  client: MeritChatClient, judgeModel: ModelRoute, task: string, rubric: string,
  answer: string, images: TaskImage[],
): Promise<JudgeResult> {
  const prompt = `You are grading an answer to a visual task. Inspect the attached image carefully.\n` +
    `TASK: ${task}\nRUBRIC: ${rubric}\nANSWER: ${answer.slice(0, 16000)}\n` +
    `Check the answer against all relevant visible evidence. Penalize missing, invented, ` +
    `mistyped, or structurally invalid content. ` +
    `Return ONLY json: {"score": <0..1>, "why": "<one line>"}`;
  const { content } = await client.chatWithImages(judgeModel, prompt, images, 1024);
  try {
    const j = parseObj(content);
    const score = Number(j.score ?? 0);
    return { score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      why: String(j.why ?? "") };
  } catch {
    return { score: 0, why: "unparseable visual judge output" };
  }
}
