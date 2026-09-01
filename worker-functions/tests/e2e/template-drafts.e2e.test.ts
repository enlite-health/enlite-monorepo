/**
 * template-drafts.e2e.test.ts @integration — spec 010, F2 passos 2.1 e 2.2
 *
 * PONTA A PONTA contra a API real (Docker, USE_MOCK_AUTH) + Postgres real.
 * Sem mock: nem do banco, nem da rota. O contrato da rota só o e2e enxerga
 * (D188) — o unitário mocka o pool e não veria coluna com nome errado, índice
 * parcial que não existe, ou `version + 1` que não incrementa de verdade.
 *
 * O que prova:
 *   1. salvar GRAVA mesmo — e o `ar_`/`br_` é derivado do idioma, não digitado;
 *   2. a trava otimista funciona CONTRA O BANCO: versão velha devolve 409 e o
 *      texto de quem gravou antes continua lá, intacto;
 *   3. o índice parcial deixa reusar o slug de um rascunho ARQUIVADO;
 *   4. colisão com template VIVO é distinguida da colisão com outro rascunho;
 *   5. escrita exige admin; leitura basta staff;
 *   6. 🔒 NÃO existe rota de submissão — F2 2.3/2.4 dependem do `lex`.
 *
 * Nenhuma saída para a rede: rascunho é gravação interna, e só.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PREFIXO = 'td_e2e_';
const SLUG_VIVO = 'ar_td_e2e_template_vivo';
/** SID FALSO de propósito: nada aqui pode existir na conta real da Twilio. */
const SID_VIVO = 'HXfaketd11111111111111111111111111';

function mockToken(uid: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
}

const corpo = (over: Record<string, unknown> = {}) => ({
  slug: `${PREFIXO}bienvenida`,
  name: 'Bienvenida E2E',
  body: 'Hola {{1}}, te esperamos el {{2}} en la entrevista.',
  category: 'UTILITY',
  language: 'es-AR',
  ...over,
});

