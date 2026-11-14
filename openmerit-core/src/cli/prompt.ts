// Terminal prompts on stderr, so stdout stays clean for --json output.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Answer, Question } from "../scout/workflow.ts";

export interface Prompter {
  /** `signal` cancels a pending question, which then rejects. */
  ask(question: string, fallback?: string, signal?: AbortSignal): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: { value: T; label: string }[], fallback?: T): Promise<T>;
  /** Releases the terminal to `run`, such as a child process with inherited stdin, then takes it back. */
  handOver<T>(run: () => Promise<T>): Promise<T>;
  close(): void;
}

export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Prompter {
  let muted = false;
  const write = (output as NodeJS.WriteStream).write.bind(output);
  // readline echoes typed characters to its output, so a secret is hidden by giving it this stream
  // instead of `output`; overriding readline's `_writeToOutput` no longer reaches its own writes.
  const echo = new Writable({ write(chunk, _encoding, done) { const text = String(chunk); if (!muted || text.includes("\n")) write(muted ? "\n" : text); done(); } });
  Object.defineProperty(echo, "columns", { get: () => (output as NodeJS.WriteStream).columns });
  const open = () => createInterface({ input, output: echo, terminal: (input as NodeJS.ReadStream).isTTY === true });
  let rl = open();
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
    // An open readline keeps reading the terminal, so a child sharing it would lose keystrokes to it.
    async handOver(run) {
      rl.close();
      try { return await run(); } finally { rl = open(); }
    },
    close() { rl.close(); },
  };
}

const WORKING = ["eval-ing", "checking", "understanding", "proof-reading", "comparing", "tallying", "weighing", "cross-checking", "pondering", "measuring"];
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * On a terminal, shows that Scout is still working when nothing has been printed for `quietMs`: one
 * line with a spinner, a rotating word and the seconds since the last output. `log` clears it before
 * printing. Without a terminal it only prints.
 */
export function workingTicker(output: NodeJS.WriteStream = process.stderr, quietMs = 3000) {
  let last = Date.now(), shown = false, frame = 0;
  const first = Math.floor(Math.random() * WORKING.length);
  const clear = () => { if (shown) { output.write("\r\x1b[2K"); shown = false; } };
  const timer = output.isTTY ? setInterval(() => {
    const quiet = Date.now() - last;
    if (quiet < quietMs) return;
    output.write(`\r\x1b[2K${SPINNER[frame++ % SPINNER.length]} ${WORKING[(first + Math.floor(quiet / 4000)) % WORKING.length]}… ${Math.round(quiet / 1000)}s`);
    shown = true;
  }, 120) : null;
  timer?.unref();
  return {
    log(line: string) { clear(); output.write(`${line}\n`); last = Date.now(); },
    stop() { if (timer) clearInterval(timer); clear(); },
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
        const answer = await prompter.ask(`Numbers or "all"${question.hint ? `, ${question.hint}` : ""}`, options.length === 1 ? "1" : undefined);
        // Entries with "=" (such as a mapping correction) pass through as typed; the rest are option numbers.
        const items = answer.split(",").map(item => item.trim()).filter(Boolean);
        const typed = question.hint ? items.filter(item => item.includes("=")) : [];
        const numbers = items.filter(item => !typed.includes(item)).flatMap(item => item.split(/\s+/));
        const picked = numbers.length === 1 && /^all$/i.test(numbers[0]!) ? options : numbers.map(item => options[Number(item) - 1]);
        if ((picked.length || typed.length) && picked.every(Boolean)) return [...typed, ...picked.map(option => option!.value)];
      }
    }
    case "text": return prompter.ask(question.prompt, typeof question.default === "string" ? question.default : undefined);
  }
}
