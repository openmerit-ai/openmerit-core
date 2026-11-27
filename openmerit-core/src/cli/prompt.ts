// Terminal prompts on stderr, so stdout stays clean for --json output.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

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
