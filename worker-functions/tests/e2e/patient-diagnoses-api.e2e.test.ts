/**
 * patient-diagnoses-api.e2e.test.ts @integration — spec 016 F2 (D263)
 *
 * Express real + `AdminPatientDiagnosesController`/`AdminTerminologySearchController` REAIS
 * (repositório Postgres real via DATABASE_URL) — só a autenticação é bypassada (como o teste de
 * fiação de rotas faz), porque o que se prova aqui é a FORMA da resposta HTTP, não o login.
 *
 * 🔧 C6 (QA-caça, correções F2) — a "régua positiva" do REQ-21 usava fixtures `uri: 'test://…'`
 * e `release: 'TEST-…'`, strings CONSTRUÍDAS para não conter código nem release — a régua nunca
 * poderia acusar nada. Este arquivo passou a rodar contra o CATÁLOGO REAL (`IcdCatalogTerminology`,
 * release `2026-01`, 35.692 entidades ingeridas): `AUTISM` é `6A02.Z` de verdade
 * (kind=stem, "Trastorno del espectro autista, sin especificación"), `CHAPTER` é o capítulo `06`
 * de verdade. A asserção de "sem chave de vocabulário" agora roda sobre uma resposta que
 * PODERIA vazar o código real se a fronteira (DiagnosisPublicView) tivesse regredido.
 *
 * 🔧 Correção de FATO no relatório (não achado novo — registrada em relatorio-f2.md, marcando o
 * texto anterior como SUPERADO): `catalog_release` SAI do servidor DENTRO da `uri` (medido:
 * 35.692/35.692 URIs do release carregam "2026-01" no path, ex.:
 * "http://.../release/11/2026-01/mms/..."). Isso NÃO viola o REQ-21 — o requisito fala do CÓDIGO
 * e do SEGMENTO (chapter/concept_group), e a URI PRECISA sair para o cliente poder devolvê-la no
 * POST (é o valor opaco que ele reenvia). A régua abaixo por isso NÃO afirma "a uri não contém
 * 2026-01" — afirma que nenhuma CHAVE de vocabulário existe e que o CÓDIGO (`6A02.Z`) nunca
 * aparece em lugar nenhum do corpo, nem dentro de uma string maior.
 *
 * O que prova:
 *   5. "O código não aparece na resposta da API" — régua POSITIVA, agora contra dado REAL do
 *      catálogo: percorre o JSON de GET/POST /patients/:id/diagnoses e assere que NENHUMA chave
 *      é code/chapter/release/conceptCode/conceptGroup/catalogRelease, NEM o valor do código
 *      real (`6A02.Z`) aparece em lugar nenhum da resposta.
 *   C1 — HTTP real: N rodadas de PATCH {isPrimary:true} concorrente em DOIS diagnósticos
 *      DIFERENTES do mesmo paciente → 0 respostas 500, exatamente 1 principal ao final de cada
 *      rodada. Este é o nível em que o QA mediu originalmente {"200":9,"500":7}.
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
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pd-api-e2e-${RUN}-`;

// C6 — entidades REAIS do catálogo 2026-01 (medidas via psql, não inventadas):
//   6A02.Z  kind=stem       "Trastorno del espectro autista, sin especificación"
//   06      kind=chapter    "Trastornos mentales, del comportamiento y del neurodesarrollo"
//   XM0ZH6  kind=extension  "Plomo" (C3 — código de extensão, não é diagnóstico isolado)
const AUTISM_CODE = '6A02.Z';
const AUTISM_URI = 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified';
const CHAPTER_URI = 'http://id.who.int/icd/release/11/2026-01/mms/334423054';
const LEAD_EXTENSION_CODE = 'XM0ZH6';
const LEAD_EXTENSION_URI = 'http://id.who.int/icd/release/11/2026-01/mms/952670996';

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

describe('API real das rotas de diagnóstico — REQ-21 contra o CATÁLOGO REAL (spec 016 F2, C6) @integration', () => {
  let pool: Pool;
  let patientId = '';
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Garante que o release 2026-01 está CORRENTE — sem isso IcdCatalogTerminology.getByUri/
    // search lançam TerminologyUnavailableError (D2/D3: leitura sem release explícito resolve
    // sempre o CORRENTE). Estado local/sintético — nenhum dado de paciente real.
    await pool.query(
      `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'patient-diagnoses-api.e2e' WHERE release = '2026-01'`,
    );
    const { rows: releaseCheck } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = '2026-01'`,
    );
    if (releaseCheck[0].n < 30000) {
      throw new Error(`Catálogo real 2026-01 não está ingerido nesta base (${releaseCheck[0].n} linhas) — rode o ingestor antes deste teste.`);
    }

    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'PD', 'ApiE2E', 'AR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}main`],
    );
    patientId = p.id;

    const terminology = new IcdCatalogTerminology();
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

  it('POST cria (201) e a resposta NÃO contém code/chapter/release em NENHUM nível — nem o valor do código REAL (6A02.Z) aparece', async () => {
    const res = await request(app)
      .post(`/api/admin/patients/${patientId}/diagnoses`)
      .send({ conceptUri: AUTISM_URI, isPrimary: true });

    expect(res.status).toBe(201);
    const keys = allKeysDeep(res.body);
    for (const forbidden of ['code', 'chapter', 'release', 'conceptCode', 'conceptGroup', 'catalogRelease']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(AUTISM_CODE);
    expect(res.body.data).toMatchObject({ uri: AUTISM_URI, title: 'Trastorno del espectro autista, sin especificación', isPrimary: true, source: 'PANEL', active: true });
  });

  it('GET /patients/:id/diagnoses — mesma régua contra dado REAL: nenhuma chave de vocabulário na LISTA', async () => {
    const res = await request(app).get(`/api/admin/patients/${patientId}/diagnoses`);
    expect(res.status).toBe(200);
    expect(res.body.data.diagnoses.length).toBeGreaterThan(0);
    const keys = allKeysDeep(res.body);
    for (const forbidden of ['code', 'chapter', 'release']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(AUTISM_CODE);
  });

  it('C3 (QA-caça) — POST 422 quando a URI é o CAPÍTULO inteiro (kind=chapter), nunca 201; mensagem não ecoa código', async () => {
    const res = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: CHAPTER_URI });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONCEPT_NOT_DIAGNOSABLE');
    expect(JSON.stringify(res.body)).not.toContain(AUTISM_CODE);
  });

  it('C3 (QA-caça) — POST 422 quando a URI é um código de EXTENSÃO (kind=extension, "Plomo"), nunca 201; mensagem não ecoa código', async () => {
    const res = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: LEAD_EXTENSION_URI });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONCEPT_NOT_DIAGNOSABLE');
    expect(JSON.stringify(res.body)).not.toContain(LEAD_EXTENSION_CODE);
  });

  it('POST 422 quando a URI não resolve; 409 quando já ativo nesta origem; PATCH 404 cross-patient', async () => {
    const notResolved = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: 'http://nao-existe' });
    expect(notResolved.status).toBe(422);

    const dup = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: AUTISM_URI });
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

  it('GET /terminology/search — {uri,title} apenas, NUNCA code/chapter, contra o catálogo REAL', async () => {
    const res = await request(app).get('/api/admin/terminology/search').query({ q: 'espectro', lang: 'es', chapters: '06' });
    expect(res.status).toBe(200);
    expect(res.body.data.candidates.length).toBeGreaterThan(0);
    const keys = allKeysDeep(res.body);
    expect(keys.has('code')).toBe(false);
    expect(keys.has('chapter')).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(AUTISM_CODE);
  });

  describe('C1 (QA-caça) — corrida real por HTTP: PATCH {isPrimary:true} concorrente em DOIS diagnósticos DIFERENTES', () => {
    it('8 rodadas × 2 PATCH concorrentes → 0 respostas 500, exatamente 1 principal ao final de cada rodada', async () => {
      const ROUNDS = 8;
      const statusCounts: Record<number, number> = {};

      // 2×ROUNDS conceitos REAIS e DISTINTOS (kind=stem, capítulo 06), buscados DIRETO no
      // catálogo por SQL — determinístico, sem depender do `pg_trgm`/limiar de similaridade da
      // busca (que já é exercitado nos testes de `search` acima; aqui o que se mede é a
      // corrida de escrita, não a busca). Exclui explicitamente `AUTISM_URI` — já ativo para
      // este paciente desde o teste "POST cria" no topo do arquivo, o que daria 409
      // (already_active) em vez do 201 que o setup de cada rodada exige.
      const { rows: catalogRows } = await pool.query<{ icd_uri: string }>(
        `SELECT icd_uri FROM terminology.icd_entities
          WHERE kind = 'stem' AND chapter = '06' AND release = '2026-01' AND icd_uri <> $1
          ORDER BY code ASC LIMIT $2`,
        [AUTISM_URI, ROUNDS * 2],
      );
      const uris: string[] = catalogRows.map((r) => r.icd_uri);
      expect(uris.length).toBe(ROUNDS * 2);
      expect(new Set(uris).size).toBe(uris.length); // nenhuma URI repetida

      for (let i = 0; i < ROUNDS; i++) {
        const uriA = uris[i * 2];
        const uriB = uris[i * 2 + 1];
        const createdA = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: uriA });
        const createdB = await request(app).post(`/api/admin/patients/${patientId}/diagnoses`).send({ conceptUri: uriB });
        if (createdA.status !== 201 || createdB.status !== 201) {
          throw new Error(`setup da rodada ${i} falhou: A=${createdA.status} B=${createdB.status}`);
        }
        const didA: string = createdA.body.data.id;
        const didB: string = createdB.body.data.id;

        // As DUAS chamadas HTTP concorrentes, de verdade (Promise.all sobre supertest) —
        // exatamente a forma que o QA mediu originalmente.
        const [resA, resB] = await Promise.all([
          request(app).patch(`/api/admin/patients/${patientId}/diagnoses/${didA}`).send({ isPrimary: true }),
          request(app).patch(`/api/admin/patients/${patientId}/diagnoses/${didB}`).send({ isPrimary: true }),
        ]);
        for (const r of [resA, resB]) {
          statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
        }

        const { rows } = await pool.query<{ id: string }>(
          'SELECT id FROM patient_diagnoses WHERE patient_id = $1 AND source = $2 AND active AND is_primary',
          [patientId, 'PANEL'],
        );
        expect(rows).toHaveLength(1);
        expect([didA, didB]).toContain(rows[0].id);
      }

      // eslint-disable-next-line no-console
      console.log('C1 (HTTP real) — distribuição de status em 8 rodadas × 2 PATCH concorrentes:', JSON.stringify(statusCounts));
      expect(statusCounts[500]).toBeUndefined();
      expect(Object.keys(statusCounts).every((code) => Number(code) < 500)).toBe(true);
    }, 30000);
  });
});
