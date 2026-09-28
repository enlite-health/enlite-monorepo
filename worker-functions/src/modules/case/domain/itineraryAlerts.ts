/**
 * itineraryAlerts — a ÚNICA regra de "dia descoberto" (DX-13.9, Fase 13): uma ausência SEM
 * substituto, com `date >= asOf`. Função pura: nada de `Date`/`Intl` aqui — vigência é comparação de
 * string `YYYY-MM-DD`, a MESMA convenção do resto do domínio da fase (`isVigente` em
 * `ServiceCoverageCalculator.ts`, `deriveServiceTeam.ts`). A entrada já chega filtrada para SÓ a
 * ausência sem substituto (quem tem substituto está coberto — não é alerta); esta função não lê
 * `workerId`, nome, endereço ou qualquer coisa clínica — nem entra, nem sai daqui (critério 13).
 *
 * Usada pela rota do itinerário (DX-13.9, alerta no card do titular) e pelo Kanban (DX-13.10,
 * `uncoveredDays` do agregado) — a MESMA regra nos dois lugares, nunca duas implementações.
 */

export interface UncoveredDayAlert {
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

function alertKey(a: UncoveredDayAlert): string {
  return `${a.date}|${a.startTime}|${a.serviceId}|${a.endTime}`;
}

/**
 * `date >= asOf` (string, nunca `Date`); ordenado por `date, startTime, serviceId`; sem repetição
 * (mesma chave composta = mesmo alerta).
 */
export function uncoveredDayAlerts(
  absences: readonly UncoveredDayAlert[],
  asOf: string,
): UncoveredDayAlert[] {
  const vigentes = absences.filter((a) => a.date >= asOf);

  const seen = new Set<string>();
  const deduped: UncoveredDayAlert[] = [];
  for (const a of vigentes) {
    const key = alertKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ serviceId: a.serviceId, date: a.date, startTime: a.startTime, endTime: a.endTime });
  }

  return deduped.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.startTime !== y.startTime) return x.startTime < y.startTime ? -1 : 1;
    if (x.serviceId !== y.serviceId) return x.serviceId < y.serviceId ? -1 : 1;
    return 0;
  });
}

/**
 * Achado L2 (veredito parcial-1): `alerts.length` conta ALERTAS (chave `date|start|service|end`) —
 * 2 faixas descobertas no MESMO dia do MESMO serviço davam `uncoveredDays: 2`, embora seja 1 dia
 * sem cobertura. `alerts[]` do itinerário NÃO muda (continua 1 item por faixa); só a CONTAGEM do
 * Kanban deduplica por `date`.
 */
export function uncoveredDayCount(alerts: readonly UncoveredDayAlert[]): number {
  return new Set(alerts.map((a) => a.date)).size;
}
