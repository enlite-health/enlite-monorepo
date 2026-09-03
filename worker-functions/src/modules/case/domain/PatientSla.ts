/**
 * PatientSla — SLA de inatividade do funil de pacientes (Fase 4).
 *
 * Cada estágio ativo do funil tem um teto de horas aceitável; passar disso é
 * um `slaBreached` (a recrutadora/admissão precisa agir). Estágios terminais
 * (ACTIVE e os demais estados clínicos v2: ON_HOLD/SEARCHING/REPLACEMENT/SUSPENDED/DISCHARGED) NÃO têm
 * SLA — nada a cobrar. Derivação pura e determinística → testável sem banco.
 *
 * `stageEnteredAt` vem do patient_status_history (MAX(created_at) para o
 * new_value = status atual), com fallback em patients.created_at (migration 254).
 */

/**
 * Teto de horas por status. `null` = sem SLA (não se cobra tempo neste estágio).
 * Configurável: alterar aqui muda o cálculo em todos os consumidores.
 */
export const PATIENT_SLA_THRESHOLDS_HOURS: Readonly<Record<string, number | null>> = {
  SOLICITANTE: 24,
  ADMISSION: 48,
  PENDING_ADMISSION: 72,
  ACTIVE: null,
  // PatientStatus v2 (spec 012): estados clínicos não têm SLA de admissão. SUP-B7: sem
  // derivação por horas (decisão 3) — ON_HOLD/SEARCHING/REPLACEMENT NÃO viram cobrança aqui.
  ON_HOLD: null,
  SEARCHING: null,
  REPLACEMENT: null,
  SUSPENDED: null,
  DISCHARGED: null,
};

export interface PatientSlaFields {
  /** Instante em que o paciente entrou no estágio atual (ISO), ou null. */
  stageEnteredAt: string | null;
  /** Horas inteiras (floor) desde stageEnteredAt, ou null se sem âncora. */
  hoursInStage: number | null;
  /** Teto de horas do estágio, ou null quando o estágio não tem SLA. */
  slaThresholdHours: number | null;
  /** true quando há teto e hoursInStage o ultrapassa. */
  slaBreached: boolean;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Deriva os campos de SLA a partir do status e do instante de entrada no estágio.
 *
 * @param status   status atual do paciente (pode ser null para status ClickUp não reconhecido)
 * @param stageEnteredAt  quando entrou no estágio (Date) ou null
 * @param now      relógio injetável (default: agora) — determinismo nos testes
 */
export function derivePatientSla(
  status: string | null,
  stageEnteredAt: Date | null,
  now: Date = new Date(),
): PatientSlaFields {
  const slaThresholdHours =
    status != null ? PATIENT_SLA_THRESHOLDS_HOURS[status] ?? null : null;

  if (!stageEnteredAt) {
    return { stageEnteredAt: null, hoursInStage: null, slaThresholdHours, slaBreached: false };
  }

  const hoursInStage = Math.max(
    0,
    Math.floor((now.getTime() - stageEnteredAt.getTime()) / MS_PER_HOUR),
  );
  const slaBreached = slaThresholdHours != null && hoursInStage > slaThresholdHours;

  return {
    stageEnteredAt: stageEnteredAt.toISOString(),
    hoursInStage,
    slaThresholdHours,
    slaBreached,
  };
}
