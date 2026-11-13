import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Account, PendingMailOpsSummary } from '../../src/lib/ipc-types';
import { reportMailFailure, pendingSummaryFailure, forgetMailFailure, MAIL_ERROR_NOTICES_KEY } from '../../src/lib/mailErrorNotifications';
import { useToastStore } from '../../src/stores/toast.store';
import { profileLocalStorage, initializeProfileStorageNamespace, resetProfileStorageNamespaceForTests } from '../../src/lib/profileStorage';
import ToastContainer from '../../src/components/ToastContainer';

const accounts = [
  { id: 'a', email: 'alpha@example.test', display_name: 'Alpha' },
  { id: 'b', email: 'beta@example.test', display_name: 'Beta' },
] as Account[];
const error = { account_id: 'a', operation_id: 'op-one', op_type: 'send', message: 'Review send result; password=private-value' };
beforeEach(() => { resetProfileStorageNamespaceForTests(); localStorage.clear(); useToastStore.setState({ toasts: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetProfileStorageNamespaceForTests(); });

it('puts the actual account above the message and keeps credential redaction', () => {
  reportMailFailure(error, accounts); render(<ToastContainer />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Alpha · alpha@example.test');
  expect(alert.textContent).toContain('邮件发送待处理');
  expect(alert.textContent).not.toContain('private-value');
  expect(alert.querySelector('div > div')?.textContent).toContain('Alpha');
});
it('does not resurface a closed old operation and persists acknowledgement outside the visible toast list', () => {
  reportMailFailure(error, accounts); render(<ToastContainer />);
  fireEvent.click(screen.getByRole('button', { name: /close notification|关闭通知/i }));
  expect(useToastStore.getState().toasts).toHaveLength(0);
  reportMailFailure(error, accounts);
  reportMailFailure(error, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(0);
  const saved = profileLocalStorage.getItem(MAIL_ERROR_NOTICES_KEY)!;
  expect(saved).toContain('op-one');
  expect(saved).not.toContain('Review'); expect(saved).not.toContain('password');
});
it('does not swallow the same error from another account, a new operation, or a changed failure', () => {
  reportMailFailure(error, accounts);
  reportMailFailure({ ...error, account_id: 'b', operation_id: 'op-two' }, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(2);
  expect(useToastStore.getState().toasts.map(item => item.title)).toEqual(['Alpha · alpha@example.test', 'Beta · beta@example.test']);
  reportMailFailure({ ...error, message: 'New failure after reconnect' }, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(3);
});
it('attributes all-account summaries by the failure record, never the selected mailbox', () => {
  const failure = pendingSummaryFailure({ last_error: 'Failed', last_error_account_id: 'b', last_error_operation_id: 'op-b', last_error_op_type: 'delete' } as PendingMailOpsSummary, 'a')!;
  reportMailFailure(failure, accounts);
  expect(useToastStore.getState().toasts[0].title).toBe('Beta · beta@example.test');
  expect(useToastStore.getState().toasts[0].message).toContain('删除未完成');
});
it('permits a fresh alert after explicit retry without clearing the actual failed operation', () => {
  reportMailFailure(error, accounts); useToastStore.setState({ toasts: [] });
  forgetMailFailure('op-one'); reportMailFailure(error, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(1);
});
it('keeps acknowledgement isolated by profile', async () => {
  await initializeProfileStorageNamespace(async () => 'profile-a');
  reportMailFailure(error, accounts); useToastStore.setState({ toasts: [] });
  await initializeProfileStorageNamespace(async () => 'profile-b');
  reportMailFailure(error, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(1);
});
it('does not guess an unknown account from the current selection', () => {
  reportMailFailure({ account_id: 'missing', message: 'Connection unavailable' }, accounts);
  expect(useToastStore.getState().toasts[0].title).toContain('信息尚未加载');
  expect(useToastStore.getState().toasts[0].title).not.toContain('alpha@');
});
it('coalesces a repeated failure even when preference storage cannot be written', () => {
  vi.spyOn(profileLocalStorage, 'setItem').mockImplementation(() => { throw new Error('read-only'); });
  const pending = { ...error, operation_id: 'ram-only-fixture' };
  reportMailFailure(pending, accounts); useToastStore.setState({ toasts: [] });
  reportMailFailure(pending, accounts);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});
