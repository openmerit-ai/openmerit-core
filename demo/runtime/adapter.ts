import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { OpenMeritCoordinator, ProjectStore, nextImprovementAction, type OrchestrationDecision } from '../../dist/core/src/index.js';
import { PROTOCOL_VERSION } from '../../dist/protocol/src/index.js';
import type { AnyIntentResult, AutomationSignal } from '../../packages/protocol/src/index.ts';
import { DEMO_HARNESS_DESCRIPTOR } from './descriptor.ts';
import { json, work } from './work.mjs';

// Demo-owned transport. Only prepared operations and their saved evidence are
// accepted; the public Pi extension remains Scout-only.
export default function installDemo(pi: ExtensionAPI) {
  function coordinator(cwd: string) {
    return new OpenMeritCoordinator(new ProjectStore(cwd), {
      descriptor: DEMO_HARNESS_DESCRIPTOR,
      async dispatch(intent) {
        pi.sendMessage({
          customType: 'openmerit.demo-intent', display: false,
          content: `Prepared demo intent: ${JSON.stringify(intent)}. Use demo_work then openmerit_complete_intent with this intentId and the phase artifact. For establish_evals the phase is setup.`,
        }, { deliverAs: 'followUp', triggerTurn: true });
        return { accepted: true, harnessJobId: intent.id };
      },
    });
  }
  async function advance(core: OpenMeritCoordinator, decision: OrchestrationDecision) {
    if (decision.action === 'issue_intent') await core.issue(decision.intentKind);
  }
  const response = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {},
  });

  pi.registerCommand('openmerit', {
    description: 'Prepared demo only: setup, assess, approve',
    async handler(args, ctx) {
      const store = new ProjectStore(ctx.cwd);
      const core = coordinator(ctx.cwd);
      const state = await store.readState();
      if (state?.activeIntent) throw new Error('Complete the active demo intent first.');
      switch (args.trim()) {
        case 'setup': {
          const authorization = await json('authorization.json');
          if (!authorization?.confirmedAt) throw new Error('The visitor must confirm the demo policy first.');
          if (state && state.cycle.stage !== 'unconfigured') throw new Error('Demo setup has already started.');
          await core.issue('establish_evals');
          return;
        }
        case 'assess': {
          const result = await core.assessBaseline();
          if (result.errors.length) throw new Error(result.errors.join('; '));
          await advance(core, result.decision);
          return;
        }
        case 'approve': {
          const approval = await json('approval.json');
          if (!state?.cycle.proposedCandidateId || state.cycle.stage !== 'frontier_ready' ||
              approval?.candidateId !== state.cycle.proposedCandidateId) {
            throw new Error('The visitor must approve this exact proposal in the browser first.');
          }
          const now = new Date().toISOString();
          await store.writeState({ ...state, cycle: { ...state.cycle, stage: 'swap_approved' }, updatedAt: now });
          await store.appendEvent({
            schemaVersion: 1, id: `event-${crypto.randomUUID()}`, type: 'cycle_advanced',
            occurredAt: now, cycleId: state.cycle.id,
            data: { stage: 'swap_approved', candidateId: state.cycle.proposedCandidateId },
          });
          await core.issue('apply_model_swap');
          return;
        }
        default: throw new Error('Prepared demo commands: /openmerit setup, assess, approve.');
      }
    },
  });

  pi.registerTool({
    name: 'openmerit_complete_intent', label: 'Complete prepared demo intent',
    description: 'Complete the active intent with its exact demo_work phase artifact and a truthful summary. For failed work, set status to failed and explain the actual error; do not invent evidence.',
    parameters: Type.Object({
      intentId: Type.String(), artifact: Type.Optional(Type.String()), summary: Type.String(),
      status: Type.Optional(Type.Union([Type.Literal('succeeded'), Type.Literal('failed')])),
    }),
    async execute(_id, input, _signal, _update, ctx) {
      const state = await new ProjectStore(ctx.cwd).readState();
      if (state?.activeIntent?.id !== input.intentId) throw new Error('This intent is no longer active.');
      const core = coordinator(ctx.cwd);
      const expected = state.activeIntent.kind === 'establish_evals' ? 'setup' : state.activeIntent.kind;
      let result: AnyIntentResult;
      const envelope = {
        protocolVersion: PROTOCOL_VERSION, intentId: input.intentId,
        completedAt: new Date().toISOString(), summary: input.summary,
      };
      if (input.status === 'failed') {
        result = { ...envelope, status: 'failed', evidence: [],
          error: { code: 'demo_operation_failed', message: input.summary, retryable: false } };
      } else {
        if (input.artifact !== expected) throw new Error('Artifact does not belong to this intent.');
        const artifact = await work(expected);
        if (!artifact?.outputs || !artifact.evidence?.length) throw new Error('The measured artifact is not ready.');
        // The JS evidence producer is a trust boundary; core validates the full
        // kind-specific schema, target, budget, and frontier before accepting it.
        result = { ...envelope, status: 'succeeded', outputs: artifact.outputs, evidence: artifact.evidence } as AnyIntentResult;
      }
      const accepted = await core.acceptResult(result);
      if (result.status === 'succeeded') await advance(core, nextImprovementAction(accepted.state.cycle));
      return response({ stage: accepted.state.cycle.stage });
    },
  });
  pi.registerTool({
    name: 'openmerit_report_signal', label: 'Report prepared demo measurement',
    description: 'Report the exact baseline or verification_window artifact from demo_work. Only measured application evidence is reported.',
    parameters: Type.Object({ artifact: Type.Union([Type.Literal('baseline'), Type.Literal('verification_window')]) }),
    async execute(_id, input, _signal, _update, ctx) {
      const artifact = await work(input.artifact);
      if (!artifact?.signal) throw new Error('The measurement window is not ready.');
      const { signalId, ...fields } = artifact.signal;
      const signal = { ...fields, protocolVersion: PROTOCOL_VERSION, id: signalId, occurredAt: new Date().toISOString() } as AutomationSignal;
      const core = coordinator(ctx.cwd);
      const result = await core.recordAutomationSignal(signal);
      await advance(core, result.decision);
      return response({ stage: result.state.cycle.stage, duplicate: result.duplicate });
    },
  });
}
