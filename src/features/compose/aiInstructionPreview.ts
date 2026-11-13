export function aiInstructionPreview(instruction: string): string {
  const compact = instruction.replace(/\s+/g, ' ').trim();
  return compact.length > 64 ? `${compact.slice(0, 64)}…` : compact;
}
