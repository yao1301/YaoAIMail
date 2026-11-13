export type EmailEvidenceKind = 'published' | 'provider_reported' | 'pattern' | 'guessed' | 'unknown';
export type EmailDeliveryStatus = 'valid' | 'invalid' | 'accept_all' | 'unknown' | 'blocked' | 'disposable' | 'not_checked';

export interface EmailResearchEvidence {
  email: string;
  source: string;
  sourceUrl: string;
  verification: string;
  person?: string;
  emailType?: string;
  suitability?: string;
  evidenceKind?: EmailEvidenceKind;
  deliveryStatus?: EmailDeliveryStatus;
  verifiedAt?: number;
  verificationProvider?: string;
  personName?: string;
  personRole?: string;
  personSourceUrl?: string;
  personQuote?: string;
  roleVerified?: boolean;
}

export interface ResearchContact {
  name: string;
  role: string;
  sourceUrl: string;
  quote: string;
  roleVerified: boolean;
  sourceDate?: string;
  observedAt?: number;
  currentStatus?: 'historical' | 'unconfirmed';
}

export interface ContactPerson extends ResearchContact {
  sourceDate: string;
  observedAt: number;
  currentStatus: 'historical' | 'unconfirmed';
}

export interface BuyingSignal {
  kind: string;
  summary: string;
  sourceUrl: string;
  quote: string;
  observedAt: number;
}

const evidenceLabels: Record<EmailEvidenceKind, string> = {
  published: '官网/页面公开',
  provider_reported: '第三方报告',
  pattern: '格式推导',
  guessed: '猜测',
  unknown: '依据待核实',
};

const deliveryLabels: Record<EmailDeliveryStatus, string> = {
  valid: '验证服务通过',
  invalid: '无效',
  accept_all: '全收域·未确认',
  unknown: '未知',
  blocked: '受阻',
  disposable: '一次性',
  not_checked: '未验证投递',
};

function knownValue<T extends string>(value: T | undefined, labels: Record<T, string>): T | undefined {
  return value && Object.prototype.hasOwnProperty.call(labels, value) ? value : undefined;
}

/** Presentation only. Never use these labels to decide company ownership or sending permission. */
export function getEmailEvidencePresentation(evidence: readonly EmailResearchEvidence[] = []) {
  const evidenceKind = evidence.map(entry => knownValue(entry.evidenceKind, evidenceLabels)).find(kind => kind && kind !== 'unknown') ?? 'unknown';
  const checked = evidence.filter(entry => knownValue(entry.deliveryStatus, deliveryLabels));
  // Conflicting verification records must not hide an explicit adverse result behind a pass.
  const deliveryRecord = (['invalid', 'disposable', 'blocked', 'accept_all', 'valid', 'unknown', 'not_checked'] as const)
    .map(status => checked.find(entry => entry.deliveryStatus === status)).find(Boolean);
  const deliveryStatus = deliveryRecord?.deliveryStatus ?? 'not_checked';
  const legacyMixed = !deliveryRecord && evidence.some(entry =>
    /hunter/i.test(`${entry.source} ${entry.verification}`) && /可投递|全收域|deliverable|accept[ _-]?all|catch[ _-]?all/i.test(entry.verification));
  // Free text can trigger caution, but cannot establish publication or successful verification.
  const inferred = evidenceKind === 'pattern' || evidenceKind === 'guessed'
    || (evidenceKind === 'unknown' && evidence.some(entry => /猜测|推测|格式推导|\bpattern\b|\bguess(?:ed)?\b/i.test(`${entry.source} ${entry.verification}`)));
  const unsuitable = evidence.find(entry => entry.suitability?.startsWith('不建议'))?.suitability;
  const warning = inferred ? '需确认：推导或猜测邮箱，尚无公开地址证明，不建议直接发送。'
    : legacyMixed ? '历史结果混合·需复核'
    : deliveryStatus === 'invalid' || deliveryStatus === 'disposable' ? '不建议发送：邮箱无效或为一次性邮箱。'
    : deliveryStatus === 'accept_all' || deliveryStatus === 'blocked' ? '需确认：尚未确认该邮箱可投递。'
    : undefined;
  const contactAdvice = [warning, unsuitable].filter(Boolean).join(' ') || (
    evidenceKind === 'unknown' ? '发送前请先核实邮箱依据、岗位与业务相关性。'
    : evidence.find(entry => entry.suitability)?.suitability || '发送前请核实岗位与业务相关性；公开邮箱不代表已获营销许可。');

  return {
    evidenceKind,
    deliveryStatus,
    evidenceLabel: evidenceLabels[evidenceKind],
    deliveryLabel: legacyMixed ? '历史结果混合·需复核' : deliveryLabels[deliveryStatus],
    warning: [warning, unsuitable].filter(Boolean).join(' ') || undefined,
    contactAdvice,
    verificationProvider: deliveryRecord?.verificationProvider,
    verifiedAt: deliveryRecord?.verifiedAt,
  };
}

/** A named person is a separate finding; neither a title nor a mailbox proves purchasing authority. */
export function getResearchContacts(
  contacts: readonly ResearchContact[] = [],
  evidence: readonly EmailResearchEvidence[] = [],
): ResearchContact[] {
  const all = [...contacts, ...evidence.filter(entry => entry.personName?.trim()).map(entry => ({
    name: entry.personName!, role: entry.personRole || '', sourceUrl: entry.personSourceUrl || '',
    quote: entry.personQuote || '', roleVerified: entry.roleVerified === true,
  }))];
  const seen = new Set<string>();
  return all.filter(contact => {
    if (!contact.name.trim()) return false;
    const key = JSON.stringify([contact.name.trim(), contact.role.trim(), contact.sourceUrl.trim()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function researchSourceUrl(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Native timestamps are seconds; also accept older frontend millisecond timestamps. */
export function formatResearchTimestamp(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : undefined;
}
