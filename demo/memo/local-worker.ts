// Local simulator only. Never imported by the production entry point.
import { handleMemoRequest } from './worker.ts';
import type { MemoEnv } from './auth.ts';

export default {
  async fetch(request: Request, env: MemoEnv & { TEST_MAILBOX: { fetch(url: string, init: RequestInit): Promise<Response> } }) {
    const result = await handleMemoRequest(request, env, { sendCode: async (email, otp) => {
      const response = await env.TEST_MAILBOX.fetch('http://mailbox.local/', { method: 'POST', body: JSON.stringify({ email, otp }) });
      if (!response.ok) throw new Error('Simulated delivery failure.');
    } });
    return result ?? env.ASSETS.fetch(request);
  },
};
