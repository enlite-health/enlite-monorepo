/**
 * Parte PURA do CLI da LINHA DE CORTE das vagas antigas (`linha-de-corte-vagas.ts`, spec 084 F3): flags, mapa do grupo c
 * (caso → vaga do serviço, escolhido pelo recrutamento) e relatório. O relatório só carrega IDs de vaga, números de
 * caso, status e contagens — nunca nome, telefone, e-mail ou texto.
 */
import { splitCsvLine } from './fusao-rascunho-oficial-lib';
import { FUSION_COUNTED_TABLES } from '../src/modules/case/infrastructure/DraftFusionRepository';
import type { ClassifiedVacancy, MergeCandidate } from '../src/modules/case/infrastructure/LegacyVacancyCutoffRepository';
import type { LegacyMergeOutcome, LegacyMergePair } from '../src/modules/case/application/MergeLegacyVacancyIntoServiceVacancyUseCase';
import type { CutoffGroup } from '../src/modules/case/domain/LegacyVacancyCutoff';

export type CutoffMode = 'dry-run' | 'apply';

export interface CutoffArgs {
  mode: CutoffMode;
  /** CSV do grupo c: `legacy_vacancy_id,target_vacancy_id`. Sem ele, NENHUM caso do grupo c é aplicado. */
  mapCsv: string | null;
  /** Depois do COMMIT, tenta pausar no Talentum os projetos das vagas baixadas. Explícito; só com --apply. */
  pauseTalentum: boolean;
}

/** Exatamente um de `--dry-run` / `--apply` (sem modo, recusa: nunca grava por omissão). `--pause-talentum` só com `--apply`. */
export function parseCutoffArgs(argv: readonly string[]): CutoffArgs {
  const dry = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dry === apply) throw new Error('use exatamente um de --dry-run ou --apply');
  const pauseTalentum = argv.includes('--pause-talentum');
  if (pauseTalentum && !apply) throw new Error('--pause-talentum só vale com --apply (o ensaio nunca chama o Talentum)');
  const i = argv.indexOf('--map');
  const mapCsv = i >= 0 ? argv[i + 1] ?? null : null;
  if (i >= 0 && (!mapCsv || mapCsv.startsWith('--'))) throw new Error('faltou o arquivo depois de --map');
  return { mode: apply ? 'apply' : 'dry-run', mapCsv, pauseTalentum };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mapa do grupo c: `legacy_vacancy_id,target_vacancy_id` (cabeçalho obrigatório). Id que não é UUID ou repetido → erro. */
export function parseCutoffMap(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('mapa vazio');
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const li = header.indexOf('legacy_vacancy_id');
  const ti = header.indexOf('target_vacancy_id');
  if (li < 0 || ti < 0) throw new Error('mapa sem coluna: legacy_vacancy_id, target_vacancy_id');
  const map = new Map<string, string>();
  lines.slice(1).forEach((line, n) => {
    const cols = splitCsvLine(line).map((c) => c.trim());
    const [legacy, target] = [cols[li], cols[ti]];
    if (!UUID.test(legacy ?? '') || !UUID.test(target ?? '')) throw new Error(`linha ${n + 2}: id que não é UUID`);
    if (map.has(legacy)) throw new Error(`linha ${n + 2}: vaga antiga repetida no mapa`);
    map.set(legacy, target);
  });
  return map;
}

export type PairPlan = { pairs: LegacyMergePair[]; semDestino: ClassifiedVacancy[] };

/** Só entra par com destino no mapa. Caso sem destino NÃO é aplicado — fica na lista, nunca vai a um destino por chute. */
export function planGroupC(group: readonly ClassifiedVacancy[], map: ReadonlyMap<string, string>): PairPlan {
  const pairs: LegacyMergePair[] = [];
  const semDestino: ClassifiedVacancy[] = [];
  for (const v of group) {
    const target = map.get(v.vacancyId);
    if (target && v.patientId) pairs.push({ patientId: v.patientId, legacyId: v.vacancyId, targetId: target });
    else semDestino.push(v);
  }
  return { pairs, semDestino };
}

