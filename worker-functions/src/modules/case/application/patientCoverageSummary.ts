/**
 * patientCoverageSummary — deriva da lista de serviços contratados (já projetada para o ator) a
 * cobertura ATUAL e a data de entrada do paciente. Derivado nunca é gravado (D516): o dono do dado
 * é o serviço contratado; aqui só se lê.
 *
 * `services` null/undefined => `null` (vazio ambíguo: "não sei" nunca vira `activeServices: 0`).
 */
export interface CurrentCoverageSummary {
  providers: { code: string; name: string }[];
  privateServices: number;
  hiddenServices: number;
  unlinkedServices: number;
  activeServices: number;
}

type PayerLike =
  | { state: 'NO_CONTRACT' }
  | { state: 'LINKED'; isPrivate: boolean; names: { providerCode: string; providerName: string } | null };

export interface SummarizableService {
  active: boolean;
  startDate: string | null;
  payer: PayerLike;
}

export function deriveCurrentCoverage(
  services: readonly SummarizableService[] | null | undefined,
): CurrentCoverageSummary | null {
  if (!Array.isArray(services)) return null;
  const byCode = new Map<string, string>();
  let privateServices = 0;
  let hiddenServices = 0;
  let unlinkedServices = 0;
  let activeServices = 0;
  for (const s of services) {
    if (!s.active) continue;
    activeServices++;
    if (s.payer.state === 'NO_CONTRACT') {
      unlinkedServices++;
    } else if (s.payer.isPrivate) {
      privateServices++;
    } else if (s.payer.names === null) {
      hiddenServices++;
    } else if (!byCode.has(s.payer.names.providerCode)) {
      byCode.set(s.payer.names.providerCode, s.payer.names.providerName);
    }
  }
  const providers = [...byCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { providers, privateServices, hiddenServices, unlinkedServices, activeServices };
}

export function deriveEntryDate(services: readonly SummarizableService[] | null | undefined): string | null {
  if (!Array.isArray(services)) return null;
  let min: string | null = null;
  for (const s of services) {
    if (s.startDate != null && (min === null || s.startDate < min)) min = s.startDate;
  }
  return min;
}
