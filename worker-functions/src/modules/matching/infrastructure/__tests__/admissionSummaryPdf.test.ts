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
});
