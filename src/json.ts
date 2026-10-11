/**
 * Parses a model reply that should be a single JSON value, tolerating the
 * common ```json fenced wrapper. Throws (SyntaxError) when it is not JSON.
 */
export function parseJsonResult(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
