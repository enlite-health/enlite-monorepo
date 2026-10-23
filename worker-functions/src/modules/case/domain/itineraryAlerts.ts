/**
 * itineraryAlerts — a ÚNICA regra de "Sin cubrir" que vira alerta (DX-13.9 → spec 069, FR-12/FR-35): turno de uma
 * OCORRÊNCIA `uncovered` (`serviceOccurrences.ts`: ausência sem substituto OU faixa sem alocação vigente) dentro da janela
 * do horizonte `[asOf, asOf + UNCOVERED_HORIZON_DAYS - 1]`. Função pura: nada de `Date`/`Intl` — datas são string
 * `YYYY-MM-DD`. Esta função não lê `workerId`, nome, endereço ou qualquer coisa clínica (critério 13).
 *
 * UNIVERSO (P13, orquestrador 23/10): só conta turno de paciente com itinerário MONTADO (`itineraryAssembled`, "Itinerario listo").
 * Faixa de paciente sem itinerário montado é falta ESTRUTURAL — já visível no estado Búsqueda/Reemplazo —, não "Sin cubrir". O
 * parâmetro é OBRIGATÓRIO de propósito: nenhum leitor consegue chamar a regra sem dizer se o paciente está montado, e o filtro mora
 * AQUI, num lugar só, lido pelo Kanban, pelo GET do itinerário e pelo alerta diário (F4).
 *
 * Lida pelo cartão do serviço (`GET itinerary`), pelo Kanban (`uncoveredDays`) e pelo alerta diário: a MESMA lista, o MESMO
 * horizonte. Duas unidades, dois nomes: `uncoveredDayCount` conta DIAS (Kanban), `uncoveredShiftCount` conta TURNOS (cartão
 * e alerta).
 */
import { uncoveredWindow, type ServiceOccurrence } from './serviceOccurrences';

export interface UncoveredDayAlert {
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

/** Só o que a regra lê de uma ocorrência. */
export type UncoverableOccurrence = Pick<ServiceOccurrence, 'serviceId' | 'date' | 'startTime' | 'endTime' | 'status'>;

function alertKey(a: UncoveredDayAlert): string {
  return `${a.date}|${a.startTime}|${a.serviceId}|${a.endTime}`;
}

/**
 * `itineraryAssembled = false` → `[]` (universo P13). Ocorrências `uncovered` com `asOf <= date <= asOf + 6` (string, nunca `Date`); ordenado por `date, startTime, serviceId`;
 * sem repetição (mesma chave composta = mesmo turno).
 */
export function uncoveredDayAlerts(occurrences: readonly UncoverableOccurrence[], asOf: string, itineraryAssembled: boolean): UncoveredDayAlert[] {
  if (!itineraryAssembled) return [];
  const { from, to } = uncoveredWindow(asOf);
  const seen = new Set<string>();
  const deduped: UncoveredDayAlert[] = [];
  for (const o of occurrences) {
    if (o.status !== 'uncovered' || o.date < from || o.date > to) continue;
    const alert = { serviceId: o.serviceId, date: o.date, startTime: o.startTime, endTime: o.endTime };
    const key = alertKey(alert);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(alert);
  }

  return deduped.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.startTime !== y.startTime) return x.startTime < y.startTime ? -1 : 1;
    if (x.serviceId !== y.serviceId) return x.serviceId < y.serviceId ? -1 : 1;
    return 0;
  });
}

/**
 * Achado L2 (veredito parcial-1): `alerts.length` conta TURNOS (chave `date|start|service|end`) — 2 faixas descobertas no
 * MESMO dia do MESMO serviço davam `uncoveredDays: 2`, embora seja 1 dia sem cobertura. `alerts[]` do itinerário NÃO muda
 * (1 item por faixa); só a CONTAGEM do Kanban deduplica por `date`.
 */
export function uncoveredDayCount(alerts: readonly UncoveredDayAlert[]): number {
  return new Set(alerts.map((a) => a.date)).size;
}

/** Turnos sin cubrir (FR-03): a mesma lista, contada em turnos — o número do cartão do serviço e do alerta diário. */
export function uncoveredShiftCount(alerts: readonly UncoveredDayAlert[]): number {
  return alerts.length;
}
