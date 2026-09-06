/**
 * 🔧 F5-CORREÇÃO T5 (QA-caça, 05/09/2026) — CORRIDA REAL no dedupe de diagnóstico.
 *
 * O defeito: `RecordPatientDiagnosis` fazia `findActiveByConceptCode` FORA de transação e o
 * `create` depois — TOCTOU clássico. Webhook do ClickUp que repete, ou duplo clique no painel:
 * os dois lados leem "não há linha ativa", os dois inserem, e o perdedor bate no SEGUNDO índice
 * único da migration 325 (`uq_patient_diagnoses_codigo_ativo_por_origem`, linhas 158-160), que
 * `isPrimaryUniqueViolation` NÃO reconhecia — o `23505` subia cru e virava **HTTP 500** em vez do
 * 409 `DIAGNOSIS_ALREADY_ACTIVE` que a mesma condição já tinha quando descoberta pela leitura.
 *
 * O conserto tem duas camadas, e este arquivo mede as duas:
 *   1. `lockForPatient` (`pg_advisory_xact_lock`, o padrão de 6 arquivos de `src/`) serializa a
 *      gravação por paciente: o perdedor ENXERGA a linha do vencedor e devolve `already_active`.
 *   2. Se ainda assim o banco barrar (escrita por fora do lock), o 23505 do dedupe é traduzido
 *      em `DuplicateActiveDiagnosisError` → outcome `duplicate_race` → 409, nunca 500.
 *
 * ⚠️ EM PROCESSO, contra o Postgres real — o container `enlite-api` roda imagem ANTERIOR, então
 * um e2e por HTTP não exercitaria este código. Cada "requisição" concorrente tem seu PRÓPRIO
 * repositório, como duas requests HTTP simultâneas teriam.
 */
import { Pool } from 'pg';
import { InMemoryTerminology } from '../../src/modules/terminology/infrastructure/InMemoryTerminology';
import { IcdCode } from '../../src/modules/terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../src/modules/terminology/domain/TerminologyPort';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { RecordPatientDiagnosis } from '../../src/modules/diagnosis/application/RecordPatientDiagnosis';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TASK_PREFIX = 'T2D-t5-conc-';
const ROUNDS = 10;

const CHAPTER: DiagnosisEntity = {
  uri: 'test://t5/chapter-06', code: IcdCode.parse('06'), titleEs: 'Trastornos mentales', titleEn: 'Mental disorders',
  chapter: '06', release: 'TEST-T5', kind: 'chapter', isLeaf: false, parentUri: null,
};

function conceito(i: number): DiagnosisEntity {
  return {
    uri: `test://t5/concept-${i}`,
    code: IcdCode.parse(`6A0${i % 10}.Z`),
    titleEs: `T2D concepto ${i}`,
    titleEn: null,
    chapter: '06',
    release: 'TEST-T5',
    kind: 'stem',
    isLeaf: true,
    parentUri: null,
  };
}

describe('T5 — dedupe sob concorrência real: 0 erros crus, nunca duas linhas ativas @integration', () => {
  let pool: Pool;
  let patientId = '';

  const limpar = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM patient_diagnoses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [`${TASK_PREFIX}%`],
    );
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [`${TASK_PREFIX}%`]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'T2D', 'Concurrencia QA', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}1`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it(`${ROUNDS} rodadas × 2 gravações CONCORRENTES do MESMO conceito: 0 erro cru, 0 linha duplicada`, async () => {
    const erros: string[] = [];
    const outcomes: Record<string, number> = {};

    for (let i = 0; i < ROUNDS; i++) {
      const entidade = conceito(i);
      const terminology = new InMemoryTerminology([CHAPTER, entidade]);
      // Dois "requests" simultâneos, cada um com seu PRÓPRIO repositório (e sua própria conexão).
      const req = () =>
        new RecordPatientDiagnosis(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL)).execute({
          patientId,
          conceptUri: entidade.uri,
          actorUid: 'T2D-conc',
          isPrimary: true,
        });

      const resultados = await Promise.allSettled([req(), req()]);
      for (const r of resultados) {
        if (r.status === 'rejected') {
          erros.push(`${(r.reason as Error).name}: ${(r.reason as Error).message}`);
        } else {
          outcomes[r.value.outcome] = (outcomes[r.value.outcome] ?? 0) + 1;
        }
      }

      // Invariante do banco: NUNCA duas linhas ativas do mesmo código na mesma origem.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM patient_diagnoses
          WHERE patient_id = $1 AND source = 'PANEL' AND concept_code = $2 AND active`,
        [patientId, entidade.code.value],
      );
      expect(Number(rows[0].n)).toBe(1);
    }

    // A trava: nenhum erro escapou. Um erro cru aqui É o HTTP 500 do defeito.
    expect(erros).toEqual([]);

    // Contagem zero é falha, nunca sucesso: o teste tem de ter EXERCITADO as duas pontas.
    expect(outcomes.created).toBe(ROUNDS);
    expect((outcomes.already_active ?? 0) + (outcomes.duplicate_race ?? 0)).toBe(ROUNDS);
  }, 60000);

  it('o perdedor da corrida NUNCA cria uma 2ª linha ativa — 1 linha por conceito, ROUNDS conceitos', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_diagnoses WHERE patient_id = $1 AND active`,
      [patientId],
    );
    expect(Number(rows[0].n)).toBe(ROUNDS);
  });

  it('e continua havendo NO MÁXIMO um principal ativo por origem, mesmo com isPrimary:true em todas', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_diagnoses
        WHERE patient_id = $1 AND source = 'PANEL' AND is_primary AND active`,
      [patientId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
