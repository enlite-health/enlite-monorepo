import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const BODY_SIZE = 11;
const TITLE_SIZE = 15;
const LEADING = 15;

/** Fonte padrão do PDF só codifica WinAnsi: o resto (emoji, aspas curvas fora do set) vira `?`, nunca derruba a geração. */
function sanitize(text: string, charset: Set<number>): string {
  let out = '';
  for (const ch of text.replace(/\t/g, '  ')) {
    const cp = ch.codePointAt(0) as number;
    out += charset.has(cp) ? ch : '?';
  }
  return out;
}

function wrap(line: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!line.trim()) return [''];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    // Palavra maior que a linha: corta em pedaços que cabem.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let n = rest.length;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n -= 1;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    current = rest;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Resumo da admissão em PDF (spec 049 F6). `pdf-lib` puro JS, sem I/O: devolve os bytes. O PDF não tem JavaScript nem
 * anexo (passa no pipeline de validação do chat) e as datas dos metadados são fixas — a mesma entrada dá o mesmo conteúdo.
 */
export async function renderAdmissionSummaryPdf(input: { title: string; body: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const maxWidth = PAGE_W - MARGIN * 2;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const newPage = (): void => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  for (const line of wrap(sanitize(input.title, charset), bold, TITLE_SIZE, maxWidth)) {
    page.drawText(line, { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold });
    y -= TITLE_SIZE + 6;
  }
  y -= 10;

  for (const raw of sanitize(input.body, charset).split(/\r?\n/)) {
    for (const line of wrap(raw, font, BODY_SIZE, maxWidth)) {
      if (y - LEADING < MARGIN) newPage();
      if (line) page.drawText(line, { x: MARGIN, y: y - BODY_SIZE, size: BODY_SIZE, font });
      y -= LEADING;
    }
  }

  pdf.setTitle(sanitize(input.title, charset));
  pdf.setProducer('EnliteOS');
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  pdf.setCreator('EnliteOS');
  return Buffer.from(await pdf.save());
}
