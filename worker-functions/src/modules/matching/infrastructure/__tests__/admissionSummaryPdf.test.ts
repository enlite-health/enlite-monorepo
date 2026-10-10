import { inflateSync } from 'zlib';
import { PDFDocument } from 'pdf-lib';
import { ConversationAttachmentValidator } from '@modules/conversation/infrastructure/ConversationAttachmentValidator';
import { renderAdmissionSummaryPdf } from '../admissionSummaryPdf';

describe('renderAdmissionSummaryPdf', () => {
  it('gera um PDF válido que passa no pipeline de validação dos documentos (magic bytes, sem JavaScript) e tem o título', async () => {
    const pdf = await renderAdmissionSummaryPdf({ title: 'Resumen de admisión · 09/10/2026', body: 'Línea uno con acentos: señora, niño.\n\nLínea tres.' });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const v = await new ConversationAttachmentValidator().validate(pdf);
    expect(v).toMatchObject({ ok: true, contentType: 'application/pdf' });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getTitle()).toBe('Resumen de admisión · 09/10/2026');
    expect(doc.getPageCount()).toBe(1);
  });

  it('texto longo quebra em várias páginas; caractere fora do alfabeto do PDF (emoji) vira `?` e não derruba', async () => {
    const body = Array.from({ length: 140 }, (_, i) => `Linha ${i} ${'palavra '.repeat(18)} 😀`).join('\n');
    const pdf = await renderAdmissionSummaryPdf({ title: 'T', body });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(2);
  });

  it('é determinístico: a mesma entrada dá os mesmos bytes (datas de metadados fixas)', async () => {
    const a = await renderAdmissionSummaryPdf({ title: 'T', body: 'corpo' });
    const b = await renderAdmissionSummaryPdf({ title: 'T', body: 'corpo' });
    expect(a.equals(b)).toBe(true);
  });

  it('JSON válido -> anexo "Datos estructurados" legível (chave: valor) em página própria; sem JSON -> só o resumo', async () => {
    const pdfText = (b: Buffer): string => {
      const raw = b.toString('latin1');
      const out = [raw];
      for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
        try { out.push(inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); } catch { /* sem compressão */ }
      }
      return out.join('\n');
    };
    const hex = (t: string): string => Buffer.from(t, 'latin1').toString('hex').toUpperCase();
    const com = await renderAdmissionSummaryPdf({ title: 'T', body: 'Resumen legible', structured: { estado: 'BORRADOR_PARA_REVISION_CTM', equipo: [{ nombre: 'ANEXO-X' }] } });
    const sem = await renderAdmissionSummaryPdf({ title: 'T', body: 'Resumen legible', structured: null });
    expect((await PDFDocument.load(com)).getPageCount()).toBe(2);
    expect((await PDFDocument.load(sem)).getPageCount()).toBe(1);
    expect(pdfText(com)).toContain(hex('Datos estructurados'));
    expect(pdfText(com)).toContain(hex('estado: BORRADOR_PARA_REVISION_CTM'));
    expect(pdfText(com)).not.toContain(hex('"estado"'));
    expect(pdfText(sem)).not.toContain(hex('Datos estructurados'));
  });
});
