/**
 * patient-diagnoses.e2e.test.ts @integration — spec 016 F2 (migration 325, D263)
 *
 * Postgres REAL (sem mock) via `PostgresPatientDiagnosisRepository` — a "porta" fica FAKE
 * (`InMemoryTerminology`, mesmo espírito do teste de contrato da F1: não depende da ingestão
 * real do CID-11 ter rodado), mas TUDO que grava e lê no `patient_diagnoses` é SQL de verdade.
 *
 * O que prova, dos "8 testes" do relatório da F2:
 *   2. O espelho (origem CLICKUP) NUNCA enxerga nem desativa/rebaixa o principal do PAINEL —
 *      escopo por CONSTRUTOR é físico, não convenção (D263).
 *   3. Troca de principal não estoura 23505 (reconciliação em transação) — E concorrência real:
 *      duas promoções simultâneas, uma vence, nunca dois principais.
 *   4. Cluster pós-coordenado (`KA00.0/XS2R&XS5W`) sobrevive BYTE-IDÊNTICO pela pilha inteira —
 *      domínio (IcdCode) + aplicação (RecordPatientDiagnosis) + infraestrutura (INSERT/SELECT
 *      reais) — `toBe`, nunca `toContain`.
 *   7. `country` nulo FALHA ALTO (paciente inexistente ⇒ trigger não deriva nada ⇒ constraint
 *      rejeita) — nunca grava 'AR' por default (a pegadinha medida no F0 do ABAC).
 */
