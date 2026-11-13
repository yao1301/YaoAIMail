import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ModelDiscovery from '@/features/settings/ModelDiscovery';
import zh from '@/locales/zh.json';
const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/api', () => ({ listLlmModels: h.list }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, params?: { count: number }) => {
  const text = key.split('.').reduce((value: any, part) => value?.[part], zh) ?? key;
  return text.replace('{{count}}', String(params?.count ?? ''));
} }) }));
const provider = { id: 'fixture', name: 'Fixture', kind: 'custom', base_url: 'http://127.0.0.1:4000/v1/chat/completions', api_key: 'fixture-not-real', chat_path: '', model: 'existing', models: ['existing'], mode: 'completions' as const, use_proxy: true };
beforeEach(() => { h.list.mockReset(); }); afterEach(cleanup);
it('fetches using the same URL/key/proxy and adds only user-selected IDs without replacing existing IDs', async () => {
  h.list.mockResolvedValue(['new-one','new-two','existing','new-one']); const change = vi.fn();
  render(<ModelDiscovery provider={provider} onChange={change}/>);
  fireEvent.click(screen.getByRole('button', { name: '自动获取' }));
  await screen.findByRole('dialog'); expect(change).not.toHaveBeenCalled();
  const config = JSON.parse(h.list.mock.calls[0][0]); expect(config.providers[0]).toEqual(provider);
  fireEvent.click(screen.getByRole('checkbox', { name: 'new-two' }));
  fireEvent.click(screen.getByRole('button', { name: '添加所选模型（1）' }));
  expect(change).toHaveBeenCalledExactlyOnceWith({ model: 'existing', models: ['existing','new-two'] });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it.each([[], null])('keeps manual configuration untouched on unavailable lists (%s)', async (response) => {
  if (response === null) h.list.mockRejectedValue(new Error('sensitive server body'));
  else h.list.mockResolvedValue(response);
  const change = vi.fn(); render(<ModelDiscovery provider={provider} onChange={change}/>);
  fireEvent.click(screen.getByRole('button', { name: '自动获取' }));
  expect((await screen.findByRole('status')).textContent).toContain('手动添加多个 ID');
  expect(screen.queryByText('sensitive server body')).toBeNull(); expect(change).not.toHaveBeenCalled();
});
it('ignores a late response when the endpoint or credentials have changed', async () => {
  let finish!: (value: string[]) => void; h.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const change = vi.fn(); const view = render(<ModelDiscovery provider={provider} onChange={change}/>);
  fireEvent.click(screen.getByRole('button', { name: '自动获取' }));
  view.rerender(<ModelDiscovery provider={{ ...provider, api_key: 'another-fixture' }} onChange={change}/>);
  await act(async () => finish(['old-result'])); expect(screen.queryByRole('dialog')).toBeNull(); expect(change).not.toHaveBeenCalled();
});
