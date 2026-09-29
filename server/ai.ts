/**
 * Shared LLM layer — Crusoe primary, OpenRouter fallback.
 * Never log API keys.
 */

import {
  crusoeChatCompletion,
  getCrusoeModel,
  isCrusoeReady,
} from "./crusoe.js";
import {
  openrouterChatCompletion,
  getOpenRouterModel,
  getOpenRouterPanelModels,
  isOpenRouterReady,
} from "./openrouter.js";

export type AiBackend = "crusoe" | "openrouter";

export type ChatCompletionOpts = {
  provider?: AiBackend | "auto";
  model?: string;
  system?: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
};

export type ChatCompletionResponse = {
  text: string;
  model: string;
  backend: AiBackend;
};

function truncateJson(value: unknown, maxChars = 3500): string {
  try {
    const s = JSON.stringify(value, null, 0);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + "…[truncated]";
  } catch {
    return String(value).slice(0, maxChars);
  }
}

/** Explicit provider, or auto = Crusoe then OpenRouter. */
export async function chatCompletion(
  opts: ChatCompletionOpts
): Promise<ChatCompletionResponse> {
  const provider = opts.provider ?? "auto";

  if (provider === "crusoe") {
    if (!isCrusoeReady()) throw new Error("Crusoe not configured");
    return crusoeChatCompletion({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
    });
  }

  if (provider === "openrouter") {
    if (!isOpenRouterReady()) throw new Error("OpenRouter not configured");
    return openrouterChatCompletion({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
    });
  }

  // auto: Crusoe first → OpenRouter fallback
  if (isCrusoeReady()) {
    try {
      return await crusoeChatCompletion({
        model: opts.model,
        system: opts.system,
        user: opts.user,
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
      });
    } catch (err) {
      console.warn(
        "[ai] Crusoe failed, falling back to OpenRouter:",
        (err as Error).message
      );
    }
  }

  if (!isOpenRouterReady()) {
    throw new Error("No AI backend configured (Crusoe / OpenRouter)");
  }

  return openrouterChatCompletion({
    model: opts.model,
    system: opts.system,
    user: opts.user,
    max_tokens: opts.max_tokens,
    temperature: opts.temperature,
  });
}

const EXPLAIN_SYSTEM =
  "You explain Veil camera consent decisions for event organizers/judges. " +
  "Be concise (2–4 sentences). Plain language. Pass = credential; MediaPipe only finds faces; " +
  "identity is Pass bind; blur is policy not product. Mention Neo4j rights graph when relevant. " +
  "No jargon dump.";

export type ExplainInput = {
  receipts?: unknown[];
  clip?: unknown;
  edges?: unknown[];
  question?: string;
};

/** Crusoe first, OpenRouter on failure/timeout. */
export async function explainDecision(
  input: ExplainInput
): Promise<ChatCompletionResponse> {
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

  return chatCompletion({
    provider: "auto",
    system: EXPLAIN_SYSTEM,
    user:
      "Context (JSON summary — use only what helps; ignore noise):\n" +
      truncateJson(userPayload),
    max_tokens: 280,
  });
}

const CONSENT_BRIEF_SYSTEM =
  "You write a 3-sentence organizer brief for a live event console. " +
  "Summarize who has active Passes, public treatments (allow/blur/deny), promo rights, and clip counts. " +
  "Plain language, actionable, no jargon.";

export async function consentBrief(context: unknown): Promise<ChatCompletionResponse> {
  return chatCompletion({
    provider: "auto",
    system: CONSENT_BRIEF_SYSTEM,
    user: "Active consent snapshot (JSON):\n" + truncateJson(context, 4000),
    max_tokens: 220,
  });
}

const REVOKE_IMPACT_SYSTEM =
  "You summarize revoke blast radius for an event organizer. " +
  "2–3 sentences: how many clips are affected, any exports, and what happens if the Pass is revoked. Plain language.";

export async function revokeImpactNarrative(
  graph: unknown
): Promise<ChatCompletionResponse> {
  return chatCompletion({
    provider: "auto",
    system: REVOKE_IMPACT_SYSTEM,
    user: "Revoke impact graph (JSON):\n" + truncateJson(graph, 4000),
    max_tokens: 220,
  });
}

const JUDGE_SYSTEM =
  "You are one model on a Veil judge panel. Give a short take (2–3 sentences) on this consent/export decision. " +
  "Be concrete. Mention Pass, public treatment, or promo if relevant.";

export type JudgeCard = {
  model: string;
  text?: string;
  error?: string;
  backend: "openrouter";
};

/** Parallel OpenRouter multi-model panel. */
export async function runJudgePanel(context: unknown): Promise<{
  cards: JudgeCard[];
  models: string[];
}> {
  if (!isOpenRouterReady()) {
    throw new Error("OpenRouter not configured");
  }
  const models = getOpenRouterPanelModels();
  const user =
    "Decision context (JSON):\n" + truncateJson(context, 3500);

  const cards = await Promise.all(
    models.map(async (model): Promise<JudgeCard> => {
      try {
        const r = await openrouterChatCompletion({
          model,
          system: JUDGE_SYSTEM,
          user,
          max_tokens: 200,
          timeoutMs: 22_000,
        });
        return { model: r.model || model, text: r.text, backend: "openrouter" };
      } catch (err) {
        return {
          model,
          error: (err as Error).message || "failed",
          backend: "openrouter",
        };
      }
    })
  );

  return { cards, models };
}

export function aiStatusPayload(neo4j?: {
  ok: boolean;
  uri?: string;
  backend?: string;
}) {
  return {
    crusoe: isCrusoeReady()
      ? { ok: true as const, model: getCrusoeModel() }
      : { ok: false as const },
    openrouter: isOpenRouterReady()
      ? { ok: true as const, model: getOpenRouterModel() }
      : { ok: false as const },
    ...(neo4j ? { neo4j } : {}),
  };
}
