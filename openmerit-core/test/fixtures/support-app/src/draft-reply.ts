// Drafts a first reply to a ticket for an agent to edit.
export const draftConfig = {
  model: "gpt-4.1-mini",
  temperature: 0.3,
  apiKey: "sk-test-abcdefghijklmnopqrstuvwx",
};

export function draftPrompt(ticket: string, queue: string) {
  return `Write a short, friendly first reply to this ${queue} ticket:\n\n${ticket}`;
}
