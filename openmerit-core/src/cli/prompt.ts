// Terminal prompts on stderr, so stdout stays clean for --json output.
import { createInterface } from "node:readline/promises";
import type { Answer, Question } from "../scout/workflow.ts";

export interface Prompter {
  /** `signal` cancels a pending question, which then rejects. */
  ask(question: string, fallback?: string, signal?: AbortSignal): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: { value: T; label: string }[], fallback?: T): Promise<T>;
  close(): void;
}

export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Prompter {
  const rl = createInterface({ input, output, terminal: (input as NodeJS.ReadStream).isTTY === true });
  let muted = false;
  const write = (output as NodeJS.WriteStream).write.bind(output);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => { if (!muted || text.includes("\n")) write(muted ? "\n" : text); };
  const ask = async (question: string, fallback?: string, signal?: AbortSignal) => {
    const answer = (await rl.question(`${question}${fallback !== undefined && fallback !== "" ? ` [${fallback}]` : ""} `, signal ? { signal } : {})).trim();
    return answer || fallback || "";
  };
  return {
    ask,
    async secret(question) {
      write(`${question} `);
      muted = true;
      try { return (await rl.question("")).trim(); } finally { muted = false; }
    },
    async confirm(question, fallback = false) {
      for (;;) {
        const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
        if (!answer) return fallback;
        if (/^(y|yes)$/.test(answer)) return true;
        if (/^(n|no)$/.test(answer)) return false;
      }
    },
    async choose(question, options, fallback) {
      write(`${question}\n${options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n")}\n`);
      for (;;) {
        const fallbackIndex = fallback ? options.findIndex(option => option.value === fallback) + 1 : 0;
        const answer = await ask("Choose a number", fallbackIndex ? String(fallbackIndex) : undefined);
        const picked = options[Number(answer) - 1] ?? options.find(option => option.value === answer);
        if (picked) return picked.value;
      }
    },
    close() { rl.close(); },
  };
}

/** Asks one workflow question in the terminal. */
export async function askQuestion(prompter: Prompter, question: Question, log: (line: string) => void): Promise<Answer> {
  if (question.detail) log(`\n${question.detail}\n`);
  switch (question.kind) {
    case "confirm": return prompter.confirm(question.prompt, question.default === true);
    case "choice": return prompter.choose(question.prompt, question.options ?? [], typeof question.default === "string" ? question.default : undefined);
    case "multi": {
      const options = question.options ?? [];
      log(`${question.prompt}\n${options.map((option, index) => `  ${index + 1}. ${option.label}${option.detail ? `\n     ${option.detail}` : ""}`).join("\n")}`);
      for (;;) {
        const answer = await prompter.ask("Numbers, comma-separated (or \"all\")", options.length === 1 ? "1" : undefined);
        const picked = /^all$/i.test(answer) ? options : answer.split(/[\s,]+/).filter(Boolean).map(item => options[Number(item) - 1]);
        if (picked.length && picked.every(Boolean)) return picked.map(option => option!.value);
      }
    }
    case "text": return prompter.ask(question.prompt, typeof question.default === "string" ? question.default : undefined);
  }
}
