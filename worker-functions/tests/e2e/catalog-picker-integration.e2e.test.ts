/**
 * A MESMA mensagem vista pelas DUAS telas — a pergunta do Gabriel em 31/08:
 * "quando adiciona uma mensagem, ela aparece nas outras telas que usam ela?"
 *
 * Contra API e Postgres reais, sem mock.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SLUG_OK = 'integ_e2e_aprovada';
const SLUG_PAUSED = 'integ_e2e_pausada';
const SLUGS = [SLUG_OK, SLUG_PAUSED];
const tok = (uid: string, role: string) => 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');

describe('catálogo × mensajes-por-etapa: a mesma mensagem nas duas telas @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const asAdmin = { headers: { Authorization: `Bearer ${tok('integ-admin', 'admin')}` } };

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    // A semente das 9 etapas (migration 292). Se outra suíte a apagou, este
    // teste mediria a poluição do banco em vez do produto.
    await pool.query(
      `INSERT INTO funnel_stage_messages (country, stage, builtin) VALUES
         ('AR','INVITED',NULL),('AR','PRE_SCREENING',NULL),('AR','IN_PROGRESS',NULL),('AR','COMPLETED',NULL),
         ('AR','QUALIFIED','interview_invite'),('AR','IN_DOUBT',NULL),('AR','CONFIRMED',NULL),
         ('AR','SELECTED',NULL),('AR','REJECTED',NULL)
       ON CONFLICT (country, stage) DO NOTHING`);
    await limpar();
    await pool.query(
      `INSERT INTO message_templates (slug,name,body,body_twilio,category,is_active,content_sid,meta_approval_status,meta_approval_checked_at)
       VALUES ($1,$1,'Hola {{worker_name}}','Hola {{1}}','UTILITY',true,'HXinteg1111111111111111111111111','APPROVED',NOW()),
              ($2,$2,'Hola {{worker_name}}','Hola {{1}}','UTILITY',true,'HXinteg2222222222222222222222222','PAUSED',NOW())`,
      [SLUG_OK, SLUG_PAUSED]);
  });
  afterAll(async () => { await limpar(); await pool.end(); });
  async function limpar() {
    // ⚠️ NÃO apagar linha de funnel_stage_messages: as 9 etapas são SEMENTE da
    // migration 292, e o PUT do picker é UPDATE puro — sem a linha ele vira
    // no-op silencioso (devolve 200 e não grava). Apagar aqui envenena o banco
    // compartilhado para toda suíte seguinte. Desliga em vez de remover.
    await pool.query(`UPDATE funnel_stage_messages SET template_slug = NULL, enabled = false WHERE template_slug = ANY($1)`, [SLUGS]);
    await pool.query(`DELETE FROM message_templates WHERE slug = ANY($1)`, [SLUGS]);
  }
  const catalogo = async () => (await api.get('/api/admin/template-catalog', asAdmin)).data.data.templates as Array<Record<string, unknown>>;
  const picker = async () => (await api.get('/api/admin/funnel-stage-messages', asAdmin)).data.data;

  it('mensagem nova aparece NAS DUAS telas', async () => {
    expect((await catalogo()).map((t) => t.slug)).toContain(SLUG_OK);
    expect(((await picker()).templates as Array<Record<string, unknown>>).map((t) => t.slug)).toContain(SLUG_OK);
  });

  it('escolher a mensagem no picker faz o catálogo mostrar "usado em"', async () => {
    const put = await api.put(`/api/admin/funnel-stage-messages/SELECTED`, { template_slug: SLUG_OK, enabled: true }, asAdmin);
    expect(put.status).toBe(200);
    const linha = (await catalogo()).find((t) => t.slug === SLUG_OK)!;
    expect(linha.usedInStages).toEqual(['SELECTED']);
  });

  it('desligar a etapa tira o "usado em" do catálogo', async () => {
    await api.put(`/api/admin/funnel-stage-messages/SELECTED`, { template_slug: SLUG_OK, enabled: false }, asAdmin);
    expect((await catalogo()).find((t) => t.slug === SLUG_OK)!.usedInStages).toEqual([]);
  });

  it('as duas telas concordam sobre o texto aprovado', async () => {
    const c = (await catalogo()).find((t) => t.slug === SLUG_OK)!;
    const p = ((await picker()).templates as Array<Record<string, unknown>>).find((t) => t.slug === SLUG_OK)!;
    expect(c.bodyTwilio).toBe(p.bodyTwilio);
  });

  it('🔴 DISCORDÂNCIA: o catálogo diz PAUSED e o picker ainda oferece a mensagem', async () => {
    const c = (await catalogo()).find((t) => t.slug === SLUG_PAUSED)!;
    expect(c.metaStatus).toBe('PAUSED');
    const p = ((await picker()).templates as Array<Record<string, unknown>>).find((t) => t.slug === SLUG_PAUSED);
    expect(p).toBeDefined();
    expect(p!.eligible).toBe(true);
  });

  it('🔴 e o picker ACEITA pendurar numa etapa uma mensagem que a Meta desligou', async () => {
    const put = await api.put(`/api/admin/funnel-stage-messages/CONFIRMED`, { template_slug: SLUG_PAUSED, enabled: true }, asAdmin);
    expect(put.status).toBe(200);
  });
});
