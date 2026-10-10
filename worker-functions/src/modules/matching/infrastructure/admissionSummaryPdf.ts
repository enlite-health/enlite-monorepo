import { renderStructuredLines } from '../application/admissionGemOutput';
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

/** Recuo máximo (em espaços) e largura mínima de linha: JSON muito aninhado não pode zerar a largura útil. */
const MAX_INDENT_SPACES = 40;
const INDENT_PT_PER_SPACE = 4;

/**
 * Quebra em linhas que cabem em `maxWidth`. SEMPRE progride: a largura tem piso de 1 caractere do corpo e palavra que não cabe
 * é cortada por caractere (cada pedaço tem >= 1 caractere), então não existe largura que faça o laço girar.
 */
function wrap(line: string, font: PDFFont, size: number, maxWidthIn: number): string[] {
  if (!line.trim()) return [''];
  const maxWidth = Math.max(maxWidthIn, size);
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    let piece = '';
    for (const ch of word) {
      if (piece && font.widthOfTextAtSize(piece + ch, size) > maxWidth) {
        out.push(piece);
        piece = '';
      }
      piece += ch;
    }
    current = piece;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Resumo da admissão em PDF (spec 049 F6). `pdf-lib` puro JS, sem I/O: devolve os bytes. O PDF não tem JavaScript nem
 * anexo (passa no pipeline de validação do chat) e as datas dos metadados são fixas — a mesma entrada dá o mesmo conteúdo.
 */
export async function renderAdmissionSummaryPdf(input: { title: string; body: string; structured?: unknown | null }): Promise<Buffer> {
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

  const drawBlock = (text: string, f: PDFFont): void => {
    for (const raw of sanitize(text, charset).split(/\r?\n/)) {
      const lead = Math.min(raw.match(/^ */)?.[0].length ?? 0, MAX_INDENT_SPACES); // preserva o recuo do anexo, com teto
      const indent = lead * INDENT_PT_PER_SPACE;
      for (const [i, line] of wrap(raw.trim(), f, BODY_SIZE, maxWidth - indent).entries()) {
        if (y - LEADING < MARGIN) newPage();
        if (line) page.drawText(line, { x: MARGIN + indent + (i > 0 ? 8 : 0), y: y - BODY_SIZE, size: BODY_SIZE, font: f });
        y -= LEADING;
      }
    }
  };
  drawBlock(input.body, font);

  // Anexo "Datos estructurados": o JSON do Gem, legível (chave: valor, listas). Sem JSON válido não há anexo.
  if (input.structured !== undefined && input.structured !== null) {
    newPage();
    drawBlock('Datos estructurados', bold);
    y -= LEADING / 2;
    drawBlock(renderStructuredLines(input.structured).join('\n'), font);
  }

  pdf.setTitle(sanitize(input.title, charset));
  pdf.setProducer('EnliteOS');
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  pdf.setCreator('EnliteOS');
  return Buffer.from(await pdf.save());
}
