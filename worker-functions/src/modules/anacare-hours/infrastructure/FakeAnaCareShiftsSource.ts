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

import type { AnaCareRetratoSourceStatus, AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import { AnaCareSessionClient, AnaCareShiftsSourceReal } from '@modules/integration';
import { reportError } from '@shared/logging';

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

export class FakeAnaCareShiftsSource implements AnaCareShiftsSource {
  async listShifts(params: ListShiftsParams): Promise<SourceShiftDTO[]> {
    const shifts = FakeAnaCareShiftsSource.generateMonth(params.month);
    if (!params.patientId) return shifts;
    return shifts.filter((s) => s.anaCarePatientId === params.patientId);
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
    return shifts.find((s) => s.sourceShiftId === sourceShiftId) ?? null;
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
          // Medido 17/09 contra a API real (paciente 9660, 88 turnos): existe turno NÃO
          // finalizado sem check-in nenhum (a maioria, 23/30) e turno NÃO finalizado com
          // check-in mas sem checkout ainda (7/30, "em andamento"). A massa falsa tem de ter as
          // duas formas — só o caso "sem check-in nenhum" era o que existia antes, e por isso a
          // suíte nunca cobriu o segundo.
          let isFinalized = false;
          if (origin !== 'sin_checkin') {
            // Atraso de check-in determinístico 0/5/10/15 min, ciclando por índice — cobre o
            // destaque de diferença (>=15min) sem depender de aleatoriedade.
            const delayMin = (shiftIndex % 4) * 5;
            actualStart = new Date(new Date(scheduledStart).getTime() + delayMin * 60_000).toISOString();

            // 1 em cada 9 turnos com check-in fica "em andamento": tem `actualStart`, mas ainda
            // não fez checkout (`actualEnd` null, `is_finalized=false`) — modela o achado 3 do
            // defeito medido (30 turnos não finalizados, 7 com check-in).
            const emAndamento = shiftIndex % 9 === 0;
            if (!emAndamento) {
              // Checkout adiantado 0/3/6/9/12 min, ciclando por índice — cobre o achado 2 do
              // defeito medido: turno finalizado cuja hora REAL é MENOR que a PREVISTA
              // (ex. previsto 12,0 / real 11,8). Quando `earlyMin===0` o real bate com o
              // previsto (o caso que a suíte antiga só conhecia) — os outros 4/5 divergem.
              const earlyMin = (shiftIndex % 5) * 3;
              actualEnd = new Date(new Date(scheduledEnd).getTime() + (delayMin - earlyMin) * 60_000).toISOString();
              isFinalized = true;
            }
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
            isFinalized,
          });
          shiftIndex += 1;
        }
      }
    }
    return out;
  }
}

/** Nome do env que seleciona o adapter. Valores aceitos: `'fake'` | `'real'` (F2 em diante). */
export const ANACARE_HOURS_SOURCE_ENV = 'ANACARE_HOURS_SOURCE';

/**
 * Seleciona o adapter pela env — fail-closed: SEM a env (ou valor desconhecido), devolve `null` e
 * quem chama responde 503 `ANACARE_SOURCE_NOT_CONFIGURED` (spec F1: produção nunca serve dado
 * falso por omissão).
 *
 * `'real'` liga o cliente de sessão da F2 (`AnaCareSessionClient`/`AnaCareShiftsSourceReal`), que
 * precisa de `ANACARE_USERNAME`/`ANACARE_PASS` (D350: credencial de pessoa já em uso, sem usuário
 * de integração dedicado). SEM credencial, o construtor do cliente lança — aqui isso é
 * capturado, reportado (`reportError`, nunca silencioso) e vira `null` (mesmo 503 fail-closed),
 * nunca uma queda silenciosa para o adapter falso.
 */
export function createAnaCareShiftsSource(env: NodeJS.ProcessEnv = process.env): AnaCareShiftsSource | null {
  const selected = env[ANACARE_HOURS_SOURCE_ENV];
  if (selected === 'fake') return new FakeAnaCareShiftsSource();
  if (selected === 'real') {
    try {
      return new AnaCareShiftsSourceReal(new AnaCareSessionClient());
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'createAnaCareShiftsSource:real' });
      return null;
    }
  }
  return null;
}
