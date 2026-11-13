import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import EvidenceReportView from '../../../src/features/home/EvidenceReportView';
afterEach(cleanup);
it('shows actual coverage, missing bodies, failure traces and explicit limitations', () => {
  render(<EvidenceReportView report={{ discoveredMailCount: 12, readMailCount: 2, completeMailCount: 1,
    resources: [{ kind: 'mail', id: 'm', label: 'Long example', totalChars: 9000, readChars: 2000, complete: false, bodyStatus: 'available' }, { kind: 'mail', id: 'h', label: 'Header example', totalChars: 0, readChars: 0, complete: false, bodyStatus: 'headers-only' }],
    warnings: ['预算已到，未分析全部'], trace: [{ tool: 'mail_search', status: 'ok' }, { tool: 'mail_read', status: 'failed' }], budgetExhausted: true, toolFallback: false }} />);
  expect(screen.getByText(/正文 2 封，完整读取 1 封/)).toBeTruthy(); expect(screen.getByText(/非全邮箱计数/)).toBeTruthy();
  expect(screen.getByText(/读取 2000\/9000 字符/)).toBeTruthy(); expect(screen.getByText(/正文未下载/)).toBeTruthy(); expect(screen.getByText(/失败\/未执行/)).toBeTruthy();
});
