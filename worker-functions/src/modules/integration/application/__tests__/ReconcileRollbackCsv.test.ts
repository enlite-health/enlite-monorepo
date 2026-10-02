import { ROLLBACK_CSV_HEADER, parseRollbackCsv, serializeRollbackCsv, type RollbackRow } from '../ReconcileRollbackCsv';

const row = (o: Partial<RollbackRow> = {}): RollbackRow => ({
  jobPostingId: 'jp-1', projectId: 'old-1', publicId: null, slug: null, whatsappUrl: null, ...o,
});

describe('ReconcileRollbackCsv', () => {
  it('ida e volta SEM perda: NULL ≠ "" , vírgula, aspas e quebra de linha no valor', () => {
    const rows = [
      row(),
      row({ jobPostingId: 'jp-2', slug: '', whatsappUrl: 'https://wa.me/123?text=Hola,%20"x"' }),
      row({ jobPostingId: 'jp-3', publicId: '0b0d2c1e-0000-4000-8000-000000000001', slug: 'a\nb', whatsappUrl: 'x\r\ny' }),
    ];
    const text = serializeRollbackCsv(rows);
    expect(text.startsWith(`${ROLLBACK_CSV_HEADER}\n`)).toBe(true);
    expect(parseRollbackCsv(text)).toEqual(rows);
  });

  it('NULL sai sem aspas e string vazia sai como ""', () => {
    expect(serializeRollbackCsv([row({ slug: '' })])).toBe(`${ROLLBACK_CSV_HEADER}\njp-1,old-1,,"",\n`);
  });

  it('aceita o último registro sem quebra de linha final e arquivo só com cabeçalho', () => {
    expect(parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\njp-1,old-1,,,`)).toEqual([row()]);
    expect(parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\n`)).toEqual([]);
  });

  it('recusa cabeçalho errado, texto vazio, linha torta, id vazio e aspas sem fechar', () => {
    expect(() => parseRollbackCsv('')).toThrow('cabeçalho');
    expect(() => parseRollbackCsv('a,b\n')).toThrow('cabeçalho');
    expect(() => parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\njp-1,old\n`)).toThrow('linha 2 inválida');
    expect(() => parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\n,old,,,\n`)).toThrow('linha 2 inválida');
    expect(() => parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\njp-1,"old\n`)).toThrow('aspas sem fechar');
  });
});
