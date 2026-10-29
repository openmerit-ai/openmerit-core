// Preserve the existing demo exports/bindings; restore memo auth ahead of assets.
import demo from './worker.mjs';
import { handleMemoRequest } from './memo/worker.ts';
import type { MemoEnv } from './memo/auth.ts';
import { withPrimaryDomain } from './domain-migration.mjs';
export { DemoContainer, DemoGate } from './worker.mjs';

export default withPrimaryDomain({
  async fetch(request: Request, env: MemoEnv): Promise<Response> {
    return await handleMemoRequest(request, env) ?? demo.fetch(request, env);
  },
});
