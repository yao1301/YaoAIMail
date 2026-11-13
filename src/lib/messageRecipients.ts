import type { EmailAddress } from "@/lib/api";

export interface OriginalRecipientFields {
  to: string[];
  cc: string[];
  bcc: string[];
}

function uniqueAddresses(items: EmailAddress[], seen: Set<string>): string[] {
  const addresses: string[] = [];
  for (const item of items) {
    const address = item.address.trim();
    const key = address.toLocaleLowerCase();
    if (!address || seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  return addresses;
}

/**
 * “发送新邮件给相同接收人”完整复用原邮件的 To/Cc/Bcc，和所在文件夹无关。
 * 如果同一地址出现在多个字段，保留它首次出现的角色，避免重复发送。
 */
export function originalRecipientFields(
  toList: EmailAddress[],
  ccList: EmailAddress[],
  bccList: EmailAddress[],
): OriginalRecipientFields {
  const seen = new Set<string>();
  return {
    to: uniqueAddresses(toList, seen),
    cc: uniqueAddresses(ccList, seen),
    bcc: uniqueAddresses(bccList, seen),
  };
}