export interface GroupCount {
  group: CutoffGroup;
  vacancies: number;
  cases: number[];
}

export function countByGroup(rows: readonly ClassifiedVacancy[]): GroupCount[] {
  const order: CutoffGroup[] = ['a', 'b', 'c', 'x', 'd-baixar', 'e', 'revisao'];
  return order.map((group) => {
    const g = rows.filter((r) => r.group === group);
    const cases = [...new Set(g.map((r) => r.caseNumber).filter((n): n is number => n !== null))].sort((x, y) => x - y);
    return { group, vacancies: g.length, cases };
  });
}

export function formatGroupLine(c: GroupCount): string {
  return `grupo=${c.group} vagas=${c.vacancies} casos=[${c.cases.join(',') || '-'}]`;
}

export function formatCandidates(v: ClassifiedVacancy, cands: readonly MergeCandidate[]): string {
  const c = cands.map((x) => `${x.vacancyId}(#${x.vacancyCaseOrdinal ?? '-'},${x.status}${x.isDraft ? ',rascunho' : ''})`).join(' ');
  return `  c sem destino: caso=${v.caseNumber ?? '-'} antiga=${v.vacancyId} destinos_possiveis=[${c || 'NENHUMA vaga de servico'}]`;
}

export function formatMergeLine(pair: LegacyMergePair, outcome: LegacyMergeOutcome | { error: string }): string {
  const head = `  c merge: antiga=${pair.legacyId} destino=${pair.targetId}`;
  if ('error' in outcome) return `${head} ERRO ${outcome.error}`;
  if (outcome.status === 'SKIPPED') return `${head} PULADO ${outcome.reason}`;
  if (outcome.status === 'CONFLICT') {
    return `${head} CONFLITO ${outcome.conflicts.map((x) => `${x.workerId}:${x.officialStage}<>${x.draftStage}`).join(',')}`;
  }
  const r = outcome.result;
  const tables = FUSION_COUNTED_TABLES.map((t) => `${t}=${r.before[t].draft}+${r.before[t].official}->${r.after[t].draft}+${r.after[t].official}`).join(' ');
  const stages = Object.entries(r.collisionStages).map(([s, n]) => `${s}:${n}`).join(',');
  return `${head} FUNDIDO+BAIXADA ${tables} bloqueados=${r.blockedBefore}->${r.blockedAfter}(movidos=${r.blockedMoved},ficaram=${r.blockedLeft}) colisoes=[${stages}]`;
}

export interface CutoffTotals {
  mode: CutoffMode;
  abertasSemServicoAntes: number;
  abertasSemServicoDepois: number;
  vagasVivasAntes: number;
  vagasVivasDepois: number;
  baixadas: number;
  mergeadas: number;
  semDestino: number;
  emEspera: number;
  revisao: number;
  talentumComProjeto: number;
}

export function formatTotals(t: CutoffTotals): string[] {
  return [
    `TOTAL modo=${t.mode} baixadas=${t.baixadas} mergeadas_e_baixadas=${t.mergeadas} c_sem_destino_nao_tocadas=${t.semDestino} en_espera=${t.emEspera} lista_de_revisao=${t.revisao}`,
    `abertas_sem_servico antes=${t.abertasSemServicoAntes} depois=${t.abertasSemServicoDepois}`,
    `vagas_vivas antes=${t.vagasVivasAntes} depois=${t.vagasVivasDepois} (nenhuma apagada: ${t.vagasVivasAntes === t.vagasVivasDepois ? 'OK' : 'DIVERGE'})`,
    `talentum: ${t.talentumComProjeto} vagas baixadas com projeto (pausa por API so com --apply --pause-talentum; o que o Talentum recusar vira lista manual na tela)`,
  ];
}
