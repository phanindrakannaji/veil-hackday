/**
 * OpenRouter — lean “Explain this decision” for judges / organizers.
 * Never log the API key.
 */

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT =
  "You explain Veil camera consent decisions for event organizers/judges. " +
  "Be concise (2–4 sentences). Plain language. Pass = credential; MediaPipe only finds faces; " +
  "identity is Pass bind; blur is policy not product. Mention Neo4j rights graph when relevant. " +
  "No jargon dump.";

function getApiKey(): string | undefined {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  return k || undefined;
}

export function getOpenRouterModel(): string {
  return (process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL);
}

export function isOpenRouterReady(): boolean {
  return Boolean(getApiKey());
}

function truncateJson(value: unknown, maxChars = 3500): string {
  try {
    const s = JSON.stringify(value, null, 0);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + "…[truncated]";
  } catch {
    return String(value).slice(0, maxChars);
  }
}

export type ExplainInput = {
  receipts?: unknown[];
  clip?: unknown;
  edges?: unknown[];
  question?: string;
};

export async function explainDecision(
  input: ExplainInput
): Promise<{ text: string; model: string }> {
  const key = getApiKey();
  if (!key) {
    throw new Error("OpenRouter not configured");
  }

  const model = getOpenRouterModel();
  const receipts = Array.isArray(input.receipts) ? input.receipts.slice(-8) : [];
  const edges = Array.isArray(input.edges) ? input.edges.slice(-12) : [];

  const userPayload = {
    question:
      input.question?.trim() ||
      "Explain the latest capture / export decision in plain language for a hackathon judge.",
    clip: input.clip ?? null,
    recent_receipts: receipts,
    rights_graph_edges: edges,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        temperature: 0.4,
        max_tokens: 280,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "Context (JSON summary — use only what helps; ignore noise):\n" +
              truncateJson(userPayload),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const brief = errText.slice(0, 180).replace(/\s+/g, " ");
      throw new Error(`OpenRouter HTTP ${res.status}${brief ? `: ${brief}` : ""}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    if (!text) throw new Error("OpenRouter returned empty explanation");
    return { text, model: data.model || model };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("OpenRouter request timed out (~20s)");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
