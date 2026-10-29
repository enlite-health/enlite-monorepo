import type { TFunction } from 'i18next';

/**
 * O rótulo de um prestador nas telas do serviço contratado (quadro C, "Sustituir un día", aba
 * "Itinerario" e o modal "Asignar prestador"): o `displayName` da API ou, quando ele vem `null`
 * (sem a célula de nome, ou fora de vigência), o fallback com os 8 últimos caracteres do id.
 * Fonte única desde o G2 do gate fecho da Fase 12 (a expressão estava copiada em 4 componentes).
 */
export function workerLabel(t: TFunction, workerId: string, displayName: string | null): string {
  return displayName ?? t('admin.patients.detail.serviceTeam.unnamedWorker', { shortId: workerId.slice(-8) });
}
