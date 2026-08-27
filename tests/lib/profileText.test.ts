import { describe, expect, it } from "vitest";
import { formatProfileText } from "@/lib/profileText";

describe("formatProfileText", () => {
  it("turns a Markdown research report into readable profile text", () => {
    const result = formatProfileText(`# 风险结论

**状态：** 建议核验

- 主体真实
- 付款条件需确认

> 证据来自 [企业登记页](https://example.com/company)。

| 项目 | 结果 |
| --- | --- |
| LEI | 未发现 |

\`待确认\``);

    expect(result).toContain("风险结论");
    expect(result).toContain("状态： 建议核验");
    expect(result).toContain("• 主体真实");
    expect(result).toContain("企业登记页（https://example.com/company）");
    expect(result).toContain("项目 ｜ 结果");
    expect(result).toContain("待确认");
    expect(result).not.toMatch(/(^|\n)\s*#|\*\*|\[[^\]]+\]\([^)]+\)|`/);
  });

  it("keeps fenced code content but removes fence markers", () => {
    expect(formatProfileText("```text\nVAT: GB123\n```" )).toBe("VAT: GB123");
  });
});
