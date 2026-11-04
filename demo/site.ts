// The site Worker serves only the memo; its retained asset bundle supplies memo styles.
// The domain router redirects legacy hosts before requests reach this Worker.
import { handleMemoRequest } from './memo/worker.ts';
import type { MemoEnv } from './memo/auth.ts';

export default {
  async fetch(request: Request, env: MemoEnv): Promise<Response> {
    return await handleMemoRequest(request, env) ?? env.ASSETS.fetch(request);
  },
};
