/**
 * 084-talentum-403.e2e.test.ts @integration — spec 084 F4/R13: a baixa TENTA pausar o projeto no Talentum e, quando o Talentum recusa
 * (403 = conta sem posse), a vaga cai na lista manual — nunca em silêncio — e o filtro `talentum_manual=true` a devolve.
 *
 * API real (container) + Postgres real + o cliente Talentum REAL apontado para o STUB local (porta 9914, `TALENTUM_API_BASE_URL`
 * do docker-compose.test.yml; o stub tem projeto OWNER e projeto VIEWER — escrita no VIEWER dá 403 como a v2 real). Nada sai para o
 * Talentum de verdade; o jest roda com a rede bloqueada.
 *
 * Provas:
 *  - baixa com projeto VIEWER → vaga fica `MANUAL_PAUSE` e entra em `GET /vacancies?talentum_manual=true` (mesmo estando DE_BAJA);
 *  - baixa com projeto OWNER → `PAUSED` e o projeto do stub fica PAUSED; FORA da lista manual;
 *  - vaga sem projeto → estado NULL (nada a pausar); fora da lista;
 *  - o ÚNICO estado possível logo após a baixa, antes da resposta do Talentum, é PENDING_PAUSE (gravado na MESMA transação): nunca NULL;
 *  - nenhum DELETE chegou ao Talentum (P7/R2).
 */
import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STUB_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
const STAMP = `084t-${Date.now()}`;

describe('Spec 084 F4 — Talentum recusa a pausa (403) → lista manual @integration', () => {
  const api = createApiClient();
  const stub = new TalentumV2Stub();
  let closeStub: () => Promise<void>;
  let pool: Pool;
  let token: string;
  let patientId: string;
  const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });
  let seq = 0;

  async function vaga(tag: string, projectId: string | null): Promise<string> {
    const vn = Math.floor(Math.random() * 900000) + 100000 + ++seq;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, case_number, title, status, patient_id, country, is_draft, is_test, talentum_project_id)
       VALUES ($1, 884500, $2, 'SEARCHING', $3, 'AR', false, false, $4) RETURNING id`,
      [vn, `${STAMP}-${tag}`, patientId, projectId],
    );
    return r.rows[0].id;
  }
  const estado = async (id: string): Promise<string | null> =>
    (await pool.query<{ s: string | null }>(`SELECT talentum_pause_state AS s FROM job_postings WHERE id = $1`, [id])).rows[0].s;

  async function esperar(id: string, final: string | null, ms = 20_000): Promise<string | null> {
    const t0 = Date.now();
    let s = await estado(id);
    while (s !== final && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 300));
      s = await estado(id);
    }
    return s;
  }

  beforeAll(async () => {
    closeStub = (await stub.serve(STUB_PORT)).close;
    await waitForBackend(api);
    token = await getMockToken(api, { uid: '084-talentum-admin', email: '084-talentum@e2e.local', role: 'admin' });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, STAMP);
    stub.seed({ _id: `${STAMP}-owner`, name: 'proj owner', myRole: 'OWNER' });
    stub.seed({ _id: `${STAMP}-viewer`, name: 'proj viewer', myRole: 'VIEWER' });
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (closeStub) await closeStub();
  });

  it('403 do Talentum: baixa conclui, vaga vai para MANUAL_PAUSE e o filtro talentum_manual=true a traz (mesmo DE_BAJA); OWNER vira PAUSED e fica fora', async () => {
    const vViewer = await vaga('viewer', `${STAMP}-viewer`);
    const vOwner = await vaga('owner', `${STAMP}-owner`);
    const vSemProjeto = await vaga('sem-projeto', null);

    const baja = await api.post('/api/admin/vacancies/baja', { vacancyIds: [vViewer, vOwner, vSemProjeto] }, auth());
    expect(baja.status).toBe(200); // a baixa NUNCA depende do Talentum

    // logo após a baixa o estado já NÃO é NULL para quem tem projeto (PENDING_PAUSE gravado na mesma transação, ou já o final)
    expect(['PENDING_PAUSE', 'MANUAL_PAUSE']).toContain(await estado(vViewer));
    expect(['PENDING_PAUSE', 'PAUSED']).toContain(await estado(vOwner));
    expect(await estado(vSemProjeto)).toBeNull();

    expect(await esperar(vViewer, 'MANUAL_PAUSE')).toBe('MANUAL_PAUSE');
    expect(await esperar(vOwner, 'PAUSED')).toBe('PAUSED');
    expect(stub.projects.get(`${STAMP}-owner`)!.status).toBe('PAUSED');
    expect(stub.projects.get(`${STAMP}-viewer`)!.status).toBe('IN_PROGRESS'); // o 403 não mexeu em nada

    const lista = await api.get(`/api/admin/vacancies?search=${STAMP}&talentum_manual=true&limit=50`, auth());
    expect(lista.status).toBe(200);
    const itens = lista.data.data as Array<{ id: string; statusRaw: string; talentumPauseState: string }>;
    expect(itens.map((i) => i.id)).toEqual([vViewer]);
    expect(itens[0]).toMatchObject({ statusRaw: 'DE_BAJA', talentumPauseState: 'MANUAL_PAUSE' });

    // R2/P7: o Talentum só viu PUT pause — nenhum DELETE
    expect(stub.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(stub.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/pause')).length).toBeGreaterThanOrEqual(2);
  });

  it('sem o filtro, a lista continua escondendo as baixadas (talentum_manual só abre a lista manual)', async () => {
    const lista = await api.get(`/api/admin/vacancies?search=${STAMP}&limit=50`, auth());
    expect((lista.data.data as unknown[]).length).toBe(0);
  });
});
