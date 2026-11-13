import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readDraftDocuments } from '../../src/features/compose/documentDraft';

describe('actual document extraction used for email drafts', () => {
  it('reads a real Excel workbook, including sheet names, currencies and the last row', async () => {
    const book = XLSX.utils.book_new();
    const rows: (string | number)[][] = [['Product', 'Qty', 'Currency', 'Price']];
    for (let i = 0; i < 700; i++) rows.push([`Fixture ${i}`, 10, 'EUR', 112.5]);
    rows.push(['FINAL-ROW', 200, 'USD', 99.25]);
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Quotation');
    const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const file = new File([bytes], 'fixture-quote.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes });
    const [section] = await readDraftDocuments([file]);
    expect(section.text.length).toBeGreaterThan(12_000);
    expect(section.text).toContain('[[SHEET:Quotation]]');
    expect(section.text).toContain('FINAL-ROW,200,USD,99.25');
  });
  it('reads multilingual text and CSV as content, not just filenames', async () => {
    const files = ['规格：型号 AX-10，数量 200，交期待确认', 'Product,Qty\nAX-10,200'].map((text, index) => {
      const file = new File([text], index ? 'quote.csv' : 'specification.txt');
      Object.defineProperty(file, 'text', { value: async () => text }); return file;
    });
    const sections = await readDraftDocuments(files);
    expect(sections[0].text).toContain('交期待确认'); expect(sections[1].text).toContain('AX-10,200');
  });
});
