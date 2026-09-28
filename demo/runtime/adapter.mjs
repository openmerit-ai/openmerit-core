import installOpenMerit from '../../dist/pi/src/index.js';
import { Type } from 'typebox';
import { json, work } from './work.mjs';

// Demo transport only: expand prepared artifact references into the canonical
// result before invoking the unchanged Pi adapter. This avoids asking the model
// to transcribe long numeric arrays. Core schema and frontier checks still run.
export default function(pi) {
  installOpenMerit({ ...pi, registerTool(tool) {
    if (tool.name === 'openmerit_complete_intent') {
      pi.registerTool({ ...tool,
        description: 'Complete the active OpenMerit intent using the exact saved artifact from demo_work. The demo bridge loads its measured outputs and evidence into the canonical OpenMerit result. Supply the active intent ID and the phase artifact name. Never invent evidence.',
        parameters: Type.Object({ intentId: Type.String(), artifact: Type.String(), summary: Type.String() }),
        async execute(id, input, signal, update, ctx) {
          const state = await json('.openmerit/state.json');
          if (state?.activeIntent?.id !== input.intentId) throw new Error('This intent is no longer active.');
          const expected = state.activeIntent.kind === 'establish_evals' ? 'setup' : state.activeIntent.kind;
          if (input.artifact !== expected) throw new Error('Artifact does not belong to this intent.');
          const result = await work(expected);
          if (!result?.outputs || !result.evidence?.length) throw new Error('The measured artifact is not ready.');
          return tool.execute(id, { intentId: input.intentId, status: 'succeeded', summary: input.summary,
            outputs: result.outputs, evidence: result.evidence }, signal, update, ctx);
        },
      });
    } else if (tool.name === 'openmerit_report_signal') {
      pi.registerTool({ ...tool, description: 'Report the exact measured baseline or verification window produced by demo_work. The demo bridge loads the saved signal and passes it to OpenMerit.',
        parameters: Type.Object({ artifact: Type.Union([Type.Literal('baseline'), Type.Literal('verification_window')]) }),
        async execute(id, input, signal, update, ctx) {
          const result = await work(input.artifact);
          if (!result?.signal) throw new Error('The measurement window is not ready.');
          return tool.execute(id, result.signal, signal, update, ctx);
        },
      });
    } else pi.registerTool(tool);
  } });
}
