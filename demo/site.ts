// The site Worker serves only the memo; its retained asset bundle supplies memo styles.
import { handleMemoRequest } from './memo/worker.ts';
import type { MemoEnv } from './memo/auth.ts';
import { withPrimaryDomain } from './domain-migration.mjs';

interface SiteEnv extends MemoEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default withPrimaryDomain({
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    return await handleMemoRequest(request, env) ?? env.ASSETS.fetch(request);
  },
});
