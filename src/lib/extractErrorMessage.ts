/** Extract a human-readable error message from an unknown catch value. */
export function extractErrorMessage(err: unknown): string {
  const visited = new WeakSet<object>();

  function read(value: unknown): string | null {
    if (typeof value === "string") return value.trim() || null;
    if (value instanceof Error) return read(value.message);
    if (!value || typeof value !== "object") return null;
    if (visited.has(value)) return null;
    visited.add(value);

    const record = value as Record<string, unknown>;
    // Tauri errors and many OpenAI-compatible gateways nest useful details as
    // `{ kind, message: { error: { message }}}`. Never stringify that object
    // directly, or users only see `[object Object]`.
    for (const key of ["message", "error", "detail", "description", "reason", "data"]) {
      const message = read(record[key]);
      if (message) return message;
    }

    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== "{}" ? serialized : null;
    } catch {
      return null;
    }
  }

  return read(err) || "Unknown error";
}
