// The daemon's Rivet registry. Each Scout run is a `scoutRun` Workflow actor keyed by its run ID.
//
// The workflow loops: wait for an `advance` message (the user's answers), then run one advance step:
// Scout's state machine (scout/workflow.ts) until it needs a person, finishes, pauses on the budget or
// fails. The step's outcome goes to actor state, where the client polls for it. Rivet keeps the wait
// for answers across daemon restarts.
//
// Steps run at least once: a step cut off by a crash runs again when the daemon comes back. That is
// safe because the state machine records every phase and eval unit in SQLite before it moves on, and a
// unit that was running when the process died is marked interrupted and asked about before it runs
// again. Nothing is paid twice without a Yes.
//
// The client's environment (the user's shell: endpoint keys, the app's own keys, PATH) reaches
// a run through the `attach` action and stays in this process's memory. It is never written to actor
// state or queue messages, which are on disk. A step that resumes after a restart without an attached
// client marks the run interrupted, and the next `openmerit scout --resume` continues it.
import { workflow } from "@rivet-dev/workflows";
import { queue, setup } from "rivetkit";
import { localContext } from "../local.ts";
import { redact } from "../engine/redact.ts";
import { advance, type Answers, type Step } from "../scout/workflow.ts";
import { State } from "../state/db.ts";

export interface AdvanceRequest { requestId: string; answers: Answers }
/**
 * The shape of rivetkit's `queue<AdvanceRequest>()` token. rivetkit does not export the token's type,
 * and the package's type declarations must be able to name it.
 */
export interface AdvanceQueue { readonly _queueMessage?: AdvanceRequest; readonly _queueComplete?: never }
export type Outcome = { requestId: string; step: Step } | { requestId: string; error: string };

/** An attached client. `lines` keeps the last progress lines; `total` counts every line ever logged. */
interface Session { cwd: string; env: Record<string, string | undefined>; lines: string[]; total: number; controller: AbortController | null }

/** Attached clients by run ID, in this process only. */
const sessions = new Map<string, Session>();
const KEEP_LINES = 500;

function logTo(session: Session) {
  return (line: string) => {
    session.lines.push(line);
    session.total++;
    if (session.lines.length > KEEP_LINES) session.lines.splice(0, session.lines.length - KEEP_LINES);
  };
}

async function advanceAttached(runId: string, answers: Answers): Promise<Step | { error: string }> {
  const session = sessions.get(runId);
  if (!session) {
    const state = new State();
    try {
      if (state.getRun(runId)?.status === "running") state.markInterrupted(runId, "The OpenMerit daemon restarted during this step; completed work and spend are kept.");
    } finally { state.close(); }
    return { error: `The OpenMerit daemon restarted while this run was working. Continue it with \`openmerit scout --resume ${runId}\`.` };
  }
  const controller = new AbortController();
  session.controller = controller;
  const ctx = localContext({ cwd: session.cwd, env: session.env, log: logTo(session), signal: controller.signal });
  try { return await advance(ctx, runId, answers); }
  catch (error) { return { error: redact(error instanceof Error ? error.message : String(error)) }; }
  finally { session.controller = null; ctx.state.close(); }
}

export const scoutRun = workflow({
  state: { inFlight: null as string | null, outcome: null as Outcome | null },
  // Rivet deprecated actor queues in 3.0, and `ctx.queue.next` with them, but they keep working until
  // Rivet ships its replacement for sending messages to a running workflow. Move to it then.
  queues: { advance: queue<AdvanceRequest>() as AdvanceQueue },
  run: async ctx => {
    const runId = ctx.key[0]!;
    await ctx.loop("requests", async loop => {
      const message = await loop.queue.next("next", { names: ["advance"] });
      const { requestId, answers } = message.body;
      await loop.step("accept", async s => { s.state.inFlight = requestId; });
      // No timeout and no retries: the step can run evals for an hour, and a retry would pay again.
      await loop.step({
        name: "advance", timeout: 0, maxRetries: 0,
        run: async s => {
          const result = await advanceAttached(runId, answers);
          // A failed run is a Step too, with its own `error`: only a step that threw has no runId.
          s.state.outcome = "runId" in result ? { requestId, step: result } : { requestId, error: result.error };
          s.state.inFlight = null;
        },
      });
    });
  },
  actions: {
    /** Attaches the calling client: its working directory and environment, held in memory only. */
    attach: (c, input: { cwd: string; env: Record<string, string | undefined> }) => {
      const runId = c.key[0]!;
      const previous = sessions.get(runId);
      if (previous) Object.assign(previous, { cwd: input.cwd, env: input.env });
      else sessions.set(runId, { cwd: input.cwd, env: input.env, lines: [], total: 0, controller: null });
      return { inFlight: c.state.inFlight, since: sessions.get(runId)!.total };
    },
    /** The outcome of a request once it has one, and the progress lines logged after line `since`. */
    poll: (c, input: { requestId: string; since: number }) => {
      const session = sessions.get(c.key[0]!);
      const lines = session ? session.lines.slice(Math.max(0, input.since - (session.total - session.lines.length))) : [];
      const outcome = c.state.outcome?.requestId === input.requestId ? c.state.outcome : null;
      return { outcome, lines, next: session?.total ?? 0, inFlight: c.state.inFlight };
    },
    /** Stops the step in progress, as Ctrl-C did before the daemon: the run is saved as interrupted. */
    stop: c => { sessions.get(c.key[0]!)?.controller?.abort(); },
  },
});

/** The daemon's registry: a local engine on 127.0.0.1:`port` (peers on port+1, metrics on port+10) behind `token`. */
export function createRegistry(options: { port: number; token: string }) {
  return setup({ use: { scoutRun }, startEngine: true, startServices: false, enginePort: options.port, token: options.token });
}
export type Registry = ReturnType<typeof createRegistry>;
