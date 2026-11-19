/**
 * 096-home-vagas-perfil.e2e.test.ts @integration — spec 096 (CA-1, CA-3, CA-5, CA-6): `GET /api/workers/me/jobs` pela borda
 * (HTTP real + Postgres real; token de worker do mock auth). Sem `view` a resposta é a de sempre; com `view=home` só passa a vaga
 * que cabe no perfil (dia coberto + profissão + sexo), a de lista de profissões vazia entra, `center` vem arredondado e nenhuma
 * vaga devolve lat/lng. Massa sintética (paciente sobrenome " QA", prefixo `T096-`), apagada no afterAll com contagem 0.
 * Nenhum canal externo: só a API local e o banco do stack de teste.
 */
import { Pool } from 'pg';
import { AxiosInstance } from 'axios';
import { createApiClient, waitForBackend } from './helpers';
import {
  COMPLETE_AVAILABILITY,
  COMPLETE_SERVICE_AREA,
  createWorker,
  getWorkerToken,
  saveAvailability,
  saveServiceArea,
  type JourneyWorker,
} from './worker-onboarding-journey.helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PREFIXO = 'T096-';
const { lat: LAT0, lng: LNG0 } = COMPLETE_SERVICE_AREA;

interface Seed { rotulo: string; dLat: number; schedule: unknown; professions: string[]; sex: string | null }
const DIA = (dayOfWeek: number) => [{ dayOfWeek, startTime: '09:00', endTime: '13:00' }];
// Prestadora: dias 1 e 3 (COMPLETE_AVAILABILITY), ocupação AT, sexo F. Raio pedido: 10 km (0,01 grau ≈ 1,1 km).
const SEMENTES: Seed[] = [
  { rotulo: 'passa', dLat: 0.01, schedule: DIA(1), professions: ['AT'], sex: 'F' },
  { rotulo: 'dia-descoberto', dLat: 0.012, schedule: DIA(5), professions: ['AT'], sex: null },
  { rotulo: 'outra-profissao', dLat: 0.014, schedule: DIA(1), professions: ['CUIDADOR'], sex: null },
  { rotulo: 'exige-M', dLat: 0.016, schedule: DIA(1), professions: ['AT'], sex: 'M' },
  { rotulo: 'lista-vazia', dLat: 0.018, schedule: DIA(3), professions: [], sex: null },
  { rotulo: 'fora-do-raio', dLat: 0.2, schedule: DIA(1), professions: ['AT'], sex: 'F' },
];

