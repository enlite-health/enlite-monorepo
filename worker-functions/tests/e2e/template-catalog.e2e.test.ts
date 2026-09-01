/**
 * template-catalog.e2e.test.ts @integration — spec 010, F1
 *
 * PONTA A PONTA contra a API real (Docker, USE_MOCK_AUTH) + Postgres real.
 * Sem mock nenhum: nem do banco, nem da rota, nem do repositório. O que este
 * arquivo prova é o CONTRATO da rota, que só o e2e enxerga (D188) — os testes
 * unitários do controller mockam o pool e por isso não veriam um erro de SQL,
 * uma coluna com nome errado ou uma junção que não existe.
 *
 * O que prova:
 *   1. a rota devolve o texto APROVADO e NÃO devolve `body` (contrato de envio);
 *   2. PAUSED chega até a resposta — é o estado que hoje some do sync (FILA B1);
 *   3. nunca verificado chega como `null`, não como "pendente" inventado;
 *   4. aprovado na Meta E inelegível para etapa convivem, em campos separados;
 *   5. "usado em" vem da junção real com funnel_stage_messages, e só a etapa LIGADA;
 *   6. leitura exige staff; NÃO existe rota de escrita (F2 depende do `lex`).
 *
 * Nenhuma saída para a rede: a rota é só leitura de banco.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** SIDs FALSOS, de propósito: nada aqui pode existir na conta real da Twilio. */
const SID_OK = 'HXfaketc11111111111111111111111111';
const SID_PAUSED = 'HXfaketc22222222222222222222222222';
const SID_NEW = 'HXfaketc33333333333333333333333333';
const SID_POS = 'HXfaketc44444444444444444444444444';

const SLUG_OK = 'tc_e2e_aprovada_em_uso';
const SLUG_PAUSED = 'tc_e2e_pausada';
const SLUG_NEW = 'tc_e2e_sem_verificar';
const SLUG_POS = 'tc_e2e_posicional';
const SLUGS = [SLUG_OK, SLUG_PAUSED, SLUG_NEW, SLUG_POS];

function mockToken(uid: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
}

describe('Catálogo de plantillas (spec 010 F1) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const asAdmin = { headers: { Authorization: `Bearer ${mockToken('tc-admin-uid', 'admin')}` } };
  const asRecruiter = { headers: { Authorization: `Bearer ${mockToken('tc-recruiter-uid', 'recruiter')}` } };

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO message_templates (slug, name, body, body_twilio, category, is_active, content_sid,
                                      meta_approval_status, meta_approval_reason, meta_approval_detail, meta_approval_checked_at)
       VALUES
         ($1,$1,'Hola {{worker_name}}','Hola {{1}}','UTILITY',true,$5,'APPROVED',NULL,NULL,NOW()),
         ($2,$2,'Hola {{worker_name}}','Hola {{1}}','UTILITY',true,$6,'PAUSED','NONE',NULL,NOW()),
         ($3,$3,'Hola','Hola','UTILITY',true,$7,NULL,NULL,NULL,NULL),
         ($4,$4,'Hola {{1}} en {{2}}','Hola {{1}} en {{2}}','UTILITY',true,$8,'REJECTED','INVALID_FORMAT',
          'Parámetros pegados uno al otro.',NOW())`,
      [SLUG_OK, SLUG_PAUSED, SLUG_NEW, SLUG_POS, SID_OK, SID_PAUSED, SID_NEW, SID_POS],
    );

    // Uma etapa LIGADA e outra DESLIGADA no mesmo template: a junção tem de
    // trazer só a ligada.
    await pool.query(
      `INSERT INTO funnel_stage_messages (country, stage, template_slug, enabled)
       VALUES ('AR','SELECTED',$1,true), ('AR','CONFIRMED',$1,false)`,
      [SLUG_OK],
    );
  });

  afterAll(async () => { await limpar(); await pool.end(); });

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM funnel_stage_messages WHERE template_slug = ANY($1)`, [SLUGS]);
    await pool.query(`DELETE FROM message_templates WHERE slug = ANY($1)`, [SLUGS]);
  }

  async function buscar(): Promise<Record<string, Record<string, unknown>>> {
    const res = await api.get('/api/admin/template-catalog', asAdmin);
    expect(res.status).toBe(200);
    const lista = res.data.data.templates as Array<Record<string, unknown>>;
    return Object.fromEntries(lista.filter((t) => SLUGS.includes(t.slug as string)).map((t) => [t.slug as string, t]));
  }

  it('devolve o texto APROVADO e NÃO devolve o contrato de envio', async () => {
    const t = (await buscar())[SLUG_OK];
    expect(t.bodyTwilio).toBe('Hola {{1}}');
    // `body` divergiu do aprovado em 12 de 27 templates (mig 295) e já pôs um
    // sentinela na tela como se fosse mensagem. Não pode sair na resposta.
    expect(t).not.toHaveProperty('body');
  });

  it('PAUSED chega até a resposta — é o estado que some do sync hoje', async () => {
    expect((await buscar())[SLUG_PAUSED].metaStatus).toBe('PAUSED');
  });

  it('nunca verificado vem null, não "pendente" inventado', async () => {
    const t = (await buscar())[SLUG_NEW];
    expect(t.metaStatus).toBeNull();
    expect(t.metaCheckedAt).toBeNull();
  });

  it('aprovado na Meta e inelegível para etapa convivem em campos separados', async () => {
    const c = await buscar();
    expect(c[SLUG_OK].metaStatus).toBe('APPROVED');
    expect(c[SLUG_OK].eligible).toBe(true);
    // Posicional: a Meta aprovou, mas o sistema não sabe preencher os slots.
    expect(c[SLUG_POS].eligible).toBe(false);
    expect(c[SLUG_POS].ineligibleReason).toBeTruthy();
  });

  it('carrega motivo e explicação da recusa vindos do banco', async () => {
    const t = (await buscar())[SLUG_POS];
    expect(t.metaReason).toBe('INVALID_FORMAT');
    expect(t.metaDetail).toMatch(/pegados/);
  });

  it('"usado em" vem da junção REAL, e só com a etapa LIGADA', async () => {
    const c = await buscar();
    expect(c[SLUG_OK].usedInStages).toEqual(['SELECTED']);
    expect(c[SLUG_PAUSED].usedInStages).toEqual([]);
  });

  it('leitura é de staff — recruiter também lê o catálogo', async () => {
    const res = await api.get('/api/admin/template-catalog', asRecruiter);
    expect(res.status).toBe(200);
  });

  it('sem token não passa', async () => {
    const res = await api.get('/api/admin/template-catalog', { headers: {} });
    expect([401, 403]).toContain(res.status);
  });

  it('NÃO existe rota de escrita — criar/submeter é F2 e depende do lex', async () => {
    for (const chamar of [
      () => api.post('/api/admin/template-catalog', {}, asAdmin),
      () => api.put('/api/admin/template-catalog', {}, asAdmin),
      () => api.delete('/api/admin/template-catalog', asAdmin),
    ]) {
      const res = await chamar();
      expect([404, 405]).toContain(res.status);
    }
  });
});
