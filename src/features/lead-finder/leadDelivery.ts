export const LEAD_PAGE_SIZE = 20;

export function leadFillStatus(count: number, busy: boolean, reason?: string): string {
  const onPage=count === 0 ? 0 : count % LEAD_PAGE_SIZE || LEAD_PAGE_SIZE;
  if (busy) return onPage===LEAD_PAGE_SIZE ? '正在核验并整理本页客户…' : `本页已找到 ${onPage}/${LEAD_PAGE_SIZE} 家，正在继续补充…`;
  if (onPage===LEAD_PAGE_SIZE) return `本页已找到 ${LEAD_PAGE_SIZE} 家`;
  const why:Record<string,string>={time_limit:'本轮搜索时间已到，可继续补充',no_progress:'连续多轮没有新增匹配公司',source_exhausted:'本轮可用检索路线已完成',service_error:'服务异常，搜索未完成'};
  return `本页已找到 ${onPage}/${LEAD_PAGE_SIZE} 家，尚未满页${reason && why[reason] ? `；${why[reason]}` : '，可继续补充'}`;
}

export function leadPageDeficit(count: number): number {
  return LEAD_PAGE_SIZE-(Math.max(0,count)%LEAD_PAGE_SIZE);
}

export function leadPage<T>(items: T[], requested: number) {
  const pages = Math.max(1, Math.ceil(items.length / LEAD_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(requested) || 1));
  return { page, pages, total: items.length, items: items.slice((page - 1) * LEAD_PAGE_SIZE, page * LEAD_PAGE_SIZE) };
}

type ContextSnapshot = { contextText?: string; contextFiles?: string[]; contextKnowledgeIds?: string[]; contextFilesNote?: string };
/** Continuations reuse the immutable task snapshot, never reread live mail/files. */
export async function leadTaskContext(page: number, session: ContextSnapshot, read: () => Promise<Required<ContextSnapshot>>): Promise<Required<ContextSnapshot>> {
  if (page > 1 && session.contextText !== undefined) return {
    contextText: session.contextText, contextFiles: session.contextFiles || [],
    contextKnowledgeIds: session.contextKnowledgeIds || [], contextFilesNote: session.contextFilesNote || '',
  };
  return read();
}
