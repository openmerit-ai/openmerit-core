import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, chatWithImages } from "../src/llm.js";

const previous = {
  direct: process.env.OPENMERIT_DIRECT_PROVIDER,
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  restore("OPENMERIT_DIRECT_PROVIDER", previous.direct);
  restore("OPENAI_API_KEY", previous.openai);
  restore("GEMINI_API_KEY", previous.gemini);
  vi.unstubAllGlobals();
});

describe("judge and strategist provider routing", () => {
  it("keeps vendor/model IDs on OpenRouter without explicit opt-in", async () => {
    delete process.env.OPENMERIT_DIRECT_PROVIDER;
    process.env.OPENAI_API_KEY = "unused-direct-key";
    const fetchMock = vi.fn().mockResolvedValue(response({
      choices: [{ message: { content: "openrouter answer" } }],
      usage: { total_tokens: 12 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat("openrouter-key", "openai/gpt-4o-mini", "prompt", 100, 0.2);

    expect(result.content).toBe("openrouter answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer openrouter-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "openai/gpt-4o-mini" });
  });

  it("routes OpenAI requests directly only after explicit opt-in", async () => {
    process.env.OPENMERIT_DIRECT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "direct-openai-key";
    const fetchMock = vi.fn().mockResolvedValue(response({
      choices: [{ message: { content: "direct answer" } }],
      usage: { total_tokens: 9 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chat("openrouter-key", "openai/gpt-4.1-mini", "prompt", 80, 0);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer direct-openai-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-4.1-mini" });
  });

  it("maps Gemini image requests to generateContent after explicit opt-in", async () => {
    process.env.OPENMERIT_DIRECT_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "direct-gemini-key";
    const fetchMock = vi.fn().mockResolvedValue(response({
      candidates: [{ content: { parts: [{ text: "gemini answer" }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithImages("openrouter-key", "google/gemini-2.5-flash", "inspect", [{
      type: "image", mimeType: "image/png", data: "aW1hZ2U=",
    }], 120);

    expect(result).toMatchObject({ content: "gemini answer", usage: { total_tokens: 7 } });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=direct-gemini-key",
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.contents[0].parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: "aW1hZ2U=" },
    });
  });
});
