import { inflateSync } from 'zlib';
import { PDFDocument, PDFPage } from 'pdf-lib';
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
    expect(pdfText(sem)).toContain(hex('BORRADOR')); // F6/A6-6: o cabeçalho diz que é rascunho, com ou sem anexo
  });

  describe('entradas hostis terminam rápido e devolvem PDF (recuo com teto, largura com piso, palavra cortada por caractere)', () => {
    const aninhado = (n: number): unknown => { let v: unknown = 'fim'; for (let i = 0; i < n; i += 1) v = { k: v }; return v; };
    const casos: Array<[string, { body: string; structured?: unknown }]> = [
      ['linha com 200 espaços', { body: `${' '.repeat(200)}texto` }],
      ['linha com 80 tabs', { body: `${'\t'.repeat(80)}texto` }],
      ['JSON com 80 níveis', { body: 'r', structured: aninhado(80) }],
      ['palavra única de 5.000 caracteres', { body: 'x'.repeat(5000) }],
    ];
    it.each(casos)('%s', async (_n, input) => {
      const drawn: string[] = [];
      const spy = jest.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string) { drawn.push(t); return undefined as never; });
      const t0 = Date.now();
      let pdf: Buffer;
      try { pdf = await renderAdmissionSummaryPdf({ title: 'T', ...input }); } finally { spy.mockRestore(); }
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // conteúdo: nada some e nada vira `?` no lugar de quebra/recuo
      const body = drawn.slice(1).join('');
      expect(body).not.toContain('?');
      if (_n.includes('5.000')) expect(body.length).toBe(5000);
      if (_n.includes('espaços') || _n.includes('tabs')) expect(body).toContain('texto');
      if (_n.includes('80 níveis')) expect(body).toContain('fim');
    }, 5000);
  });

  describe('quebras de linha viram linhas desenhadas (split ANTES de sanitizar)', () => {
    const capture = async (input: { body: string; structured?: unknown }): Promise<Array<{ text: string; x: number }>> => {
      const calls: Array<{ text: string; x: number }> = [];
      const spy = jest.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { x?: number }) { calls.push({ text: t, x: o?.x ?? 0 }); return undefined as never; });
      try { await renderAdmissionSummaryPdf({ title: 'Titulo', ...input }); } finally { spy.mockRestore(); }
      return calls.slice(1); // a 1ª é o título
    };

    it('(a) resumo de 3 linhas -> 3 linhas desenhadas, sem `?` no lugar da quebra (inclui CRLF)', async () => {
      expect((await capture({ body: 'LINHAUM\nLINHADOIS\nLINHATRES' })).map((c) => c.text)).toEqual(['LINHAUM', 'LINHADOIS', 'LINHATRES']);
      expect((await capture({ body: 'A\r\nB\rC' })).map((c) => c.text)).toEqual(['A', 'B', 'C']);
    });

    it('(b) anexo `chaveA: v1 / chaveB: / filho: v2` -> 3 linhas, o filho com recuo maior', async () => {
      const calls = await capture({ body: 'r', structured: { chaveA: 'v1', chaveB: { filho: 'v2' } } });
      const anexo = calls.slice(2); // 'r' + cabeçalho "Datos estructurados"
      expect(anexo.map((c) => c.text)).toEqual(['chaveA: v1', 'chaveB:', 'filho: v2']);
      expect(anexo[2].x).toBeGreaterThan(anexo[1].x);
    });
  });
});
