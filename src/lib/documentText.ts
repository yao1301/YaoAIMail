function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

async function extractPdf(file: File): Promise<string> {
  const [{ GlobalWorkerOptions, getDocument, OPS }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .replace(/[^\S\n]+/g, " ")
        .trim();
      if (text) pages.push(`[[PAGE:${pageNumber}]]\n${text}`);
      else {
        const operations = await page.getOperatorList();
        if (operations.fnArray.some(op => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintImageMaskXObject)) {
          throw new Error(`第 ${pageNumber} 页是没有可提取文字的图片页，需要 OCR；没有跳过后继续。`);
        }
      }
    }
    return pages.join("\n\n");
  } finally { await pdf.destroy(); }
}

async function extractWorkbook(file: File): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    return `[[SHEET:${sheetName}]]\n${XLSX.utils.sheet_to_csv(worksheet, { blankrows: false })}`;
  }).join("\n\n");
}

export async function extractDocumentText(file: File): Promise<string> {
  const extension = extensionOf(file.name);
  if ([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml"].includes(extension)) {
    return file.text();
  }
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === ".xlsx" || extension === ".xls") {
    return extractWorkbook(file);
  }
  if (extension === ".pdf") {
    return extractPdf(file);
  }
  throw new Error("不支持该文件格式");
}