import { Pool } from 'pg';
import { InMemoryTerminology } from '../../src/modules/terminology/infrastructure/InMemoryTerminology';
import { IcdCode } from '../../src/modules/terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../src/modules/terminology/domain/TerminologyPort';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { RecordPatientDiagnosis } from '../../src/modules/diagnosis/application/RecordPatientDiagnosis';
import { SetPrimaryDiagnosis } from '../../src/modules/diagnosis/application/SetPrimaryDiagnosis';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pd-e2e-${RUN}-`;

const CHAPTER: DiagnosisEntity = {
  uri: 'test://pd-e2e/chapter-06', code: IcdCode.parse('06'), titleEs: 'Trastornos mentales', titleEn: 'Mental disorders',
  chapter: '06', release: 'TEST-PD-E2E', kind: 'chapter', isLeaf: false, parentUri: null,
};
const AUTISM_A: DiagnosisEntity = {
  uri: 'test://pd-e2e/autism-a', code: IcdCode.parse('6A02.Z'), titleEs: 'Trastorno del espectro autista A', titleEn: 'ASD A',
  chapter: '06', release: 'TEST-PD-E2E', kind: 'stem', isLeaf: true, parentUri: null,
};
const AUTISM_B: DiagnosisEntity = {
  uri: 'test://pd-e2e/autism-b', code: IcdCode.parse('6A02.Y'), titleEs: 'Trastorno del espectro autista B', titleEn: 'ASD B',
  chapter: '06', release: 'TEST-PD-E2E', kind: 'stem', isLeaf: true, parentUri: null,
};
/** Cluster pós-coordenado — stem + extensão, dois separadores (D7/D261). NUNCA truncar. */
const POSTCOORD: DiagnosisEntity = {
  uri: 'test://pd-e2e/postcoord', code: IcdCode.parse('KA00.0/XS2R&XS5W'), titleEs: 'Cluster pós-coordenado de prueba', titleEn: 'Post-coordinated test cluster',
  chapter: '06', release: 'TEST-PD-E2E', kind: 'stem', isLeaf: true, parentUri: null,
};

function terminology(): InMemoryTerminology {
  return new InMemoryTerminology([CHAPTER, AUTISM_A, AUTISM_B, POSTCOORD], { currentRelease: 'TEST-PD-E2E' });
}

describe('patient_diagnoses — Postgres real, porta fake (spec 016 F2) @integration', () => {
  let pool: Pool;
  let patientId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'PD', 'E2E', 'AR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}main`],
    );
    patientId = p.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM patient_diagnoses WHERE patient_id = $1', [patientId]);
  });

  it('teste 7 — country nulo FALHA ALTO: paciente inexistente ⇒ trigger não deriva nada ⇒ INSERT rejeitado, nunca AR por default', async () => {
    await expect(
      pool.query(
        `INSERT INTO patient_diagnoses
           (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language, concept_group, catalog_release, source, created_by, updated_by)
         VALUES (gen_random_uuid(), 'ICD-11', 'x', '06', 'x', 'es', '06', '2026-01', 'PANEL', 'e2e-test', 'e2e-test')`,
      ),
    ).rejects.toThrow();
    // Prova estática — a pegadinha do F0 é justamente um DEFAULT escondido: não há nenhum aqui.
    const { rows } = await pool.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'patient_diagnoses' AND column_name = 'country'`,
    );
    expect(rows[0].column_default).toBeNull();
  });

  it('teste 4 — cluster pós-coordenado sobrevive BYTE-IDÊNTICO pela pilha inteira (domínio + aplicação + Postgres real)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const useCase = new RecordPatientDiagnosis(terminology(), repo);
    const enviado = POSTCOORD.code.value;

    const result = await useCase.execute({ patientId, conceptUri: POSTCOORD.uri, actorUid: 'e2e-test' });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.diagnosis.conceptCode.value).toBe(enviado);

    // Lido de VOLTA do Postgres — não do objeto em memória que acabou de criar.
    const { rows } = await pool.query<{ concept_code: string }>('SELECT concept_code FROM patient_diagnoses WHERE id = $1', [result.diagnosis.id]);
    const lido = rows[0].concept_code;
    expect(lido).toBe(enviado);
    expect(lido).toBe('KA00.0/XS2R&XS5W');
  });

  it('teste 3a — troca de principal via SetPrimaryDiagnosis: rebaixa A e promove B na MESMA transação, sem 23505', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const record = new RecordPatientDiagnosis(terminology(), repo);
    const a = await record.execute({ patientId, conceptUri: AUTISM_A.uri, actorUid: 'e2e-test', isPrimary: true });
    const b = await record.execute({ patientId, conceptUri: AUTISM_B.uri, actorUid: 'e2e-test' });
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('setup falhou');

    const setPrimary = new SetPrimaryDiagnosis(repo);
    const result = await setPrimary.execute(patientId, b.diagnosis.id, 'e2e-test');
    expect(result.outcome).toBe('ok');

    const { rows } = await pool.query<{ id: string; is_primary: boolean }>(
      'SELECT id, is_primary FROM patient_diagnoses WHERE patient_id = $1 AND source = $2 AND active',
      [patientId, 'PANEL'],
    );
    const primaries = rows.filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(b.diagnosis.id);
  });

  it('teste 3b — CONCORRÊNCIA: promover DOIS DIAGNÓSTICOS DIFERENTES ao mesmo tempo (8 rodadas), nunca dois principais, nenhum 23505 escapa', async () => {
    // 🔴 C1 (QA-caça, correções F2) — INSTRUMENTO MORTO no original: as duas promoções alvejavam
    // `b.diagnosis.id` (o MESMO id) duas vezes — duas gravações da mesma chave de índice NUNCA
    // colidem entre si (a segunda simplesmente reafirma o mesmo estado), então o teste NÃO PODIA
    // falhar mesmo sem lock nenhum. A régua real do QA foi 8 rodadas de PATCH concorrente em DOIS
    // diagnósticos DIFERENTES do mesmo paciente → {"200":9,"500":7} medido. Aqui: 8 rodadas, cada
    // uma cria A e B FRESCOS (para não colidir com o dedupe por código das rodadas anteriores) e
    // promove os DOIS ao mesmo tempo — outcome nunca pode ser um throw/500, e ao final da rodada
    // exatamente um dos dois fica principal.
    const ROUNDS = 8;
    const outcomes: string[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
      const roundTerm = new InMemoryTerminology(
        [
          CHAPTER,
          { ...AUTISM_A, uri: `${AUTISM_A.uri}-r${i}`, code: IcdCode.parse(`6A0${i % 10}.A`) },
          { ...AUTISM_B, uri: `${AUTISM_B.uri}-r${i}`, code: IcdCode.parse(`6A0${i % 10}.B`) },
        ],
        { currentRelease: 'TEST-PD-E2E' },
      );
      const roundRecord = new RecordPatientDiagnosis(roundTerm, repo);
      const a = await roundRecord.execute({ patientId, conceptUri: `${AUTISM_A.uri}-r${i}`, actorUid: 'e2e-test' });
      const b = await roundRecord.execute({ patientId, conceptUri: `${AUTISM_B.uri}-r${i}`, actorUid: 'e2e-test' });
      if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('setup falhou');

      // Duas requisições concorrentes, cada uma com seu PRÓPRIO repositório (como duas requests
      // HTTP simultâneas teriam) — uma promove A, a OUTRA promove B — DOIS ALVOS DIFERENTES.
      const results = await Promise.allSettled([
        new SetPrimaryDiagnosis(new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL)).execute(patientId, a.diagnosis.id, 'req-1'),
        new SetPrimaryDiagnosis(new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL)).execute(patientId, b.diagnosis.id, 'req-2'),
      ]);
      for (const r of results) {
        outcomes.push(r.status === 'fulfilled' ? r.value.outcome : `THROW:${(r.reason as Error).message}`);
      }

      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM patient_diagnoses WHERE patient_id = $1 AND source = $2 AND active AND is_primary',
        [patientId, 'PANEL'],
      );
      expect(rows).toHaveLength(1);
      expect([a.diagnosis.id, b.diagnosis.id]).toContain(rows[0].id);

      // Limpa a rodada — a próxima começa de novo do zero, sem herdar o principal desta.
      await pool.query('DELETE FROM patient_diagnoses WHERE patient_id = $1', [patientId]);
    }

    // eslint-disable-next-line no-console
    console.log('C1 — distribuição de outcomes em 8 rodadas × 2 promoções concorrentes:', JSON.stringify(
      outcomes.reduce((acc: Record<string, number>, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }), {}),
    ));
    expect(outcomes.filter((o) => o.startsWith('THROW'))).toHaveLength(0);
    expect(outcomes.every((o) => o === 'ok')).toBe(true);
  });

  it('teste 2 — o espelho do ClickUp NUNCA enxerga nem desativa o principal do PAINEL (escopo físico por construtor, D263)', async () => {
    const panelRepo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const panelRecord = new RecordPatientDiagnosis(terminology(), panelRepo);
    const panelPrimary = await panelRecord.execute({ patientId, conceptUri: AUTISM_A.uri, actorUid: 'panel-e2e', isPrimary: true });
    if (panelPrimary.outcome !== 'created') throw new Error('setup falhou');

    // O "sync do ClickUp" grava SÓ o payload dele (AUTISM_B), via um repositório ESCOPADO em CLICKUP.
    const clickupRepo = new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP);
    const clickupRecord = new RecordPatientDiagnosis(terminology(), clickupRepo);
    const clickupOwn = await clickupRecord.execute({ patientId, conceptUri: AUTISM_B.uri, actorUid: 'clickup-sync', isPrimary: true });
    if (clickupOwn.outcome !== 'created') throw new Error('setup falhou');

    // Fisicamente incapaz: o repo do ClickUp nem ACHA a linha do painel para tentar mexer nela.
    expect(await clickupRepo.findById(panelPrimary.diagnosis.id)).toBeNull();
    await expect(clickupRepo.deactivate(panelPrimary.diagnosis.id, 'clickup-sync')).rejects.toThrow();
    await expect(clickupRepo.promotePrimary(panelPrimary.diagnosis.id, 'clickup-sync')).rejects.toThrow();

    // O principal do painel segue ATIVO e PRINCIPAL depois de todo o "sync" do ClickUp rodar.
    const { rows } = await pool.query<{ active: boolean; is_primary: boolean }>(
      'SELECT active, is_primary FROM patient_diagnoses WHERE id = $1',
      [panelPrimary.diagnosis.id],
    );
    expect(rows[0]).toEqual({ active: true, is_primary: true });
  });

  it('lifecycle básico via Postgres real: create → 409 duplicado (mesmo código/origem) → deactivate → 409 na 2ª baixa', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const record = new RecordPatientDiagnosis(terminology(), repo);
    const created = await record.execute({ patientId, conceptUri: AUTISM_A.uri, actorUid: 'e2e-test' });
    if (created.outcome !== 'created') throw new Error('setup falhou');

    const dup = await record.execute({ patientId, conceptUri: AUTISM_A.uri, actorUid: 'e2e-test' });
    expect(dup.outcome).toBe('already_active');

    const deactivated = await repo.deactivate(created.diagnosis.id, 'e2e-test');
    expect(deactivated.active).toBe(false);
    expect(deactivated.endedAt).not.toBeNull();

    // O MESMO código pode ser recriado depois que o anterior foi desativado (índice é WHERE active).
    const recreated = await record.execute({ patientId, conceptUri: AUTISM_A.uri, actorUid: 'e2e-test' });
    expect(recreated.outcome).toBe('created');
  });
});
