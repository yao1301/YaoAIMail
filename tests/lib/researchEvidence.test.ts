import { describe, expect, it } from 'vitest';
import {
  formatResearchTimestamp, getEmailEvidencePresentation, getResearchContacts, researchSourceUrl,
  type ContactPerson, type EmailResearchEvidence, type ResearchContact,
} from '../../src/lib/researchEvidence';

const base: EmailResearchEvidence = {
  email: 'contact@example.invalid', source: '网页', sourceUrl: 'https://example.invalid/contact', verification: '',
};

describe('email evidence presentation', () => {
  it.each([
    ['published', '官网/页面公开'], ['provider_reported', '第三方报告'],
    ['pattern', '格式推导'], ['guessed', '猜测'], ['unknown', '依据待核实'],
  ] as const)('labels %s without inferring delivery', (evidenceKind, label) => {
    const result = getEmailEvidencePresentation([{ ...base, evidenceKind }]);
    expect(result.evidenceLabel).toBe(label);
    expect(result.deliveryLabel).toBe('未验证投递');
    expect(result.deliveryStatus).toBe('not_checked');
  });

  it.each([
    ['valid', '验证服务通过'], ['invalid', '无效'], ['accept_all', '全收域·未确认'],
    ['unknown', '未知'], ['blocked', '受阻'], ['disposable', '一次性'], ['not_checked', '未验证投递'],
  ] as const)('labels %s independently of publication', (deliveryStatus, label) => {
    const result = getEmailEvidencePresentation([{ ...base, deliveryStatus }]);
    expect(result.deliveryLabel).toBe(label);
    expect(result.evidenceLabel).toBe('依据待核实');
  });

  it('does not upgrade legacy prose or a source URL to publication or successful verification', () => {
    const result = getEmailEvidencePresentation([{ ...base, source: '官网', verification: '公开发现，验证有效，可投递', suitability: '建议发送' }]);
    expect(result.evidenceLabel).toBe('依据待核实');
    expect(result.deliveryLabel).toBe('未验证投递');
    expect(result.contactAdvice).not.toContain('建议发送');
  });

  it.each(['Hunter 可投递/全收域', 'Hunter 可投递', 'Hunter 全收域', 'Hunter accept_all'])('keeps %s conservative', verification => {
    const result = getEmailEvidencePresentation([{ ...base, verification, suitability: '建议直接发送' }]);
    expect(result.deliveryLabel).toBe('历史结果混合·需复核');
    expect(result.contactAdvice).toContain('需复核');
    expect(result.contactAdvice).not.toContain('建议直接发送');
    expect(result.evidenceKind).toBe('unknown');
  });

  it('recognizes the legacy provider in the source field', () => {
    expect(getEmailEvidencePresentation([{ ...base, source: 'Hunter', verification: '可投递/全收域' }]).deliveryLabel)
      .toBe('历史结果混合·需复核');
  });

  it('prefers structured dimensions even behind a legacy record and keeps verification metadata together', () => {
    const result = getEmailEvidencePresentation([
      { ...base, evidenceKind:'unknown', verification: 'Hunter 可投递/全收域', verificationProvider: 'Old provider', verifiedAt: 1 },
      { ...base, evidenceKind: 'published' },
      { ...base, deliveryStatus: 'valid', verificationProvider: 'Example verifier', verifiedAt: 1_792_512_000 },
    ]);
    expect(result).toMatchObject({ evidenceLabel: '官网/页面公开', deliveryLabel: '验证服务通过', verificationProvider: 'Example verifier', verifiedAt: 1_792_512_000 });
  });

  it.each(['pattern', 'guessed'] as const)('warns on %s even when a verifier passes', evidenceKind => {
    const result = getEmailEvidencePresentation([{ ...base, evidenceKind, deliveryStatus: 'valid', suitability: '建议直接发送' }]);
    expect(result.deliveryLabel).toBe('验证服务通过');
    expect(result.warning).toContain('需确认');
    expect(result.contactAdvice).toContain('不建议直接发送');
    expect(result.evidenceLabel).not.toBe('官网/页面公开');
  });

  it('uses legacy guess text only to warn, never to elevate evidence', () => {
    const result = getEmailEvidencePresentation([{ ...base, verification: 'pattern guessed', suitability: '建议发送' }]);
    expect(result.evidenceKind).toBe('unknown');
    expect(result.warning).toContain('需确认');
    expect(result.contactAdvice).not.toContain('建议发送');
  });

  it.each(['invalid', 'disposable', 'blocked', 'accept_all'] as const)('does not hide %s behind a pass', deliveryStatus => {
    const records: EmailResearchEvidence[] = [{ ...base, deliveryStatus: 'valid' }, { ...base, deliveryStatus }];
    expect(getEmailEvidencePresentation(records).deliveryStatus).toBe(deliveryStatus);
    expect(getEmailEvidencePresentation([...records].reverse()).deliveryStatus).toBe(deliveryStatus);
    expect(getEmailEvidencePresentation(records).warning).toBeTruthy();
  });

  it('keeps explicit unsuitable warnings and empty evidence conservative', () => {
    expect(getEmailEvidencePresentation([{ ...base, evidenceKind: 'published', suitability: '不建议：事务邮箱' }]).warning)
      .toBe('不建议：事务邮箱');
    expect(getEmailEvidencePresentation()).toMatchObject({ evidenceKind: 'unknown', deliveryStatus: 'not_checked' });
  });
});

