import type { EmailAddress } from "@/lib/api";

/** “发送新邮件给相同接收人”必须始终复用原邮件 To，和所在文件夹无关。 */
export function originalRecipientAddresses(toList: EmailAddress[]): string[] {
  return [...new Set(toList.map((item) => item.address.trim()).filter(Boolean))];
}
