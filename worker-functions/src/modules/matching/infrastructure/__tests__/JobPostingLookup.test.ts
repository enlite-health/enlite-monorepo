/**
 * JobPostingLookup — resolução da vaga no webhook Talentum PRESCREENING_RESPONSE.
 * Unit com pool dublê (nunca toca Talentum/WhatsApp). Ids fictícios, sem PII.
 *
 * Regra: só vaga OFICIAL e VIVA. Projeto → `deleted_at IS NULL`; título (fallback) →
 * `is_draft = false AND deleted_at IS NULL` e só com EXATAMENTE 1 candidata.
 */
import type { Pool } from 'pg';
import { JobPostingLookup } from '../JobPostingLookup';

function makeLookup(rows: Array<{ id: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { lookup: new JobPostingLookup({ query } as unknown as Pool), query };
}

describe('JobPostingLookup.findByTalentumProjectId', () => {
  it('acha a vaga do projeto e a SQL filtra por talentum_project_id + deleted_at IS NULL', async () => {
    const { lookup, query } = makeLookup([{ id: 'jp-oficial' }]);
    await expect(lookup.findByTalentumProjectId('proj-1')).resolves.toEqual({ id: 'jp-oficial' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('talentum_project_id = $1');
    expect(String(sql)).toContain('deleted_at IS NULL');
    expect(params).toEqual(['proj-1']);
  });

  it('vaga apagada / sem vaga → null', async () => {
    const { lookup } = makeLookup([]);
    await expect(lookup.findByTalentumProjectId('proj-2')).resolves.toBeNull();
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
