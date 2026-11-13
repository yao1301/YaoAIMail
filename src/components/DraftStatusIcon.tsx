import { FilePenLine } from 'lucide-react';

/** Passive status marker, not another toolbar action. */
export default function DraftStatusIcon({ size = 14, label = '草稿，未发送', title = '草稿（未发送）' }: { size?: number; label?: string; title?: string }) {
  return <span role="img" aria-label={label} title={title} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 0, color: 'var(--color-text-secondary)' }}><FilePenLine size={size} aria-hidden="true" /></span>;
}
