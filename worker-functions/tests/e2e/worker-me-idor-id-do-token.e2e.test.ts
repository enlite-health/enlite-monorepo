/**
 * IDOR nas rotas "me" do prestador — o id do dono sai do TOKEN, nunca do corpo.
 *
 * Antes: PUT /api/workers/me/general-info, /me/service-area e /api/workers/step aceitavam
 * `workerId` no corpo (o do corpo vencia o do token), então o prestador A gravava na ficha do B.
 * Estes casos batem na API real (mock auth) e comparam o BANCO do B antes/depois.
 * Massa sintética (@e2e.test), apagada no afterAll. Nenhum canal externo.
 */
import { Pool } from 'pg';
import { AxiosInstance } from 'axios';
import { createApiClient, waitForBackend } from './helpers';
import {
  createWorker,
  getWorkerToken,
  makePersonalInfo,
  COMPLETE_SERVICE_AREA,
  type JourneyWorker,
} from './worker-onboarding-journey.helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Rotas me do prestador — workerId do corpo é ignorado (IDOR)', () => {
  const api: AxiosInstance = createApiClient();
  let pool: Pool;
  let a: JourneyWorker;
  let b: JourneyWorker;
  let tokenA: string;
  const stamp = `${Date.now()}`;

  const snapshotDe = async (workerId: string): Promise<string> => {
    const w = await pool.query('SELECT * FROM workers WHERE id = $1', [workerId]);
    const s = await pool.query('SELECT * FROM worker_service_areas WHERE worker_id = $1 ORDER BY id', [workerId]);
    return JSON.stringify({ worker: w.rows, areas: s.rows });
  };
  const bearer = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    a = await createWorker(api, `idorA-${stamp}`);
    b = await createWorker(api, `idorB-${stamp}`);
    tokenA = await getWorkerToken(api, a);
  }, 60000);

  afterAll(async () => {
    for (const w of [a, b]) {
      if (!w) continue;
      await pool.query('DELETE FROM worker_service_areas WHERE worker_id = $1', [w.id]).catch(() => {});
      await pool.query('DELETE FROM workers WHERE id = $1', [w.id]).catch(() => {});
    }
    await pool.end();
  });

  it('PUT /me/general-info: A com workerId do B no corpo → ficha do B intacta', async () => {
    const antes = await snapshotDe(b.id);
    const res = await api.put(
      '/api/workers/me/general-info',
      { ...makePersonalInfo(`1${stamp}`), workerId: b.id },
      bearer(),
    );
    expect(res.status).toBe(200);
    expect(await snapshotDe(b.id)).toBe(antes);
  });

  it('PUT /me/service-area: A com workerId do B no corpo → área do B intacta, a de A gravada', async () => {
    const antes = await snapshotDe(b.id);
    const res = await api.put('/api/workers/me/service-area', { ...COMPLETE_SERVICE_AREA, workerId: b.id }, bearer());
    expect(res.status).toBe(200);
    expect(await snapshotDe(b.id)).toBe(antes);
    const dela = await pool.query('SELECT count(*)::int AS n FROM worker_service_areas WHERE worker_id = $1', [a.id]);
    expect(dela.rows[0].n).toBeGreaterThan(0);
  });

  it('PUT /step passo 3: A com workerId do B (corpo e data) → área do B intacta', async () => {
    const antes = await snapshotDe(b.id);
    const res = await api.put(
      '/api/workers/step',
      { workerId: b.id, step: 3, data: { ...COMPLETE_SERVICE_AREA, workerId: b.id } },
      bearer(),
    );
    expect(res.status).toBe(200);
    expect(await snapshotDe(b.id)).toBe(antes);
  });

  it('PUT /step passo 2: A com workerId do B (corpo e data) → ficha do B intacta', async () => {
    const antes = await snapshotDe(b.id);
    const res = await api.put(
      '/api/workers/step',
      { workerId: b.id, step: 2, data: { ...makePersonalInfo(`2${stamp}`), workerId: b.id } },
      bearer(),
    );
    expect(res.status).toBe(200);
    expect(await snapshotDe(b.id)).toBe(antes);
  });
});
