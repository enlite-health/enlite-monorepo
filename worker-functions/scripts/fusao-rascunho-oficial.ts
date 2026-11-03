/**
 * fusao-rascunho-oficial.ts — CLI da fusão das vagas RASCUNHO (criadas pelo foguete) na vaga OFICIAL legada do paciente.
 * A lógica mora em `FuseDraftIntoOfficialVacancyUseCase` (uma transação por paciente); aqui só composição, mapa e relatório.
 *
 * Uso:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/fusao-rascunho-oficial.ts --dry-run --csv <mapa.csv>
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/fusao-rascunho-oficial.ts --apply   --csv <mapa.csv>
 *
 * Só a classe PAR_UNICO do mapa entra. `--dry-run` executa cada paciente inteiro e dá ROLLBACK. Erro num paciente
 * desfaz só aquele e segue; a lista sai no fim. Saída: só IDs, etapas e contagens.
 * Sem side-effect outbound: não chama Talentum/WhatsApp/Ana Care/Short.io nem emite evento de funil.
 */
import * as fs from 'fs';
import { Pool, type PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { FuseDraftIntoOfficialVacancyUseCase } from '@modules/case/application/FuseDraftIntoOfficialVacancyUseCase';
import { LinkExistingVacancyUseCase } from '@modules/case/application/LinkExistingVacancyUseCase';
import { DraftFusionRepository } from '@modules/case/infrastructure/DraftFusionRepository';
import { LinkExistingVacancyRepository } from '@modules/case/infrastructure/LinkExistingVacancyRepository';
import { ACCEPT_ANY_SERVICE_VALUE } from '@modules/case/domain/LinkExistingVacancyPlan';
import { JobPostingAuditRepository } from '@modules/matching/infrastructure/JobPostingAuditRepository';
import type { HumanActor } from '@modules/matching/interfaces/controllers/vacancyCrudAuditHelpers';
import {
  formatPatientLine,
  formatTotals,
  parseFusionArgs,
  parseFusionCsv,
  totalize,
  type PatientLine,
} from './fusao-rascunho-oficial-lib';

const JOB = 'fusao-rascunho-oficial';
const ACTOR: HumanActor = { actorUserId: null, actorType: 'CLI', actorLabel: JOB, traceId: null };

function target(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname} user=${u.username}`;
}

async function main(): Promise<void> {
  const { mode, csv } = parseFusionArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  const pairs = parseFusionCsv(fs.readFileSync(csv, 'utf8'));
  console.log(`alvo=${target(url)} modo=${mode} pares_PAR_UNICO=${pairs.length}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const linkRepo = new LinkExistingVacancyRepository();
  const auditRepo = new JobPostingAuditRepository();
  const useCase = new FuseDraftIntoOfficialVacancyUseCase(
    new DraftFusionRepository(),
    linkRepo,
    auditRepo,
    // O vínculo roda NA transação da fusão: o runner só repassa o client.
    (client: PoolClient) =>
      new LinkExistingVacancyUseCase(linkRepo, auditRepo, ACCEPT_ANY_SERVICE_VALUE, <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client)),
    <T,>(fn: (c: PoolClient) => Promise<T>) => withActorContext(pool, fn, systemActor(JOB)),
    ACTOR,
  );

  const lines: PatientLine[] = [];
  try {
    for (const pair of pairs) {
      let line: PatientLine;
      try {
        line = { pair, outcome: await useCase.fuse(pair, { apply: mode === 'apply' }) };
      } catch (err) {
        line = { pair, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
      }
      lines.push(line);
      console.log(formatPatientLine(line));
    }
  } finally {
    await pool.end();
  }
  for (const l of formatTotals(totalize(lines), mode)) console.log(l);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
