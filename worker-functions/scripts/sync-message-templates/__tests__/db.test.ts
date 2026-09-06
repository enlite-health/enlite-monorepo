/**
 * db.test.ts — o ÚLTIMO elo antes do INSERT/UPDATE em `message_templates` de
 * PRODUÇÃO. Puro: pool falso, sem banco, sem rede.
 *
 * Por que existe: `diff-engine.test.ts` prova que o PLANO está certo (o
 * sentinela nunca entra em `body_twilio`). Nada provava que o plano é APLICADO
 * certo — uma troca de `$4` por `$3` no INSERT, ou `body_twilio` saindo da lista
 * do `ON CONFLICT`, recolocava o defeito uma camada abaixo e o teste do plano
 * continuava verde. É o mesmo argumento que trouxe o teste do diff-engine, um
 * andar mais fundo.
 */
import { applyPlan, type DbTemplateRow } from '../db';
import type { SyncPlan } from '../diff-engine';
import { NON_TEXTUAL_SENTINEL } from '../../../src/modules/notification/infrastructure/twilioContentBody';

type Call = { sql: string; params: unknown[] };

function fakePool() {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; });
  const release = jest.fn();
  return { pool: { connect: async () => ({ query, release }) } as never, calls, release };
}

const emptyPlan: SyncPlan = { inserts: [], updates: [], deletes: [] };
const row = (over: Partial<DbTemplateRow> = {}): DbTemplateRow => ({
  id: 'id-1', slug: 's', name: 'n', body: 'b', body_twilio: null, category: 'UTILITY',
  is_active: true, content_sid: 'HX1', ...over,
});

describe('applyPlan — o que realmente chega ao banco', () => {
  it('INSERT: cada valor no seu parâmetro, e `body_twilio` recebe o texto aprovado (não o body legado)', async () => {
    const { pool, calls } = fakePool();
    await applyPlan(pool, {
      ...emptyPlan,
      inserts: [{ slug: 'tpl', name: 'Tpl', body: 'legado {{worker_name}}', bodyTwilio: 'aprovado {{1}}', category: 'UTILITY', contentSid: 'HX9' }],
    });

    const ins = calls.find((c) => c.sql.includes('INSERT INTO message_templates'))!;
    expect(ins.params).toEqual(['tpl', 'Tpl', 'legado {{worker_name}}', 'aprovado {{1}}', 'UTILITY', 'HX9']);
    // a ordem das colunas tem de casar com a dos parâmetros
    expect(ins.sql).toContain('(slug, name, body, body_twilio, category, is_active, content_sid)');
    // e o UPSERT tem de atualizar body_twilio também, senão um re-run deixa o valor velho
    expect(ins.sql).toContain('body_twilio = EXCLUDED.body_twilio');
  });

  it('INSERT: `bodyTwilio` null grava NULL — e o sentinela fica na coluna legada, onde ele pode estar', async () => {
    const { pool, calls } = fakePool();
    await applyPlan(pool, {
      ...emptyPlan,
      inserts: [{ slug: 'tpl', name: 'Tpl', body: NON_TEXTUAL_SENTINEL, bodyTwilio: null, category: null, contentSid: 'HX9' }],
    });

    const ins = calls.find((c) => c.sql.includes('INSERT INTO message_templates'))!;
    expect(ins.params[2]).toBe(NON_TEXTUAL_SENTINEL); // body: pode
    expect(ins.params[3]).toBeNull();                  // body_twilio: nunca
  });

  it('UPDATE: monta o SET a partir dos campos do plano, com os parâmetros na mesma ordem', async () => {
    const { pool, calls } = fakePool();
    await applyPlan(pool, {
      ...emptyPlan,
      updates: [{ id: 'id-9', slug: 'tpl', fields: { body_twilio: 'aprovado {{1}}', is_active: true }, bodyDiverges: true, bodyTwilio: 'aprovado {{1}}' }],
    });

    const upd = calls.find((c) => c.sql.startsWith('UPDATE message_templates SET'))!;
    expect(upd.sql).toContain('body_twilio = $1');
    expect(upd.sql).toContain('is_active = $2');
    expect(upd.params).toEqual(['aprovado {{1}}', true, 'id-9']);
    // `body` NUNCA entra num UPDATE: é o contrato de envio, escrito à mão
    expect(upd.sql).not.toMatch(/\bbody = \$/);
  });

  it('UPDATE: `body_twilio` de volta a null (o Content perdeu o texto) é aplicado como NULL', async () => {
    const { pool, calls } = fakePool();
    await applyPlan(pool, {
      ...emptyPlan,
      updates: [{ id: 'id-9', slug: 'tpl', fields: { body_twilio: null }, bodyDiverges: false, bodyTwilio: null }],
    });
    const upd = calls.find((c) => c.sql.startsWith('UPDATE message_templates SET'))!;
    expect(upd.params).toEqual([null, 'id-9']);
  });

  it('UPDATE sem campo nenhum não vira query (não escreve por escrever)', async () => {
    const { pool, calls } = fakePool();
    await applyPlan(pool, { ...emptyPlan, updates: [{ id: 'id-9', slug: 'tpl', fields: {}, bodyDiverges: false, bodyTwilio: null }] });
    expect(calls.some((c) => c.sql.startsWith('UPDATE message_templates SET'))).toBe(false);
  });

  it('DELETE apaga por id, dentro da mesma transação', async () => {
    const { pool, calls, release } = fakePool();
    await applyPlan(pool, { ...emptyPlan, deletes: [{ id: 'id-x', slug: 'sumiu', reason: 'qualquer' }] });

    expect(calls[0].sql).toBe('BEGIN');
    expect(calls.find((c) => c.sql.includes('DELETE FROM message_templates'))!.params).toEqual(['id-x']);
    expect(calls[calls.length - 1].sql).toBe('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('erro no meio → ROLLBACK, relança, e o cliente é devolvido', async () => {
    const calls: Call[] = [];
    const release = jest.fn();
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO message_templates')) throw new Error('constraint');
      return { rows: [] };
    });
    const pool = { connect: async () => ({ query, release }) } as never;

    await expect(applyPlan(pool, { ...emptyPlan, inserts: [{ slug: 's', name: 'n', body: 'b', bodyTwilio: null, category: null, contentSid: 'HX' }] }))
      .rejects.toThrow('constraint');
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.map((c) => c.sql)).not.toContain('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('fetchDbTemplates lê `body_twilio` — sem isso o diff nunca veria a coluna divergir', async () => {
    const { fetchDbTemplates } = await import('../db');
    const query = jest.fn().mockResolvedValue({ rows: [row()] });
    await fetchDbTemplates({ query } as never);
    expect(query.mock.calls[0][0]).toContain('body_twilio');
  });
});
