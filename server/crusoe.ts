/**
 * Crusoe Inference — OpenAI-compatible chat completions.
 * Never log the API key.
 */

const DEFAULT_MODEL = "deepseek-ai/Deepseek-V4-Flash";
const DEFAULT_BASE = "https://api.inference.crusoecloud.com/v1";
const TIMEOUT_MS = 18_000;

function getApiKey(): string | undefined {
  const k = process.env.CRUSOE_API_KEY?.trim();
  return k || undefined;
}

export function getCrusoeBaseUrl(): string {
  return (
    process.env.CRUSOE_BASE_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE
  );
}

export function getCrusoeModel(): string {
  return process.env.CRUSOE_MODEL?.trim() || DEFAULT_MODEL;
}

export function isCrusoeReady(): boolean {
  return Boolean(getApiKey());
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatCompletionResult = {
  text: string;
  model: string;
  backend: "crusoe";
};

export async function crusoeChatCompletion(opts: {
  model?: string;
  system?: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  const key = getApiKey();
  if (!key) throw new Error("Crusoe not configured");

  const model = opts.model?.trim() || getCrusoeModel();
  const messages: ChatMessage[] = [];
  if (opts.system?.trim()) {
    messages.push({ role: "system", content: opts.system.trim() });
  }
  messages.push({ role: "user", content: opts.user });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? TIMEOUT_MS
  );

  try {
    const res = await fetch(`${getCrusoeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.max_tokens ?? 280,
        messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const brief = errText.slice(0, 180).replace(/\s+/g, " ");
      throw new Error(`Crusoe HTTP ${res.status}${brief ? `: ${brief}` : ""}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
        };
      }>;
      model?: string;
    };
    const msg = data.choices?.[0]?.message ?? {};
    const text = (
      msg.content?.trim() ||
      msg.reasoning_content?.trim() ||
      msg.reasoning?.trim() ||
      ""
    );
    if (!text) throw new Error("Crusoe returned empty response");
    return { text, model: data.model || model, backend: "crusoe" };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Crusoe request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
