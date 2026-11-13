// Fictional support app: routes each ticket to a queue.
const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "gpt-4.1-mini";

export const LABELS = ["billing", "technical", "account", "other"] as const;
const PROMPT = `Classify the support ticket into exactly one queue: ${LABELS.join(", ")}. Reply with the queue name only, in lowercase.`;

export async function classify(ticket: string, model: string = CLASSIFIER_MODEL): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_completion_tokens: 2000, messages: [{ role: "system", content: PROMPT }, { role: "user", content: ticket }] }),
  });
  if (!response.ok) throw new Error(`classifier HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { choices: { message: { content: string | null } }[] };
  return (body.choices[0]?.message.content ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
}
