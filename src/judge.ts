/** Judge: score a model's answer against a rubric. */

import { chat, chatWithImages } from "./llm.js";
import type { TaskImage } from "./task-input.js";

export const JUDGE_PREFS = ["openai/gpt-4o-mini", "openai/gpt-4o"];

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
  key: string,
  judgeModel: string,
  task: string,
  rubric: string,
  answer: string,
): Promise<JudgeResult> {
  const { content } = await chat(
    key,
    judgeModel,
    JUDGE_PROMPT.replace("{task}", task)
      .replace("{rubric}", rubric)
      .replace("{answer}", answer.slice(0, 16000)),
    1024,
    0,
  );
  try {
    const j = parseObj(content);
    return { score: Number(j.score ?? 0), why: String(j.why ?? "") };
  } catch {
    return { score: 0, why: "unparseable judge output" };
  }
}

/** Grade OCR answers against the actual uploaded pixels, not answer text alone. */
export async function judgeWithImages(
  key: string, judgeModel: string, task: string, rubric: string,
  answer: string, images: TaskImage[],
): Promise<JudgeResult> {
  const prompt = `You are grading an answer to a visual task. Inspect the attached image carefully.\n` +
    `TASK: ${task}\nRUBRIC: ${rubric}\nANSWER: ${answer.slice(0, 16000)}\n` +
    `For invoice extraction, check every visible field and line item against the image. ` +
    `Penalize missing, invented, or mistyped values and invalid JSON. ` +
    `Return ONLY json: {"score": <0..1>, "why": "<one line>"}`;
  const { content } = await chatWithImages(key, judgeModel, prompt, images, 1024);
  try {
    const j = parseObj(content);
    return { score: Number(j.score ?? 0), why: String(j.why ?? "") };
  } catch {
    return { score: 0, why: "unparseable visual judge output" };
  }
}
