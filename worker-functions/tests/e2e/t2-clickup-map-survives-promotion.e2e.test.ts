/**
 * 🔧 F5-CORREÇÃO T2 (QA-caça, 05/09/2026) — O MAPA DO CLICKUP MORRIA NO DIA DA PRIMEIRA PROMOÇÃO.
 *
 * A migration 327 gravou `concept_uri` com o release ENCRAVADO no path
 * (`http://id.who.int/icd/release/11/2026-01/mms/...`), e quem resolve —
 * `RecordPatientDiagnosis` → `TerminologyPort.getByUri` — filtrava pelo release CORRENTE. Depois
 * de promover um release novo, os 8 mapeamentos paravam de resolver DE UMA VEZ.
 *
 * E em silêncio: a busca da operadora continuava funcionando (a URI dela vem do release
 * corrente), então NADA na tela indicava avaria; o espelho logava `info`, o webhook devolvia
 * 200, e NENHUMA linha de rejeição era gravada (`recordUnmapped` só roda no ramo "rótulo sem
 * linha no mapa" — e a linha estava lá, era a RESOLUÇÃO que falhava).
 *
 * Este teste exercita o CAMINHO DE PRODUÇÃO INTEIRO, em processo, contra o Postgres real:
 *   ClickUpDiagnosisLabelRepository (lê o mapa)
 *     → ClickUpDiagnosisMapper (Adapter, escopado a CLICKUP por construtor)
 *       → PatientDiagnosisService (Facade)
 *         → RecordPatientDiagnosis → IcdCatalogTerminology → patient_diagnoses
 *
 * ⚠️ Em processo, não por HTTP: o container `enlite-api` roda imagem ANTERIOR e não exercitaria
 * este código.
 */
import { Pool } from 'pg';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { PatientDiagnosisService } from '../../src/modules/diagnosis/application/PatientDiagnosisService';
import { ClickUpDiagnosisLabelRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisLabelRepository';
import { ClickUpDiagnosisRejectionRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisRejectionRepository';
import { ClickUpDiagnosisMapper } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RELEASE_OLD = 'TEST-T2MAP-OLD';
const RELEASE_NEW = 'TEST-T2MAP-NEW';
const LABEL = 'T2D-Psicosis';
const ENTITY_ID = '405565289/unspecified';
const CHAPTER_ID = '900000088';
const uriEm = (release: string, id: string) => `http://id.who.int/icd/release/11/${release}/mms/${id}`;

describe('T2 — o mapa do ClickUp continua resolvendo depois de promover um release @integration', () => {
  let pool: Pool;
  let patientId = '';
  let releaseCorrenteAntes: string | null = null;

  async function seedEntidade(release: string, id: string, code: string, kind: string): Promise<void> {
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, $3, $4, NULL, '88', NULL, $5, $6)
       ON CONFLICT (icd_uri, release) DO UPDATE SET title_es = EXCLUDED.title_es`,
      [uriEm(release, id), release, code, `T2D ${code} (${release})`, kind, kind === 'stem'],
    );
  }

  async function promover(release: string): Promise<void> {
    await pool.query(
      `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`,
    );
    await pool.query(
      `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'T2D' WHERE release = $1`,
      [release],
    );
  }

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM patient_source_label_rejections WHERE raw_label LIKE 'T2D-%'`).catch(() => undefined);
    await pool.query(
      `DELETE FROM patient_diagnoses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'T2D-t2map-%')`,
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'T2D-t2map-%'`);
    await pool.query(`DELETE FROM clickup_diagnosis_labels WHERE label LIKE 'T2D-%'`);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    releaseCorrenteAntes =
      (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current`)).rows[0]
        ?.release ?? null;
    await limpar();

    await pool.query(
      `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 2), ($2, 2) ON CONFLICT DO NOTHING`,
      [RELEASE_OLD, RELEASE_NEW],
    );
    // O MESMO conceito, publicado nos dois releases — com URI DIFERENTE, como a OMS faz.
    for (const release of [RELEASE_OLD, RELEASE_NEW]) {
      await seedEntidade(release, CHAPTER_ID, '88', 'chapter');
      await seedEntidade(release, ENTITY_ID, 'ZM01', 'stem');
    }
    // O mapa aponta para a URI do release ANTIGO — exatamente como a migration 327 gravou.
    await pool.query(
      `INSERT INTO clickup_diagnosis_labels (source, label, concept_uri, active) VALUES ('clickup', $1, $2, true)`,
      [LABEL, uriEm(RELEASE_OLD, ENTITY_ID)],
    );
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ('T2D-t2map-1', 'T2D', 'Mapa QA', 'AR', 'ACTIVE') RETURNING id`,
      )
    ).rows[0].id;

    await promover(RELEASE_OLD);
  });

  afterAll(async () => {
    await limpar();
    if (releaseCorrenteAntes) await promover(releaseCorrenteAntes);
    await pool.end();
  });

  function mapper(): ClickUpDiagnosisMapper {
    return new ClickUpDiagnosisMapper(
      new ClickUpDiagnosisLabelRepository(),
      new ClickUpDiagnosisRejectionRepository(),
      new PatientDiagnosisService(
        new IcdCatalogTerminology(),
        new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP),
      ),
    );
  }

  it('ANTES da promoção (release do mapa é o corrente): o espelho grava normalmente — controle positivo', async () => {
    const out = await mapper().syncFromLabel(patientId, LABEL);
    expect(out).toEqual({ kind: 'synced', outcome: 'created' });

    const { rows } = await pool.query<{ catalog_release: string; concept_uri: string }>(
      `SELECT catalog_release, concept_uri FROM patient_diagnoses WHERE patient_id = $1 AND active`,
      [patientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].catalog_release).toBe(RELEASE_OLD);
  });

  it('DEPOIS de promover o release novo, a MESMA URI do mapa continua resolvendo (antes: concept_not_resolved)', async () => {
    // Zera o diagnóstico do controle para o cenário ficar limpo.
    await pool.query(`DELETE FROM patient_diagnoses WHERE patient_id = $1`, [patientId]);
    await promover(RELEASE_NEW);

    const out = await mapper().syncFromLabel(patientId, LABEL);

    expect(out).toEqual({ kind: 'synced', outcome: 'created' });
  });

  it('o diagnóstico gravado aponta para o release NOVO — o dado nasce atual, não preso a 2026-01', async () => {
    const { rows } = await pool.query<{ catalog_release: string; concept_uri: string; concept_code: string }>(
      `SELECT catalog_release, concept_uri, concept_code FROM patient_diagnoses WHERE patient_id = $1 AND active`,
      [patientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].catalog_release).toBe(RELEASE_NEW);
    expect(rows[0].concept_uri).toBe(uriEm(RELEASE_NEW, ENTITY_ID));
    expect(rows[0].concept_code).toBe('ZM01');
  });

  it('e NENHUMA linha de rejeição foi gravada — porque não houve rejeição, não porque ela é muda', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_source_label_rejections WHERE patient_id = $1`,
      [patientId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('CONTROLE NEGATIVO: rótulo cujo conceito NÃO existe no release novo continua NÃO resolvendo', async () => {
    await pool.query(
      `INSERT INTO clickup_diagnosis_labels (source, label, concept_uri, active) VALUES ('clickup', 'T2D-Aposentado', $1, true)`,
      [uriEm(RELEASE_OLD, '999999999')],
    );
    const out = await mapper().syncFromLabel(patientId, 'T2D-Aposentado');
    expect(out).toEqual({ kind: 'synced', outcome: 'concept_not_resolved' });
  });
});
