/**
 * OpenRouter — OpenAI-compatible chat completions.
 * Never log the API key.
 */

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 20_000;

function getApiKey(): string | undefined {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  return k || undefined;
}

export function getOpenRouterModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

export function isOpenRouterReady(): boolean {
  return Boolean(getApiKey());
}

/** Comma-separated panel models for multi-model judge. */
export function getOpenRouterPanelModels(): string[] {
  const raw =
    process.env.OPENROUTER_PANEL_MODELS?.trim() ||
    "openai/gpt-4o-mini,qwen/qwen-2.5-7b-instruct,mistralai/mistral-small-3.1-24b-instruct";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export type ChatCompletionResult = {
  text: string;
  model: string;
  backend: "openrouter";
};

export async function openrouterChatCompletion(opts: {
  model?: string;
  system?: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  const key = getApiKey();
  if (!key) throw new Error("OpenRouter not configured");

  const model = opts.model?.trim() || getOpenRouterModel();
  const messages: Array<{ role: string; content: string }> = [];
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
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8787",
        "X-Title": "Veil Hack Day",
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
      throw new Error(
        `OpenRouter HTTP ${res.status}${brief ? `: ${brief}` : ""}`
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    if (!text) throw new Error("OpenRouter returned empty response");
    return { text, model: data.model || model, backend: "openrouter" };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("OpenRouter request timed out (~20s)");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
