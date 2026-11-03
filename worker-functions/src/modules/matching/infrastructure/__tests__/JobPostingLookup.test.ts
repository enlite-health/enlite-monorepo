/**
 * JobPostingLookup — resolução da vaga no webhook Talentum PRESCREENING_RESPONSE.
 * Unit com pool dublê (nunca toca Talentum/WhatsApp). Ids fictícios, sem PII.
 *
 * Regra: só vaga OFICIAL e VIVA. `_id` do prescreening → `is_draft = false AND deleted_at IS NULL`; título (fallback) →
 * `is_draft = false AND deleted_at IS NULL` e só com EXATAMENTE 1 candidata.
 */
import type { Pool } from 'pg';
import { JobPostingLookup } from '../JobPostingLookup';

function makeLookup(rows: Array<{ id: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { lookup: new JobPostingLookup({ query } as unknown as Pool), query };
}

describe('JobPostingLookup.findByTalentumPrescreeningId', () => {
  it('acha a vaga e a SQL filtra por talentum_prescreening_id + is_draft = false + deleted_at IS NULL', async () => {
    const { lookup, query } = makeLookup([{ id: 'jp-oficial' }]);
    await expect(lookup.findByTalentumPrescreeningId('psc-1')).resolves.toEqual({ id: 'jp-oficial' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('talentum_prescreening_id = $1');
    expect(String(sql)).toContain('is_draft = false');
    expect(String(sql)).not.toContain('talentum_project_id');
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(params).toEqual(['psc-1']);
  });

  it('vaga apagada / sem vaga oficial viva → null', async () => {
    const { lookup } = makeLookup([]);
    await expect(lookup.findByTalentumPrescreeningId('psc-2')).resolves.toBeNull();
  });
});

describe('JobPostingLookup.findByTitleILike', () => {
  it('SQL só enxerga oficial viva (is_draft = false AND deleted_at IS NULL) e limita a 2 (detecta ambiguidade)', async () => {
    const { lookup, query } = makeLookup([{ id: 'jp-oficial' }]);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toEqual({ id: 'jp-oficial' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('is_draft = false');
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(String(sql)).toMatch(/LIMIT 2/);
    expect(params).toEqual(['%CASO 616%']);
  });

  it('0 candidatas → null', async () => {
    const { lookup } = makeLookup([]);
    await expect(lookup.findByTitleILike('CASO 1')).resolves.toBeNull();
  });

  it('>1 candidata oficial → null (nunca LIMIT 1 cego) e o log não carrega o título', async () => {
    const { lookup } = makeLookup([{ id: 'jp-a' }, { id: 'jp-b' }]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(lookup.findByTitleILike('CASO 616')).resolves.toBeNull();
    expect(log.mock.calls.flat().join(' ')).not.toContain('CASO 616');
    log.mockRestore();
  });
});
