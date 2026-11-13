import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
import { listLlmModels } from '@/lib/api';
import { providerModelIds } from '@/lib/providerModels';
import { useTranslation } from 'react-i18next';

interface Provider {
  id: string; name: string; kind: string; base_url: string; chat_path: string; api_key: string;
  model: string; models?: string[]; mode: 'completions' | 'responses'; use_proxy?: boolean;
}
export default function ModelDiscovery({ provider, onChange }: { provider: Provider; onChange: (patch: { model: string; models: string[] }) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useWorkspaceState("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:busy", false);
  const [message, setMessage] = useWorkspaceState("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:message", '');
  const [models, setModels] = useWorkspaceState<string[]>("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:models", []);
  const [selected, setSelected] = useWorkspaceState<Set<string>>("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:selected", new Set());
  const [filter, setFilter] = useWorkspaceState("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:filter", '');
  const [open, setOpen] = useWorkspaceState("src/features/settings/ModelDiscovery.tsx:ModelDiscovery:open", false);
  const generation = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // A response for old credentials must never alter the newly edited profile.
  useWorkspaceInitEffect('src/features/settings/ModelDiscovery.tsx:', () => {
    generation.current += 1; setBusy(false); setOpen(false); setMessage('');
    return () => { generation.current += 1; };
  }, [provider.id, provider.base_url, provider.api_key, provider.chat_path, provider.mode, provider.use_proxy]);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  async function fetchModels() {
    const request = ++generation.current;
    setBusy(true); setMessage('');
    try {
      const found = await listLlmModels(JSON.stringify({ type: 'llm', providers: [provider], active_id: provider.id }));
      if (request !== generation.current) return;
      const ids = providerModelIds('', found);
      if (!ids.length) { setMessage(t('translate.discoveryEmpty')); return; }
      setModels(ids); setSelected(new Set()); setFilter(''); setOpen(true);
    } catch {
      if (request === generation.current) setMessage(t('translate.discoveryFailed'));
    } finally { if (request === generation.current) setBusy(false); }
  }
  const visible = models.filter(id => id.toLowerCase().includes(filter.toLowerCase()));
  const small: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text-primary)', borderRadius: 6, padding: '6px 9px', fontSize: 12, cursor: 'pointer' };
  return <>
    <button ref={button} type="button" style={small} disabled={busy || !provider.base_url.trim()} onClick={() => void fetchModels()}><Download size={13} />{t(busy ? 'translate.discoveringModels' : 'translate.discoverModels')}</button>
    {message && <p role="status" style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '6px 0' }}>{message}</p>}
    {open && <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.25)', display: 'grid', placeItems: 'center', padding: 24 }} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="model-discovery-title" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }} style={{ width: 'min(500px, 100%)', maxHeight: '75vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 18, gap: 12, boxShadow: '0 10px 36px #0002' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><strong id="model-discovery-title" style={{ fontSize: 14 }}>{t('translate.chooseDiscoveredModels')}</strong><button type="button" aria-label={t('common.close')} style={small} onClick={close}><X size={14} /></button></div>
        <input ref={search} aria-label={t('translate.filterModels')} placeholder={t('translate.filterModels')} value={filter} onChange={event => setFilter(event.target.value)} style={{ ...small, cursor: 'text' }} />
        <div style={{ display: 'flex', gap: 8 }}><button type="button" style={small} onClick={() => setSelected(new Set(models))}>{t('common.selectAll')}</button><button type="button" style={small} onClick={() => setSelected(new Set())}>{t('translate.clearModelSelection')}</button></div>
        <div style={{ overflowY: 'auto', minHeight: 60 }}>
          {visible.map(id => <label key={id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 2px', fontSize: 13, overflowWrap: 'anywhere' }}><input type="checkbox" checked={selected.has(id)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />{id}</label>)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" style={small} onClick={close}>{t('common.cancel')}</button><button type="button" disabled={!selected.size} style={{ ...small, color: 'var(--color-accent)' }} onClick={() => {
          const ids = providerModelIds(provider.model, [...providerModelIds(provider.model, provider.models), ...selected]);
          onChange({ model: provider.model || [...selected][0], models: ids }); close();
        }}>{t('translate.addSelectedModels', { count: selected.size })}</button></div>
      </div>
    </div>}
  </>;
}