describe('Rascunho de mensagem (spec 010 F2 2.1/2.2) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const asAdmin = { headers: { Authorization: `Bearer ${mockToken('td-admin-uid', 'admin')}` } };
  const asRecruiter = { headers: { Authorization: `Bearer ${mockToken('td-recruiter-uid', 'recruiter')}` } };

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM message_template_drafts WHERE slug LIKE $1`, [`%${PREFIXO}%`]);
    await pool.query(`DELETE FROM message_templates WHERE slug = $1`, [SLUG_VIVO]);
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  beforeEach(async () => { await limpar(); });

  it('salva o rascunho DE VERDADE, e o prefixo do idioma é derivado', async () => {
    const r = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.draft.slug).toBe(`ar_${PREFIXO}bienvenida`);
    expect(r.data.data.draft.status).toBe('draft');
    expect(r.data.data.draft.version).toBe(1);

    // A prova é o BANCO, não a resposta: resposta pode mentir, linha não.
    const q = await pool.query(
      `SELECT slug, body, created_by, version FROM message_template_drafts WHERE slug = $1`,
      [`ar_${PREFIXO}bienvenida`],
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].body).toContain('{{1}}');
    expect(q.rows[0].created_by).toBe('td-admin-uid');
  });

  it('pt-BR ganha o prefixo br_ — o mesmo texto convive nos dois idiomas', async () => {
    await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const r = await api.post('/api/admin/template-drafts', corpo({ language: 'pt-BR' }), asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.draft.slug).toBe(`br_${PREFIXO}bienvenida`);

    const q = await pool.query(`SELECT slug FROM message_template_drafts WHERE slug LIKE $1 ORDER BY slug`, [`%${PREFIXO}%`]);
    expect(q.rows.map((x) => x.slug)).toEqual([`ar_${PREFIXO}bienvenida`, `br_${PREFIXO}bienvenida`]);
  });

  it('a lista devolve o que foi salvo, e só o não arquivado', async () => {
    const criado = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const id = criado.data.data.draft.id;

    const antes = await api.get('/api/admin/template-drafts', asRecruiter);
    expect(antes.data.data.drafts.map((d: { id: string }) => d.id)).toContain(id);

    await api.delete(`/api/admin/template-drafts/${id}`, asAdmin);

    const depois = await api.get('/api/admin/template-drafts', asRecruiter);
    expect(depois.data.data.drafts.map((d: { id: string }) => d.id)).not.toContain(id);

    // Arquivar NÃO apaga: o texto escrito continua no banco.
    const q = await pool.query(`SELECT archived_at FROM message_template_drafts WHERE id = $1`, [id]);
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].archived_at).not.toBeNull();
  });

  it('🔒 a trava otimista segura CONTRA O BANCO: versão velha não sobrescreve', async () => {
    const criado = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const id = criado.data.data.draft.id;

    const primeira = await api.put(`/api/admin/template-drafts/${id}`,
      corpo({ name: 'Primeira gravação', version: 1 }), asAdmin);
    expect(primeira.status).toBe(200);
    expect(primeira.data.data.draft.version).toBe(2);

    // Segunda pessoa, ainda com a versão 1 na mão.
    const segunda = await api.put(`/api/admin/template-drafts/${id}`,
      corpo({ name: 'Segunda gravação', version: 1 }), asAdmin);
    expect(segunda.status).toBe(409);
    expect(segunda.data.error).toBe('versao_desatualizada');
    expect(segunda.data.versaoAtual).toBe(2);

    // O trabalho da primeira pessoa continua lá.
    const q = await pool.query(`SELECT name, version FROM message_template_drafts WHERE id = $1`, [id]);
    expect(q.rows[0].name).toBe('Primeira gravação');
    expect(q.rows[0].version).toBe(2);
  });

  it('404 ao editar rascunho que não existe — nunca 200 sem gravar', async () => {
    const r = await api.put('/api/admin/template-drafts/11111111-1111-4111-8111-111111111111',
      corpo({ version: 1 }), asAdmin);
    expect(r.status).toBe(404);
    expect(r.data.error).toBe('draft_nao_encontrado');
  });

  it('o índice PARCIAL deixa reusar o slug de um rascunho arquivado', async () => {
    const a = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const dup = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    expect(dup.status).toBe(409);
    expect(dup.data.error).toBe('slug_em_uso_por_rascunho');

    await api.delete(`/api/admin/template-drafts/${a.data.data.draft.id}`, asAdmin);

    const depois = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    expect(depois.status).toBe(201);
  });

  it('colisão com template VIVO é distinguida da colisão com rascunho', async () => {
    await pool.query(
      `INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
       VALUES ($1, $1, 'x', 'UTILITY', true, $2)`,
      [SLUG_VIVO, SID_VIVO],
    );
    const r = await api.post('/api/admin/template-drafts', corpo({ slug: 'td_e2e_template_vivo' }), asAdmin);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('slug_em_uso_por_template_vivo');
  });

  it('422 nomeia as regras violadas, e NADA é gravado', async () => {
    const r = await api.post('/api/admin/template-drafts', corpo({ body: '{{1}}{{2}}' }), asAdmin);
    expect(r.status).toBe(422);
    const regras = r.data.problemas.map((p: { regra: string }) => p.regra);
    expect(regras).toEqual(expect.arrayContaining(['placeholder_no_inicio', 'placeholder_no_fim', 'placeholders_adjacentes']));

    const q = await pool.query(`SELECT 1 FROM message_template_drafts WHERE slug LIKE $1`, [`%${PREFIXO}%`]);
    expect(q.rowCount).toBe(0);
  });

  it('escrita exige ADMIN; leitura basta staff', async () => {
    expect((await api.get('/api/admin/template-drafts', asRecruiter)).status).toBe(200);
    expect((await api.post('/api/admin/template-drafts', corpo(), asRecruiter)).status).toBe(403);

    const criado = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const id = criado.data.data.draft.id;
    expect((await api.put(`/api/admin/template-drafts/${id}`, corpo({ version: 1 }), asRecruiter)).status).toBe(403);
    expect((await api.delete(`/api/admin/template-drafts/${id}`, asRecruiter)).status).toBe(403);
  });

  it('sem token, nada', async () => {
    expect((await api.get('/api/admin/template-drafts')).status).toBe(401);
    expect((await api.post('/api/admin/template-drafts', corpo())).status).toBe(401);
  });

  it('🔒 NÃO existe rota de submissão à Meta — o portão do lex, verificado', async () => {
    const criado = await api.post('/api/admin/template-drafts', corpo(), asAdmin);
    const id = criado.data.data.draft.id;
    for (const p of ['submit', 'submeter', 'publish', 'enviar']) {
      const r = await api.post(`/api/admin/template-drafts/${id}/${p}`, {}, asAdmin);
      expect(r.status).toBe(404);
    }
  });
});
