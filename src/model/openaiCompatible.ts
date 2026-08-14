/**
 * OpenAI-compatible chat-completions provider (works with vLLM, llama.cpp
 * server, Ollama's /v1, OpenAI itself, etc.). The `local` provider is this
 * same class pointed at the in-image llama.cpp server.
 */
import { config } from "../config.js";
import { ChatMessage, ChatResponse, ModelProvider, ToolCall, ToolDef } from "./provider.js";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly modelName: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(name: "openai-compatible" | "local", baseUrl: string, apiKey: string, modelName: string) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  async status(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false, detail: `endpoint error: HTTP ${res.status}` };
      // Distinguish "endpoint reachable" from "the requested model is actually
      // available" (e.g. Ollama running but qwen3-coder:30b not pulled yet).
      try {
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? []).map((m) => String(m.id ?? ""));
        if (ids.length && !ids.some((id) => id === this.modelName || id.startsWith(`${this.modelName}:`))) {
          return {
            ok: false,
            detail: `model "${this.modelName}" not found on endpoint (available: ${ids.slice(0, 5).join(", ")})`,
          };
        }
      } catch {
        // Endpoint reachable but non-standard /models payload — treat as ready.
      }
      return { ok: true, detail: "ready" };
    } catch (err) {
      return { ok: false, detail: `unreachable: ${String((err as Error).message)}` };
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse> {
    const body = {
      model: this.modelName,
      max_tokens: config.modelMaxTokens,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      })),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`Model API error HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as any;
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
      id: c.id ?? `call_${Math.random().toString(36).slice(2)}`,
      name: c.function?.name ?? "",
      arguments: safeParse(c.function?.arguments),
    }));
    return { content: msg.content ?? "", toolCalls };
  }
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
