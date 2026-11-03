import type { HarnessDescriptor } from '../../packages/protocol/src/index.ts';
import { OPENMERIT_SCHEMA_DIALECT, PROTOCOL_VERSION } from '../../dist/protocol/src/index.js';

// Capabilities of the prepared demo operations, not the public Scout extension.
export const DEMO_HARNESS_DESCRIPTOR: HarnessDescriptor = {
  id: 'pi', name: 'Prepared OpenMerit demo on Pi', version: '1.5.0',
  protocolVersions: [PROTOCOL_VERSION],
  capabilities: [
    'user_confirmation', 'evaluation_authoring', 'observability_instrumentation',
    'production_observation', 'candidate_discovery', 'challenger_execution',
    'frontier_calculation', 'model_mutation', 'post_swap_verification', 'rollback',
  ],
  executionModes: ['interactive', 'non_interactive'],
  structuredOutput: {
    schemaDialect: OPENMERIT_SCHEMA_DIALECT, presentation: 'dynamic_tool', enforcement: 'harness',
  },
  automation: {
    supportedSignals: ['metric_window_available', 'verification_window_completed'],
    persistentScheduling: false, backgroundExecution: false, wakeupProvisioning: 'none',
  },
};
