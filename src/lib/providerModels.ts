/** Saved choices share one provider's credentials; `model` remains the active ID. */
export function providerModelIds(model: string, saved?: unknown): string[] {
  const values = Array.isArray(saved) ? saved : [];
  return [...new Set([...values, model].filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(Boolean))];
}
