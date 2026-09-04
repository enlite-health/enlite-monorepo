/**
 * patient-diagnoses-api.e2e.test.ts @integration — spec 016 F2 (D263)
 *
 * Express real + `AdminPatientDiagnosesController`/`AdminTerminologySearchController` REAIS
 * (repositório Postgres real via DATABASE_URL) — só a autenticação é bypassada (como o teste de
 * fiação de rotas faz), porque o que se prova aqui é a FORMA da resposta HTTP, não o login.
 *
 * O que prova:
 *   5. "O código não aparece na resposta da API" — régua POSITIVA: percorre o JSON de
 *      GET/POST /patients/:id/diagnoses e assere que NENHUMA chave é code/chapter/release,
 *      NEM o valor do código aparece em lugar nenhum da resposta (não só as chaves óbvias).
 *   US-4 — GET /terminology/search devolve {uri,title} apenas, nunca code/chapter.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '../../src/modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '../../src/modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { PatientDiagnosisService } from '../../src/modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { InMemoryTerminology } from '../../src/modules/terminology/infrastructure/InMemoryTerminology';
import { IcdCode } from '../../src/modules/terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../src/modules/terminology/domain/TerminologyPort';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pd-api-e2e-${RUN}-`;

const AUTISM: DiagnosisEntity = {
  uri: 'test://pd-api-e2e/autism', code: IcdCode.parse('6A02.Z'), titleEs: 'Trastorno del espectro autista', titleEn: 'ASD',
  chapter: '06', release: 'TEST-PD-API-E2E', kind: 'stem', isLeaf: true, parentUri: null,
};
const CHAPTER: DiagnosisEntity = {
  uri: 'test://pd-api-e2e/chapter-06', code: IcdCode.parse('06'), titleEs: 'Trastornos mentales', titleEn: 'Mental disorders',
  chapter: '06', release: 'TEST-PD-API-E2E', kind: 'chapter', isLeaf: false, parentUri: null,
};

/** Toda chave presente em QUALQUER nível do objeto (percorrer o JSON inteiro, não só o topo). */
function allKeysDeep(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeysDeep(v, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      allKeysDeep(v, acc);
    }
  }
  return acc;
}

describe('API real das rotas de diagnóstico — REQ-21 (spec 016 F2) @integration', () => {
  let pool: Pool;
  let patientId = '';
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'PD', 'ApiE2E', 'AR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}main`],
    );
    patientId = p.id;

    const terminology = new InMemoryTerminology([AUTISM, CHAPTER], { currentRelease: 'TEST-PD-API-E2E' });
    const diagnosisService = new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL));
    const diagnosesController = new AdminPatientDiagnosesController(diagnosisService);
    const terminologyController = new AdminTerminologySearchController(terminology);

    app = express();
    app.use(express.json());
    app.get('/api/admin/patients/:id/diagnoses', (req, res) => diagnosesController.list(req, res));
    app.post('/api/admin/patients/:id/diagnoses', (req, res) => diagnosesController.create(req, res));
    app.patch('/api/admin/patients/:id/diagnoses/:did', (req, res) => diagnosesController.update(req, res));
    app.get('/api/admin/terminology/search', (req, res) => terminologyController.search(req, res));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  it('POST cria (201) e a resposta NÃO contém code/chapter/release em NENHUM nível — nem o valor do código aparece', async () => {
    const res = await request(app)
      .post(`/api/admin/patients/${patientId}/diagnoses`)
      .send({ conceptUri: AUTISM.uri, isPrimary: true });

    expect(res.status).toBe(201);
    const keys = allKeysDeep(res.body);
    for (const forbidden of ['code', 'chapter', 'release', 'conceptCode', 'conceptGroup', 'catalogRelease']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(AUTISM.code.value);
    expect(res.body.data).toMatchObject({ uri: AUTISM.uri, title: 'Trastorno del espectro autista', isPrimary: true, source: 'PANEL', active: true });
  });

  it('GET /patients/:id/diagnoses — mesma régua: nenhuma chave de vocabulário na LISTA', async () => {
    const res = await request(app).get(`/api/admin/patients/${patientId}/diagnoses`);
    expect(res.status).toBe(200);
    expect(res.body.data.diagnoses.length).toBeGreaterThan(0);
    const keys = allKeysDeep(res.body);
    for (const forbidden of ['code', 'chapter', 'release']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(AUTISM.code.value);
  });

  it('POST 422 quando a URI não resolve; 409 quando já ativo nesta origem; PATCH 404 cross-patient', async () => {
    const notResolved = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: 'http://nao-existe' });
    expect(notResolved.status).toBe(422);

    const dup = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: AUTISM.uri });
    expect(dup.status).toBe(409);

    const crossPatient = await request(app)
      .patch(`/api/admin/patients/${patientId}/diagnoses/11111111-1111-4111-8111-111111111111`)
      .send({ active: false });
    expect(crossPatient.status).toBe(404);
  });

  it('teste 6 — clinical_specialty SAIU do payload da admissão, mas a COLUNA e a view patients_ro seguem intactas (Postgres real)', async () => {
    const column = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'clinical_specialty') AS exists`,
    );
    expect(column.rows[0].exists).toBe(true);
    const view = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'patients_ro' AND column_name = 'clinical_specialty') AS exists`,
    );
    expect(view.rows[0].exists).toBe(true);
    // clinicalSegments é OUTRA coluna (migration 037) — não é assunto desta fase, e segue existindo.
    const segments = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'clinical_segments') AS exists`,
    );
    expect(segments.rows[0].exists).toBe(true);
  });

  it('GET /terminology/search — {uri,title} apenas, NUNCA code/chapter', async () => {
    const res = await request(app).get('/api/admin/terminology/search').query({ q: 'espectro', lang: 'es', chapters: '06' });
    expect(res.status).toBe(200);
    expect(res.body.data.candidates.length).toBeGreaterThan(0);
    const keys = allKeysDeep(res.body);
    expect(keys.has('code')).toBe(false);
    expect(keys.has('chapter')).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(AUTISM.code.value);
  });
});
