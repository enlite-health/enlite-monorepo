/**
 * JobPostingLookup — resolução da vaga no webhook Talentum PRESCREENING_RESPONSE.
 * Unit com pool dublê (nunca toca Talentum/WhatsApp). Ids fictícios, sem PII.
 *
 * Regra: só vaga OFICIAL e VIVA. `_id` do prescreening → `is_draft = false AND deleted_at IS NULL`; título (fallback) →
 * `is_draft = false AND deleted_at IS NULL` e só com EXATAMENTE 1 candidata.
 */
import type { Pool } from 'pg';
import { JobPostingLookup, titleRegex } from '../JobPostingLookup';

function makeLookup(rows: Array<{ id: string; is_draft?: boolean }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { lookup: new JobPostingLookup({ query } as unknown as Pool), query };
}

describe('JobPostingLookup.findByTalentumPrescreeningId', () => {
  it('acha a vaga viva dona do _id (rascunho ou não) e a SQL filtra por talentum_prescreening_id + deleted_at IS NULL', async () => {
    const { lookup, query } = makeLookup([{ id: 'jp-oficial' }]);
    await expect(lookup.findByTalentumPrescreeningId('psc-1')).resolves.toEqual({ id: 'jp-oficial' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('talentum_prescreening_id = $1');
    expect(String(sql)).not.toContain('talentum_project_id');
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(params).toEqual(['psc-1']);
  });

  it('sem vaga viva → null', async () => {
    const { lookup } = makeLookup([]);
    await expect(lookup.findByTalentumPrescreeningId('psc-2')).resolves.toBeNull();
  });
});

describe('JobPostingLookup.findByTitleILike', () => {
  it('SQL só enxerga vivas, ordena oficial primeiro e limita a 2 (detecta ambiguidade)', async () => {
    const { lookup, query } = makeLookup([{ id: 'jp-oficial', is_draft: false }]);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toEqual({ id: 'jp-oficial' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(String(sql)).toMatch(/ORDER BY is_draft ASC/);
    expect(String(sql)).toContain('title ~* $1');
    expect(String(sql)).toMatch(/LIMIT 2/);
    expect(params).toEqual(['CASO 616(?![0-9])']);
  });

  it('0 candidatas → null', async () => {
    const { lookup } = makeLookup([]);
    await expect(lookup.findByTitleILike('CASO 1')).resolves.toBeNull();
  });

  it('1 candidata só e ela é rascunho (vaga criada pelo sync/webhook, DEFAULT is_draft=true) → resolve (sem regressão)', async () => {
    const { lookup } = makeLookup([{ id: 'jp-unica', is_draft: true }]);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toEqual({ id: 'jp-unica' });
  });

  it('oficial + rascunho do mesmo paciente → a OFICIAL (o bug original)', async () => {
    const { lookup } = makeLookup([{ id: 'jp-oficial', is_draft: false }, { id: 'jp-rascunho', is_draft: true }]);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toEqual({ id: 'jp-oficial' });
  });

  it('2 oficiais → null (nunca LIMIT 1 cego) e o log não carrega o título', async () => {
    const { lookup } = makeLookup([{ id: 'jp-a', is_draft: false }, { id: 'jp-b', is_draft: false }]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toBeNull();
    expect(log.mock.calls.flat().join(' ')).not.toContain('CASO 616');
    log.mockRestore();
  });

  it('2 rascunhos e nenhuma oficial → null (ambíguo)', async () => {
    const { lookup } = makeLookup([{ id: 'jp-a', is_draft: true }, { id: 'jp-b', is_draft: true }]);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toBeNull();
  });
});

describe('titleRegex — delimitador do número do caso', () => {
  it("número no fim do termo: exige que o número acabe ('CASO 816' não casa 'CASO 8160')", () => {
    const re = new RegExp(titleRegex('CASO 816'), 'i');
    expect(re.test('CASO 816-2, AT')).toBe(true);
    expect(re.test('caso 816')).toBe(true);
    expect(re.test('CASO 8160-1')).toBe(false);
  });

  it('termo que não termina em dígito: sem lookahead; metacaracteres escapados', () => {
    expect(titleRegex('CASO EN')).toBe('CASO EN');
    expect(titleRegex('Vaga (X)+.')).toBe('Vaga \\(X\\)\\+\\.');
  });
});
