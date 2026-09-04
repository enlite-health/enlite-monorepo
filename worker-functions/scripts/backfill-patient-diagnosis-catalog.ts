/**
 * backfill-patient-diagnosis-catalog.ts — spec 016 F4, Parte 2 (backfill).
 *
 * Casa cada valor DISTINTO de `patients.diagnosis` (texto livre) contra o catálogo CID-11, EM
 * MEMÓRIA, via `TerminologyPort.search()`. Só grava com ALTA CONFIANÇA (`matching.ts`:
 * exatamente um candidato com título idêntico, normalizado); sem casamento, deixa como está —
 * D260: "não inventa".
 *
 * 🔴 REGRAS DURAS (não negociáveis, ver prompt da fase):
 *   - `--dry-run` é o DEFAULT. Escrever exige `--write` EXPLÍCITO — e mesmo assim passa por
 *     `assertLocalDatabaseTarget` (reusada de `src/shared/database`, NUNCA copiada: as 3
 *     cópias de "travaDeAlvo" nos backfills anteriores divergiram e aprovavam produção via
 *     query string).
 *   - NUNCA imprime o texto de `diagnosis`. Só números: quantos valores distintos, quantos
 *     casaram, quantos não, quantos pacientes cada caso afeta.
 *   - Grava com `source='BACKFILL'` (CHECK da migration 325 já aceita este valor — D263).
 *
 * ── Duas conexões, dois papéis (por que) ─────────────────────────────────────────────────────
 * `DATABASE_URL`         — o catálogo CID-11 (`terminology.icd_entities`) E o alvo de ESCRITA.
 *                          Só pode ser o Postgres local (`assertLocalDatabaseTarget`).
 * `BACKFILL_SOURCE_URL`  — de onde `patients.diagnosis` é LIDO. Default: o mesmo `DATABASE_URL`
 *                          (uso normal, ambiente local). Para o dry-run medido contra a réplica
 *                          de prd (porta 5437, SOMENTE LEITURA), aponte esta variável para lá —
 *                          nenhuma escrita passa por esta conexão, então ela NÃO passa pela
 *                          trava de alvo local (ler a réplica é exatamente o que a F4 pede).
 *
 * Uso:
 *   DATABASE_URL=<local>          ts-node -r dotenv/config scripts/backfill-patient-diagnosis-catalog.ts
 *   BACKFILL_SOURCE_URL=<réplica> ts-node -r dotenv/config scripts/backfill-patient-diagnosis-catalog.ts --dry-run
 *   ... --write   # só grava se DATABASE_URL for o docker local (assertLocalDatabaseTarget)
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget } from '../src/shared/database/assertLocalDatabaseTarget';
import { IcdCatalogTerminology } from '../src/modules/terminology/infrastructure/IcdCatalogTerminology';
import { PatientDiagnosisService } from '../src/modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../src/modules/diagnosis/domain/DiagnosisSource';
import { parseBackfillFlags } from './backfill-diagnosis-catalog/cli-guards';
import { matchByExactTitle } from './backfill-diagnosis-catalog/matching';

const BACKFILL_ACTOR = 'backfill-script';

interface DistinctDiagnosisRow {
  /** O texto CRU — nunca sai deste processo em `console.log`/`log`. Só vive em memória. */
  diagnosis: string;
  patient_count: number;
}

interface RunReport {
  distinctValues: number;
  matched: number;
  unmatched: number;
  patientsAffected: number;
  writes: number;
}

export function catalogDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
}

export function sourceDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return env.BACKFILL_SOURCE_URL || catalogDatabaseUrl(env);
}

async function fetchDistinctDiagnoses(sourcePool: Pool): Promise<DistinctDiagnosisRow[]> {
  const { rows } = await sourcePool.query<DistinctDiagnosisRow>(
    `SELECT diagnosis, COUNT(*)::int AS patient_count
       FROM patients
      WHERE deleted_at IS NULL
        AND diagnosis IS NOT NULL
        AND btrim(diagnosis) <> ''
      GROUP BY diagnosis`,
  );
  return rows;
}

async function fetchPatientIdsForDiagnosis(sourcePool: Pool, diagnosisText: string): Promise<string[]> {
  const { rows } = await sourcePool.query<{ id: string }>(
    `SELECT id FROM patients WHERE deleted_at IS NULL AND diagnosis = $1`,
    [diagnosisText],
  );
  return rows.map(r => r.id);
}

