import { Type } from 'typebox';
import { work } from './work.mjs';

export default function(pi) {
  pi.registerTool({
    name: 'demo_work', label: 'Run prepared demo operation',
    description: 'Execute the prepared application, evaluator, or configuration operation for the active OpenMerit intent. Returns real measured evidence and the exact outputs to report. It does not complete the intent: call openmerit_complete_intent yourself. For baseline or verification_window, report the returned signal with openmerit_report_signal instead.',
    parameters: Type.Object({ phase: Type.Union(['setup', 'baseline', 'discover_candidates', 'run_challenger_trials', 'calculate_frontier', 'apply_model_swap', 'verification_window', 'verify_model_swap', 'rollback_model_swap'].map(x => Type.Literal(x))) }),
    async execute(_id, args) {
      const result = await work(args.phase);
      return { content: [{ type: 'text', text: JSON.stringify({ artifact: args.phase,
        nextTool: result.signal ? 'openmerit_report_signal' : 'openmerit_complete_intent',
        message: 'Measured operation complete. Submit this saved artifact by name. Its exact numeric evidence will be loaded by the demo bridge and validated by OpenMerit.' }) }], details: { phase: args.phase } };
    },
  });
}
