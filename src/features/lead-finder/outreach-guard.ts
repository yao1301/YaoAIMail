export interface OutreachUserConstraints {
  forbidContactRequests: boolean;
}

export function parseOutreachUserConstraints(instruction: string): OutreachUserConstraints {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  const chineseBan = /(?:不要|禁止|别再?|无需|不需要|不可|避免).{0,16}(?:问|询问|索要|寻找|获取|转给|转交|介绍).{0,12}(?:邮箱|邮件地址|联系人|负责人|采购|买手|选品|经理)/i.test(normalized)
    || /(?:不要|禁止|别再?|无需|不需要|不可|避免).{0,8}(?:邮箱|联系人|负责人)/i.test(normalized);
  const englishBan = /(?:do\s+not|don't|dont|never|avoid|no\s+need\s+to).{0,32}(?:ask|request|find|identify|direct|refer|forward).{0,24}(?:email|contact|person|buyer|manager|decision[ -]?maker)/i.test(normalized);
  return { forbidContactRequests: chineseBan || englishBan };
}

export function contactRequestConstraintPrompt(constraints: OutreachUserConstraints): string {
  if (!constraints.forbidContactRequests) return "";
  return "【开发信硬规则】不得询问、索要或寻找邮箱、联系人、负责人、采购、买手或经理；不得请求转发/转交邮件；不得使用 who handles、right person、could you direct/point me、forward this 等转介表达。应直接向当前邮箱提供一个具体、低成本的价值选项。";
}

export function violatesOutreachUserConstraints(body: string, constraints: OutreachUserConstraints): boolean {
  if (!constraints.forbidContactRequests) return false;
  return /(?:who\s+(?:handles|is\s+responsible)|right\s+person|correct\s+person|person\s+(?:handling|responsible)|could\s+you\s+(?:direct|point|refer|forward|pass)|would\s+you\s+(?:direct|point|refer|forward|pass)|buyer\s+or\s+sourcing\s+manager|contact\s+(?:details|information)|email\s+address)|(?:谁负责|哪位负责|负责.{0,8}(?:采购|选品)的人|转给.{0,12}(?:采购|负责人|联系人)|转交.{0,12}(?:采购|负责人|联系人)|(?:提供|告知|分享).{0,8}(?:邮箱|联系人|联系方式))/i.test(body);
}

export function normalizeOutreachEmailFormat(value: string): string {
  let body = value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  body = body
    .replace(/^((?:hi|hello|dear)\s+[^,\n]{1,60},)[ \t]+(?=\S)/i, "$1\n\n")
    .replace(/^((?:hi|hello|dear)\s+[^,\n]{1,60},)\n(?!\n)/i, "$1\n\n")
    .replace(/^((?:您好|你好|尊敬的[^，\n]{0,40})[，,])[ \t]+(?=\S)/, "$1\n\n")
    .replace(/^((?:您好|你好|尊敬的[^，\n]{0,40})[，,])\n(?!\n)/, "$1\n\n");

  body = body.replace(
    /(^|\n)(Best regards|Kind regards|Warm regards|Regards|Sincerely|Thanks|Thank you|此致|祝好)[,，]?[ \t]+(?=\S)/gi,
    (_match, prefix: string, signoff: string) => `${prefix}${signoff},\n`,
  );
  return body.replace(/\n{3,}/g, "\n\n").trim();
}
