const prefix = 'src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:';
export const leadSessionStateKey = `${prefix}activeSessionId`;
export function wrapLeadState(key: string, value: unknown, state: Record<string, unknown>) {
  return key === `${prefix}results` || key === `${prefix}searchSessions` ? { value, sessionId: state[leadSessionStateKey] } : value;
}
type Row = Record<string, unknown>;
function mergeRows(current: unknown, incoming: unknown) {
  if (!Array.isArray(current) || !Array.isArray(incoming)) return incoming;
  const identity = (row: Row) => String(row.id ?? row.website ?? row.companyName ?? '');
  const rows = new Map(current.map((row: Row) => [identity(row), row]));
  for (const row of incoming as Row[]) rows.set(identity(row), { ...rows.get(identity(row)), ...row });
  return [...rows.values()];
}
/** Late contact discovery belongs to its original search session. It must not
 * replace a different task/page that the user opened in the receiving window. */
export function receiveLeadState(key: string, incoming: unknown, state: Record<string, unknown>): { apply: boolean; value: unknown } {
  if (key !== `${prefix}results` && key !== `${prefix}searchSessions`) return { apply: true, value: incoming };
  const { value, sessionId } = incoming as { value: unknown; sessionId: unknown };
  if (key === `${prefix}results`) return { apply: state[leadSessionStateKey] === sessionId, value: mergeRows(state[key], value) };
  const current = Array.isArray(state[key]) ? state[key] as Row[] : [];
  const sessions = new Map(current.map(session => [session.id, session]));
  for (const session of value as Row[]) {
    const old = sessions.get(session.id);
    const results = mergeRows(old?.results, session.results);
    sessions.set(session.id, { ...old, ...session, page: Math.max(Number(old?.page ?? 0), Number(session.page ?? 0)), results, resultCount: Array.isArray(results) ? results.length : session.resultCount });
  }
  return { apply: true, value: [...sessions.values()] };
}
