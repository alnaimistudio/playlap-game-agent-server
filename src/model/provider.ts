/**
 * ModelProvider — the swappable brain of the agent. The rest of the server
 * never talks to a model runtime directly, so Qwen can be replaced by any
 * OpenAI-compatible model (or a mock) without touching the agent.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface ModelProvider {
  readonly name: string;
  readonly modelName: string;
  /** true when the underlying runtime is reachable/loaded */
  status(): Promise<{ ok: boolean; detail: string }>;
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse>;
}