export async function run(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<RunReport> {
  const flags = parseBackfillFlags(args);
  const catalogUrl = catalogDatabaseUrl(env);
  const sourceUrl  = sourceDatabaseUrl(env);

  // A trava roda SEMPRE que a intenção é escrever — antes de abrir qualquer pool de escrita.
  // Ler o catálogo (mesmo pool) não precisa da trava: leitura não tem o risco que ela existe
  // para evitar. `--write` sem trava aprovada aborta ANTES de tocar em qualquer patient.
  if (flags.write) {
    assertLocalDatabaseTarget(catalogUrl);
  }

  const catalogPool = new Pool({ connectionString: catalogUrl });
  // A réplica pode ser um alvo DIFERENTE do catálogo (ex.: porta 5437, só leitura) — pool
  // próprio, nunca reaproveita a conexão de escrita para isto.
  const sourcePool = sourceUrl === catalogUrl ? catalogPool : new Pool({ connectionString: sourceUrl });

  const terminology = new IcdCatalogTerminology();
  const diagnosisService = flags.write
    ? new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.BACKFILL))
    : null;

  try {
    const distinctRows = await fetchDistinctDiagnoses(sourcePool);

    const report: RunReport = {
      distinctValues: distinctRows.length,
      matched: 0,
      unmatched: 0,
      patientsAffected: 0,
      writes: 0,
    };

    for (const row of distinctRows) {
      // 🔴 `row.diagnosis` NUNCA vai para stdout/log a partir daqui — só o resultado do
      // casamento (booleano) e a URI (identificador da OMS, não texto clínico) circulam.
      const candidates = await terminology.search(row.diagnosis, { limit: 10, includeExtensions: false });
      const match = matchByExactTitle(row.diagnosis, candidates);

      if (!match.matched) {
        report.unmatched += 1;
        continue;
      }

      report.matched += 1;
      report.patientsAffected += row.patient_count;

      if (flags.write && diagnosisService) {
        const patientIds = await fetchPatientIdsForDiagnosis(sourcePool, row.diagnosis);
        for (const patientId of patientIds) {
          const outcome = await diagnosisService.recordDiagnosis({
            patientId,
            conceptUri: match.uri,
            isPrimary: true,
            actorUid: BACKFILL_ACTOR,
          });
          if (outcome.outcome === 'created') report.writes += 1;
        }
      }
    }

    return report;
  } finally {
    await catalogPool.end();
    if (sourcePool !== catalogPool) await sourcePool.end();
  }
}

function printReport(report: RunReport, flags: { dryRun: boolean; write: boolean }): void {
  // Só NÚMEROS — regra dura da fase. Nunca um valor de `diagnosis`, nunca um patientId numa
  // linha com contexto clínico (patientId sozinho não é dado clínico, mas não sai aqui mesmo
  // assim: o relatório desta fase pede só as contagens).
  console.log('=== backfill-patient-diagnosis-catalog — RELATÓRIO (só números) ===');
  console.log(`modo=${flags.dryRun ? 'DRY-RUN' : 'ESCRITA'}`);
  console.log(`valores_distintos=${report.distinctValues}`);
  console.log(`casaram=${report.matched}`);
  console.log(`nao_casaram=${report.unmatched}`);
  console.log(`pacientes_afetados=${report.patientsAffected}`);
  console.log(`escritas=${report.writes}`);
}

/* istanbul ignore next -- orquestração de I/O real; provada pelo dry-run real (evidências da F4), não por mock. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = parseBackfillFlags(args);
  const report = await run(process.env, args);
  printReport(report, flags);
}

if (require.main === module) {
  main().catch(err => {
    // 🔴 NUNCA imprimir `err.message` cru: erro do `pg` traz DETAIL com a LINHA ofensora, que
    // aqui é texto clínico. Regra dura do CLAUDE.md (e a memória `psql-contra-dado-real`).
    // Só o nome do erro e, quando existir, o CÓDIGO SQLSTATE — que é classe, não conteúdo.
    const cod = (err as { code?: string })?.code;
    console.error(
      `[backfill-patient-diagnosis-catalog] falhou: ${err instanceof Error ? err.constructor.name : 'erro'}` +
        `${cod ? ` (SQLSTATE ${cod})` : ''} — mensagem omitida de propósito (pode conter dado clínico).`,
    );
    process.exitCode = 1;
  });
}
