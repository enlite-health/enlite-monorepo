/**
 * linha-de-corte-vagas.ts — CLI da LINHA DE CORTE das vagas antigas (spec 084 F3). Toda a lógica mora nos use cases e
 * no repositório; aqui só composição, mapa e relatório.
 *
 * Uso:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/linha-de-corte-vagas.ts --dry-run [--map <grupo-c.csv>]
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/linha-de-corte-vagas.ts --apply   [--map <grupo-c.csv>] [--pause-talentum]
 *
 * O ensaio e a aplicação são o MESMO caminho com uma chave: UMA transação; `--dry-run` imprime e dá ROLLBACK (contagem
 * antes = depois, nada grava); `--apply` dá COMMIT com a mesma contagem do ensaio. NUNCA apaga vaga (R2): baixa = DE_BAJA,
 * motivo CUTOFF, consultável e sem volta (R17). O grupo c só roda para o par que o recrutamento escolheu no mapa; sem destino
 * não toca. `--dry-run` NUNCA chama o Talentum; o pause por API é um passo EXPLÍCITO (`--apply --pause-talentum`), DEPOIS do commit.
 * Saída: só IDs de vaga, números de caso, status e contagens.
 */
import * as fs from 'fs';
import { Pool, type PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { MergeLegacyVacancyIntoServiceVacancyUseCase } from '@modules/case/application/MergeLegacyVacancyIntoServiceVacancyUseCase';
import { DraftFusionRepository } from '@modules/case/infrastructure/DraftFusionRepository';
import { LegacyVacancyCutoffRepository } from '@modules/case/infrastructure/LegacyVacancyCutoffRepository';
import { BAIXAR_GROUPS } from '@modules/case/domain/LegacyVacancyCutoff';
import { BajaVacanciesUseCase } from '@modules/matching/application/BajaVacanciesUseCase';
import { VacancyTalentumPauseService } from '@modules/matching/application/VacancyTalentumPauseService';
import { JobPostingAuditRepository } from '@modules/matching/infrastructure/JobPostingAuditRepository';
import type { HumanActor } from '@modules/matching/interfaces/controllers/vacancyCrudAuditHelpers';
import {
  countByGroup,
  formatCandidates,
  formatGroupLine,
  formatMergeLine,
  formatTotals,
  parseCutoffArgs,
  parseCutoffMap,
  planGroupC,
} from './linha-de-corte-vagas-lib';

const JOB = 'linha-de-corte-vagas';
const ACTOR: HumanActor = { actorUserId: null, actorType: 'CLI', actorLabel: JOB, traceId: null };

/** Sinal interno: desfaz a transação (ensaio) depois de imprimir o relatório. */
class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
  }
}

