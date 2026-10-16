import type { PdfRow } from './parse.js';

// A PDF's text, laid out as rows. Only ever loaded through a dynamic import, so
// pdf.js (and its worker) download the first time someone picks a PDF, not
// with the app.
//
// The order the text comes out of a PDF is the order it was drawn, which for
// both marketplaces' receipts is not the reading order (CardTrader draws every
// price after every name). So words are placed by where they sit on the page
// and grouped into rows by height instead.

export async function pdfRows(data: ArrayBuffer): Promise<PdfRow[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const rows: PdfRow[] = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      const lines: { y: number; words: { x: number; s: string }[] }[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const x = item.transform[4] as number;
        const y = item.transform[5] as number;
        // Same row within a couple of points: baselines of one line wobble.
        let line = lines.find((l) => Math.abs(l.y - y) <= 2);
        if (!line) lines.push((line = { y, words: [] }));
        line.words.push({ x, s: item.str.trim() });
      }
      lines.sort((a, b) => b.y - a.y); // PDF y grows upwards: top of the page first
      for (const l of lines) rows.push({ page, y: l.y, words: l.words.sort((a, b) => a.x - b.x) });
    }
  } finally {
    void doc.destroy();
  }
  return rows;
}
