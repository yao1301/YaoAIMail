import { checkSendGuard, getMessage, getSendGuardConfig, listAccounts, listAttachments, getAttachmentPath, sendSavedDraft, type Message } from '@/lib/api';

type Confirm = (options: { title: string; message: string; confirmLabel: string; destructive?: boolean }) => Promise<boolean>;
export type DraftSendResult = { queuedIds: string[]; failed: { id: string; subject: string; error: string }[] };
const active = new Set<string>();

/** All UI entry points share this preparation and lock; no network send before confirmation. */
export async function sendDraftSelection(ids: string[], confirm: Confirm): Promise<DraftSendResult | null> {
  const selected = [...new Set(ids)];
  if (!selected.length) return null;
  if (selected.some(id => active.has(id))) throw new Error('选中的草稿正在处理，请勿重复发送。');
  selected.forEach(id => active.add(id));
  try {
    const drafts: Message[] = [];
    const details: string[] = []; const warnings: string[] = [];
    const config = await getSendGuardConfig();
    const accounts = await listAccounts();
    for (const id of selected) {
      const draft = await getMessage(id);
      if (!draft || !draft.is_draft || draft.is_deleted) throw new Error('选中内容包含已发送、已入队、已删除或不存在的邮件，请重新选择草稿。');
      if (draft.remote_version === 'headers-only') throw new Error(`“${draft.subject}”正文尚未下载，请先打开草稿。`);
      if (!draft.to_list.length || [...draft.to_list,...draft.cc_list,...draft.bcc_list].some(item => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(item.address)) || /[\r\n\0]/.test(draft.subject)) throw new Error(`“${draft.subject || '无主题草稿'}”收件邮箱未填写、无效或主题包含换行，请先编辑。`);
      if (!draft.body_text.trim() && !draft.body_html_raw.trim()) throw new Error(`“${draft.subject || '无主题草稿'}”正文为空，请先编辑。`);
      const files = await listAttachments(id);
      if (draft.has_attachments && !files.length) throw new Error(`“${draft.subject}”附件尚未准备完整，请先打开核对。`);
      for (const file of files) {
        if (!file.local_path) throw new Error(`“${draft.subject}”有附件未下载，请先打开核对。`);
        if (!await getAttachmentPath(file.id)) throw new Error(`“${draft.subject}”的附件不可用，请先打开核对。`);
      }
      if (config.enabled) {
        const guard = await checkSendGuard({ accountId: draft.account_id, to: draft.to_list.map(item => item.address), cc: draft.cc_list.map(item => item.address), bcc: draft.bcc_list.map(item => item.address), subject: draft.subject, bodyText: draft.body_text });
        if (guard.level === 'block') throw new Error(`“${draft.subject}”未通过发送检查，请打开草稿处理：${guard.reasons.join('；')}`);
        if (guard.level === 'warn') warnings.push(`${draft.subject}：${guard.reasons.join('；')}`);
      }
      if (!draft.subject.trim()) warnings.push('有草稿未填写主题');
      const sender=accounts.find(account=>account.id===draft.account_id);
      if (!sender) throw new Error('草稿的发件账户已不存在，请重新选择。');
      details.push(`• ${draft.subject || '（无主题）'}\n  发件：${sender.email}\n  收件：${draft.to_list.map(item => item.address).join(', ')}${draft.cc_list.length ? `；抄送 ${draft.cc_list.map(item => item.address).join(', ')}` : ''}${draft.bcc_list.length ? `；密送 ${draft.bcc_list.map(item => item.address).join(', ')}` : ''}（${files.length} 个附件）`);
      drafts.push(draft);
    }
    if (!await confirm({ title: `发送 ${drafts.length} 封草稿`, message: `确认发送以下草稿？\n\n${details.join('\n')}\n\n${warnings.length ? `请特别核对：\n${warnings.join('\n')}\n\n` : ''}确认后进入发送队列。实际发送结果请查看发件箱或已发送；失败会暂停，不会自动重复发送。`, confirmLabel: '确认发送', destructive: true })) return null;
    const result: DraftSendResult = { queuedIds: [], failed: [] };
    for (const draft of drafts) {
      try { await sendSavedDraft(draft.account_id, draft.id, draft.updated_at); result.queuedIds.push(draft.id); }
      catch (cause) { result.failed.push({ id: draft.id, subject: draft.subject, error: cause instanceof Error ? cause.message : String(cause) }); }
    }
    return result;
  } finally { selected.forEach(id => active.delete(id)); }
}