function target(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname} user=${u.username}`;
}

async function main(): Promise<void> {
  const args = parseCutoffArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  const map = args.mapCsv ? parseCutoffMap(fs.readFileSync(args.mapCsv, 'utf8')) : new Map<string, string>();
  console.log(`alvo=${target(url)} modo=${args.mode} mapa_grupo_c=${map.size} pausar_talentum=${args.pauseTalentum}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const repo = new LegacyVacancyCutoffRepository();
  const baja = new BajaVacanciesUseCase(pool);
  const merge = new MergeLegacyVacancyIntoServiceVacancyUseCase(new DraftFusionRepository(), repo, baja, new JobPostingAuditRepository(), ACTOR);
  const pauseIds: string[] = [];

  const run = async (client: PoolClient): Promise<void> => {
    const abertasAntes = await repo.countOpenWithoutService(client);
    const vivasAntes = await repo.countLiveVacancies(client);

    const classified = await repo.classifyLegacy(client);
    const groupE = await repo.listGroupE(client);
    const counts = countByGroup(classified);
    counts.find((c) => c.group === 'e')!.vacancies = groupE.length;
    counts.find((c) => c.group === 'e')!.cases = [...new Set(groupE.map((g) => g.caseNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    console.log('--- grupos (ensaio = aplicação) ---');
    for (const c of counts) console.log(formatGroupLine(c));

    // 1. baixar a, b, x e os d-baixar (uma transação, tudo-ou-nada — mesmo caminho da baixa à mão).
    const toBaixar = classified.filter((v) => (BAIXAR_GROUPS as readonly string[]).includes(v.group)).map((v) => v.vacancyId);
    const baixa = toBaixar.length > 0 ? await baja.executeInTx(client, toBaixar, 'CUTOFF', ACTOR) : { ok: true as const, baixadas: [] };
    if (!baixa.ok) throw new Error(`baixa recusada: ${baixa.refused.map((r) => `${r.vacancyId}:${r.code}`).join(',')}`);
    pauseIds.push(...toBaixar);

    // 2. grupo c: só o par com destino no mapa; o resto fica na lista, intocado.
    const groupC = classified.filter((v) => v.group === 'c');
    const plan = planGroupC(groupC, map);
    const mapaForaDeC = [...map.keys()].filter((id) => !groupC.some((v) => v.vacancyId === id));
    if (mapaForaDeC.length > 0) throw new Error(`o mapa tem ${mapaForaDeC.length} vaga(s) que NÃO são do grupo c: ${mapaForaDeC.join(',')}`);
    console.log('--- grupo c ---');
    let mergeadas = 0;
    for (const pair of plan.pairs) {
      await client.query('SAVEPOINT par_grupo_c');
      let line: string;
      try {
        const out = await merge.mergeInTx(client, pair);
        if (out.status === 'MERGED') {
          mergeadas++;
          pauseIds.push(pair.legacyId);
          await client.query('RELEASE SAVEPOINT par_grupo_c');
        } else {
          await client.query('ROLLBACK TO SAVEPOINT par_grupo_c');
        }
        line = formatMergeLine(pair, out);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT par_grupo_c');
        line = formatMergeLine(pair, { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
      console.log(line);
    }
    for (const v of plan.semDestino) console.log(formatCandidates(v, v.patientId ? await repo.mergeCandidates(client, v.patientId) : []));

    // 3. grupo e: vaga de serviço ativo hoje encerrada → "En espera".
    const onHold = await repo.putOnHold(client, groupE.map((g) => g.vacancyId));
    console.log(`--- grupo e: En espera=${onHold.length} ---`);

    // 4. lista de revisão do recrutamento (NÃO baixa) e relatório.
    const revisao = classified.filter((v) => v.group === 'revisao');
    console.log('--- lista de revisão do recrutamento (não baixa) ---');
    for (const v of revisao) console.log(`  revisao: caso=${v.caseNumber ?? '-'} vaga=${v.vacancyId} status=${v.status} motivo=${v.reviewReason}`);

    const talentum = await repo.withTalentumProject(client, [...new Set(pauseIds)]);
    const totals = {
      mode: args.mode,
      abertasSemServicoAntes: abertasAntes,
      abertasSemServicoDepois: await repo.countOpenWithoutService(client),
      vagasVivasAntes: vivasAntes,
      vagasVivasDepois: await repo.countLiveVacancies(client),
      baixadas: toBaixar.length,
      mergeadas,
      semDestino: plan.semDestino.length,
      emEspera: onHold.length,
      revisao: revisao.length,
      talentumComProjeto: talentum.length,
    };
    console.log('--- totais ---');
    for (const l of formatTotals(totals)) console.log(l);
    // Nunca apagar: se a contagem de vagas vivas divergir, NADA é gravado.
    if (totals.vagasVivasAntes !== totals.vagasVivasDepois) throw new Error('contagem de vagas vivas divergiu: abortado');
    pauseIds.splice(0, pauseIds.length, ...talentum);
    if (args.mode === 'dry-run') throw new DryRunRollback();
  };

  try {
    await withActorContext(pool, run, systemActor(JOB));
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    console.log('dry-run: ROLLBACK feito, nada foi gravado.');
  }

  if (args.mode === 'apply' && args.pauseTalentum) {
    console.log(`pausando ${pauseIds.length} projeto(s) no Talentum (o que for recusado vira lista manual)...`);
    const outcomes = await withActorContext(pool, (c) => new VacancyTalentumPauseService(c).pause(pauseIds), systemActor(JOB));
    const resumo: Record<string, number> = {};
    for (const o of outcomes) resumo[String(o.state)] = (resumo[String(o.state)] ?? 0) + 1;
    console.log(`talentum_estado ${JSON.stringify(resumo)}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
