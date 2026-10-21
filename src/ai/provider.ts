/** Provider-neutral model interface. The chat service never imports an SDK directly. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. It is parsed and validated by the tool, never trusted. */
  arguments: string;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (strict: every property required, optional ones nullable, additionalProperties false). */
  parameters: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage: ModelUsage;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** JSON Schema the final (non tool-call) message must follow. */
  responseSchema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelTurn>;
}

export function estimateCostMicros(
  usage: ModelUsage,
  price: { inputMicrosPerMtok: number; outputMicrosPerMtok: number },
): number {
  return Math.ceil((usage.inputTokens * price.inputMicrosPerMtok + usage.outputTokens * price.outputMicrosPerMtok) / 1_000_000);
}
