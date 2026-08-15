/**
 * Model/protocol error classification. A malformed tool-call response, a
 * provider 5xx, or a transport timeout is NOT a generated-game failure —
 * it must be retried at the provider layer without consuming QA repair or
 * syntax-fix budgets, and must never kill the whole generation on the
 * first occurrence.
 */
export type ModelErrorClass = "retryable" | "fatal";

export function classifyModelError(message: string): ModelErrorClass {
  // Auth/config problems: retrying cannot help.
  if (/HTTP (401|403)\b/.test(message) || /unauthorized|invalid api key|forbidden|authentication/i.test(message)) return "fatal";
  // Throttling / server-side failures (incl. Ollama 500 "XML syntax error"
  // tool-call serialization bugs) are transient.
  if (/HTTP (408|429|5\d\d)\b/.test(message)) return "retryable";
  // Malformed tool-call / serialization output from the model.
  if (/xml syntax error|malformed|unexpected token|parse error|invalid json/i.test(message)) return "retryable";
  // Transport-level flakiness.
  if (/timeout|timed out|aborted|econnreset|econnrefused|epipe|socket|fetch failed|network|terminated/i.test(message)) return "retryable";
  // Remaining well-formed client errors (400, 404, 413...) won't improve.
  if (/HTTP 4\d\d\b/.test(message)) return "fatal";
  // Unknown error shape: prefer retrying over killing a long-running job.
  return "retryable";
}