describe('named research contacts', () => {
  const contact: ResearchContact = { name: 'Example Person', role: 'Operations', sourceUrl: 'https://example.invalid/team', quote: 'Example Person — Operations', roleVerified: true };

  it('retains contacts with no email and folds identical evidence contacts', () => {
    const result = getResearchContacts([contact], [{ ...base, personName: contact.name, personRole: contact.role, personSourceUrl: contact.sourceUrl, personQuote: contact.quote, roleVerified: true }]);
    expect(result).toEqual([contact]);
    expect(getResearchContacts([contact])).toEqual([contact]);
  });

  it('does not infer person evidence from an email source or legacy person text', () => {
    expect(getResearchContacts([], [{ ...base, person: 'Historical person description' }])).toEqual([]);
    expect(getResearchContacts([], [{ ...base, personName: 'Example Person' }])).toEqual([
      { name: 'Example Person', role: '', sourceUrl: '', quote: '', roleVerified: false },
    ]);
    expect(getResearchContacts([{ ...contact, name: '  ' }])).toEqual([]);
  });

  it('preserves historical status and dates when duplicate email evidence has no current-role proof', () => {
    const historical: ContactPerson={...contact,roleVerified:false,sourceDate:'2001',observedAt:1_792_512_000,currentStatus:'historical'};
    expect(getResearchContacts([historical],[{...base,personName:contact.name,personRole:contact.role,personSourceUrl:contact.sourceUrl}])).toEqual([historical]);
  });
});

it('offers only clickable web sources', () => {
  expect(researchSourceUrl('https://example.invalid/team')).toBe('https://example.invalid/team');
  for (const url of ['', 'invalid', 'javascript:alert(1)', 'file:///example', 'data:text/html,example']) {
    expect(researchSourceUrl(url)).toBeUndefined();
  }
});

it('formats native seconds and frontend milliseconds without inventing a date for missing values',()=>{
  const time=Date.UTC(2026,9,20,8);
  expect(formatResearchTimestamp(time/1000)).toBe(new Date(time).toLocaleString('zh-CN'));
  expect(formatResearchTimestamp(time)).toBe(formatResearchTimestamp(time/1000));
  for (const value of [undefined,0,-1,NaN,Infinity,1e20]) expect(formatResearchTimestamp(value)).toBeUndefined();
});
