/**
 * src/modules/anacare-hours/infrastructure/FakeAnaCareShiftsSource.ts
 *
 * Adapter FALSO da porta `AnaCareShiftsSource` — massa 100% SINTÉTICA, gerada em memória,
 * determinística por mês (mesmo mês → mesmos turnos). NUNCA toca o Ana Care real (fase 1, spec
 * "Adapter falso com massa sintética"); nenhuma chamada de rede acontece aqui — é o que o
 * espião "0 chamadas ao Ana Care" do "termina quando" da fase 1 prova por CONSTRUÇÃO.
 *
 * 10 pacientes sintéticos × 2 prestadores × 5 turnos = 100 turnos por mês, com a origem do
 * check-in na MESMA proporção medida em F16 (`fatos-medidos.md`): 46 app / 35 web_admin / 19
 * sem check-in — para o e2e não mentir sobre o caso comum (fase-1.md).
 *
 * Todos os ids são sintéticos e obviamente fictícios (`AC-PAT-*`/`AC-NURSE-*`) — nenhum dado do
 * Ana Care real é lido ou referenciado.
 */

import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { AnaCareRetratoSourceStatus, AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../domain/AnaCareShiftsSource';

/**
 * Pool de `ana_care_id` REAIS (workers), usado para substituir o `anaCareNurseId` sintético
 * (`AC-NURSE-*`) pelo id de um prestador de verdade — achado 1 do QA (16/09): a massa 100%
 * sintética fazia a tela de conferência de horas NUNCA resolver nome nenhum, em qualquer
 * ambiente, mesmo em produção (onde ~748 workers AR têm `ana_care_id` real).
 *
 * Cada AMBIENTE reflete o seu próprio dado: produção tem ~748 ids, a stage tem 0 (o espelho
 * worker→Ana Care só roda de verdade contra a API real deles, e a stage não tem essa massa) — as
 * DUAS contagens são o comportamento ESPERADO, não um bug de uma das duas.
 */
export interface NurseIdPool {
  list(): Promise<readonly string[]>;
}

/**
 * Consulta o banco do AMBIENTE em que o processo está rodando. `merged_into_id IS NULL` e
 * `country = 'AR'` espelham a MESMA trava do lookup de nome (`AnaCareProviderNameRepository`) —
 * um id sorteado daqui sempre resolve nome quando o pool não está vazio.
 *
 * Fail-closed em duas direções: erro de conexão/consulta é ENGOLIDO e vira pool vazio (nunca
 * trava a geração sintética, que é sempre determinística e não pode depender de banco estar de
 * pé) — quem chama cai no fallback sintético de sempre.
 */
export class DbNurseIdPool implements NurseIdPool {
  private cached?: Promise<readonly string[]>;

  async list(): Promise<readonly string[]> {
    this.cached ??= this.query();
    return this.cached;
  }

  private async query(): Promise<readonly string[]> {
    try {
      const pool = DatabaseConnection.getInstance().getPool();
      const res = await pool.query<{ ana_care_id: string }>(
        `SELECT ana_care_id FROM workers WHERE ana_care_id IS NOT NULL AND country = 'AR' AND merged_into_id IS NULL`,
      );
      return res.rows.map((r) => r.ana_care_id);
    } catch {
      return [];
    }
  }
}

/** Hash determinístico (djb2-like) — mesmo `anaCareNurseId` sintético SEMPRE sorteia o mesmo real. */
function hashToIndex(input: string, modulo: number): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

const PATIENTS_PER_MONTH = 10;
const PROVIDERS_PER_PATIENT = 2;
const SHIFTS_PER_PROVIDER = 5;
const TOTAL_SHIFTS = PATIENTS_PER_MONTH * PROVIDERS_PER_PATIENT * SHIFTS_PER_PROVIDER; // 100

/** F16 — proporção medida de origem do check-in entre 100 turnos. */
const ORIGIN_COUNTS: Record<'app' | 'web_admin' | 'sin_checkin', number> = {
  app: 46,
  web_admin: 35,
  sin_checkin: 19,
};

/**
 * Sequência determinística de origem, comprimento `total`, respeitando a PROPORÇÃO de
 * `ORIGIN_COUNTS` (algoritmo "maior resto" acumulado — tipo Bresenham, sem aleatoriedade): o
 * turno de índice `i` sempre recebe a mesma origem, para qualquer `total`.
 */
function buildOriginSequence(total: number): Array<'app' | 'web_admin' | 'sin_checkin'> {
  const order: Array<'app' | 'web_admin' | 'sin_checkin'> = ['app', 'web_admin', 'sin_checkin'];
  const weights = order.map((k) => ORIGIN_COUNTS[k]);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const acc = [0, 0, 0];
  const out: Array<'app' | 'web_admin' | 'sin_checkin'> = [];
  for (let i = 0; i < total; i += 1) {
    for (let k = 0; k < order.length; k += 1) acc[k] += weights[k];
    // Escolhe o índice com maior acumulado proporcional pendente, decrementa.
    let best = 0;
    for (let k = 1; k < order.length; k += 1) if (acc[k] > acc[best]) best = k;
    acc[best] -= weightTotal;
    out.push(order[best]);
  }
  return out;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Deriva horas decimais entre dois ISO — sempre >= 0. */
function hoursBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.round((ms / (1000 * 60 * 60)) * 100) / 100;
}

export class FakeAnaCareShiftsSource implements AnaCareShiftsSource {
  constructor(private readonly nurseIdPool: NurseIdPool = new DbNurseIdPool()) {}

  /**
   * Substitui o `anaCareNurseId` SINTÉTICO (`AC-NURSE-*`) por um id REAL do pool, sorteado com
   * reposição (o mesmo real pode atender mais de um prestador sintético) e determinístico (o
   * MESMO sintético sempre vira o MESMO real, pro mês continuar reproduzível). Pool vazio (ex.:
   * stage, sem massa real de `ana_care_id`) → devolve os turnos tal qual, sem tocar o campo —
   * fallback sintético de sempre, nunca trava a geração.
   */
  private async applyRealNurseIds(shifts: readonly SourceShiftDTO[]): Promise<SourceShiftDTO[]> {
    const pool = await this.nurseIdPool.list();
    if (pool.length === 0) return shifts as SourceShiftDTO[];
    return shifts.map((s) => ({ ...s, anaCareNurseId: pool[hashToIndex(s.anaCareNurseId, pool.length)] }));
  }

  async listShifts(params: ListShiftsParams): Promise<SourceShiftDTO[]> {
    const shifts = FakeAnaCareShiftsSource.generateMonth(params.month);
    const withRealIds = await this.applyRealNurseIds(shifts);
    if (!params.patientId) return withRealIds;
    return withRealIds.filter((s) => s.anaCarePatientId === params.patientId);
  }

  /**
   * O `sourceShiftId` sintético embute o mês (`FAKE-${month}-...`) — truque INTERNO deste
   * adapter falso (regenera o mês e procura o id), nunca um contrato que a porta expõe: um
   * adapter real (fase 2/4) não teria como assumir isso e resolveria por outro meio (ex.: uma
   * tabela de índice `source_shift_id → period_month`).
   */
  async getShift(sourceShiftId: string): Promise<SourceShiftDTO | null> {
    const match = /^FAKE-(\d{4}-\d{2})-/.exec(sourceShiftId);
    if (!match) return null;
    const month = match[1];
    const shifts = FakeAnaCareShiftsSource.generateMonth(month);
    const found = shifts.find((s) => s.sourceShiftId === sourceShiftId);
    if (!found) return null;
    const [withRealId] = await this.applyRealNurseIds([found]);
    return withRealId;
  }

  /** Fase 1: sempre fresco — nenhum job real de sync/disjuntor existe ainda neste adapter falso. */
  async getRetratoStatus(): Promise<AnaCareRetratoSourceStatus> {
    return { stale: false, circuitBreakerOpen: false };
  }

  /** Exposto estático para os testes conferirem a proporção/contagem sem passar pela porta. */
  static generateMonth(month: string): SourceShiftDTO[] {
    const [yearStr, monthStr] = month.split('-');
    const year = Number.parseInt(yearStr, 10);
    const monthNum = Number.parseInt(monthStr, 10);
    const dim = daysInMonth(year, monthNum);
    const originSequence = buildOriginSequence(TOTAL_SHIFTS);

    const out: SourceShiftDTO[] = [];
    let shiftIndex = 0;
    for (let p = 0; p < PATIENTS_PER_MONTH; p += 1) {
      for (let pr = 0; pr < PROVIDERS_PER_PATIENT; pr += 1) {
        for (let s = 0; s < SHIFTS_PER_PROVIDER; s += 1) {
          const day = (shiftIndex % dim) + 1;
          const dateStr = `${year}-${pad2(monthNum)}-${pad2(day)}`;
          const scheduledStart = `${dateStr}T08:00:00.000Z`;
          const scheduledEnd = `${dateStr}T12:00:00.000Z`;
          const origin = originSequence[shiftIndex];

          let actualStart: string | null = null;
          let actualEnd: string | null = null;
          let durationHours: number | null = null;
          if (origin !== 'sin_checkin') {
            // Atraso determinístico 0/5/10/15 min, ciclando por índice — cobre o destaque de
            // diferença (>=15min) sem depender de aleatoriedade.
            const delayMin = (shiftIndex % 4) * 5;
            actualStart = new Date(new Date(scheduledStart).getTime() + delayMin * 60_000).toISOString();
            actualEnd = new Date(new Date(scheduledEnd).getTime() + delayMin * 60_000).toISOString();
            durationHours = hoursBetween(actualStart, actualEnd);
          }

          out.push({
            sourceShiftId: `FAKE-${month}-${p}-${pr}-${s}`,
            anaCarePatientId: `AC-PAT-${p}`,
            anaCareNurseId: `AC-NURSE-${p}-${pr}`,
            date: dateStr,
            scheduledStart,
            scheduledEnd,
            actualStart,
            actualEnd,
            checkinSource: origin === 'sin_checkin' ? null : origin,
            durationHours,
          });
          shiftIndex += 1;
        }
      }
    }
    return out;
  }
}

/** Nome do env que seleciona o adapter. Fase 1: só `'fake'` é aceito. */
export const ANACARE_HOURS_SOURCE_ENV = 'ANACARE_HOURS_SOURCE';

/**
 * Seleciona o adapter pela env — fail-closed: SEM a env (ou valor desconhecido), devolve `null` e
 * quem chama responde 503 `ANACARE_SOURCE_NOT_CONFIGURED` (spec F1: produção nunca serve dado
 * falso por omissão). Nenhum adapter REAL existe nesta fase.
 */
export function createAnaCareShiftsSource(env: NodeJS.ProcessEnv = process.env): AnaCareShiftsSource | null {
  if (env[ANACARE_HOURS_SOURCE_ENV] === 'fake') return new FakeAnaCareShiftsSource();
  return null;
}