describe('096 home do prestador: vagas por raio com perfil de match @integration', () => {
  const api: AxiosInstance = createApiClient();
  let pool: Pool;
  let worker: JourneyWorker;
  let token: string;
  const ids: Record<string, string> = {};
  const patientIds: string[] = [];
  const bearer = () => ({ headers: { Authorization: `Bearer ${token}` } });

  const contagemDeTeste = async (): Promise<number> => {
    const r = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM patients WHERE clickup_task_id LIKE $1)::int
            + (SELECT count(*) FROM job_postings WHERE title LIKE $1)::int AS n`,
      [`${PREFIXO}%`],
    );
    return r.rows[0].n;
  };

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    worker = await createWorker(api, '096');
    token = await getWorkerToken(api, worker);
    await saveServiceArea(api, token);
    await saveAvailability(api, token);
    expect(COMPLETE_AVAILABILITY.map((a) => a.dayOfWeek)).toEqual([1, 3]);
    // sexo cifrado como o stack de teste cifra (KMS em passthrough = base64) e ocupação AT
    await pool.query(`UPDATE workers SET occupation = 'AT', sex_encrypted = $2 WHERE id = $1`, [
      worker.id,
      Buffer.from('FEMALE', 'utf8').toString('base64'),
    ]);
    for (const [i, s] of SEMENTES.entries()) {
      const pat = await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'T096', 'Paciente QA', 'AR', 'ACTIVE') RETURNING id`,
        [`${PREFIXO}pac-${i}-${Date.now()}`],
      );
      patientIds.push(pat.rows[0].id);
      const addr = await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, city, neighborhood, lat, lng) VALUES ($1, 'Buenos Aires', $2, $3, $4) RETURNING id`,
        [pat.rows[0].id, `Barrio ${s.rotulo}`, LAT0 + s.dLat, LNG0],
      );
      const job = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, country, status, patient_id, case_number, patient_address_id, schedule,
                                   required_professions, required_sex, is_draft, is_test, social_short_links)
         VALUES ($1, 'AR', 'SEARCHING', $2, $3, $4, $5::jsonb, $6::text[], $7, false, false, '{"site":"https://exemplo.invalid"}'::jsonb)
         RETURNING id`,
        [`${PREFIXO}${s.rotulo}`, pat.rows[0].id, 960000 + i, addr.rows[0].id, JSON.stringify(s.schedule), s.professions, s.sex],
      );
      ids[s.rotulo] = job.rows[0].id;
    }
  }, 90000);

  afterAll(async () => {
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [worker.id]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PREFIXO}%`]);
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1::uuid[])`, [patientIds]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIXO}%`]);
    await pool.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [worker.id]).catch(() => {});
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [worker.id]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = $1`, [worker.id]).catch(() => {});
    expect(await contagemDeTeste()).toBe(0);
    await pool.end();
  });

  it('CA-1 sem view: as 5 vagas do raio (todas), sem center nem applied, como sempre', async () => {
    const r = await api.get('/api/workers/me/jobs?radius_km=10', bearer());
    expect(r.status).toBe(200);
    expect(Object.keys(r.data)).toEqual(['items']);
    const meus = r.data.items.filter((i: { id: string }) => Object.values(ids).includes(i.id));
    expect(meus.map((i: { id: string }) => i.id).sort()).toEqual(
      ['passa', 'dia-descoberto', 'outra-profissao', 'exige-M', 'lista-vazia'].map((k) => ids[k]).sort(),
    );
  });

  it('CA-5 view=home: só passa a que cabe no perfil (a de lista vazia entra); center arredondado a 3 casas; applied todos true', async () => {
    const r = await api.get('/api/workers/me/jobs?radius_km=10&view=home', bearer());
    expect(r.status).toBe(200);
    const meus = r.data.items.filter((i: { id: string }) => Object.values(ids).includes(i.id));
    expect(meus.map((i: { id: string }) => i.id).sort()).toEqual([ids['passa'], ids['lista-vazia']].sort());
    expect(r.data.center).toEqual({ lat: Math.round(LAT0 * 1000) / 1000, lng: Math.round(LNG0 * 1000) / 1000 });
    expect(r.data.applied).toEqual({ schedule: true, profession: true, sex: true });
  });

  it('CA-3/CA-6 nenhum item devolve lat/lng/endereço/sexo; chaves fechadas', async () => {
    const r = await api.get('/api/workers/me/jobs?radius_km=100&view=home', bearer());
    const proibidas = ['lat', 'lng', 'latitude', 'longitude', 'address_formatted', 'required_sex', 'sex', 'phone'];
    for (const item of r.data.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['already_applied', 'case_number', 'city', 'distance_km', 'id', 'neighborhood', 'schedule', 'service', 'state', 'title', 'vacancy_number', 'worker_type'].sort(),
      );
      for (const k of proibidas) expect(item).not.toHaveProperty(k);
    }
    expect(Object.keys(r.data).sort()).toEqual(['applied', 'center', 'items']);
  });

  it('view desconhecido é ignorado (não é erro): resposta igual à sem view', async () => {
    const r = await api.get('/api/workers/me/jobs?radius_km=10&view=qualquer', bearer());
    expect(r.status).toBe(200);
    expect(Object.keys(r.data)).toEqual(['items']);
  });
});
