/**
 * ServiceCoverageCalculator — fonte única das horas cobertas do serviço contratado
 * (`2026-09-23a#REGRA-24`; spec delta "O itinerário é a fonte única das horas cobertas"). A
 * entrada vem de `patient_itinerary_slot` + `patient_itinerary_assignment` (lidas por
 * `PatientItineraryReader`); a alocação antiga NÃO entra (critério 11). A ocupação por endereço é
 * OUTRA grandeza e não é importada aqui. Função pura: sem `Date`/`Intl` — vigência é comparação de
 * string `YYYY-MM-DD`. Nenhum import além de tipos locais (`ItinerarySchedule`, mesmo domínio).
 *
 * Unidade: `cobertas` é horas/semana. `weekly_hours` é horas/semana pelo nome; `authorized_hours`
 * não declara período — por isso `contratadas` é copiado, nunca calculado, e esta função não
 * compara os dois nem devolve "faltam" (quem monta o par é a Fase 8, depois da rota).
 */
import { slotMinutes } from './ItinerarySchedule';

/**
 * Tipo nominal: o valor só nasce dentro de `computeServiceCoverage` (`as ServiceWeeklyCoveredHours`
 * num lugar só). Impede que outra grandeza (ex: a ocupação por endereço, `number` cru) seja
 * atribuída ou comparada a `cobertas` sem conversão explícita.
 */
export type ServiceWeeklyCoveredHours = number & { readonly __unit: 'service-weekly-covered-hours' };

/**
 * Fonte única do conjunto fechado de status da alocação: o CHECK `pia_status_check` da
 * migration 480 fixa os 3 valores, e esta é a única declaração TS deles no backend.
 * `PatientItineraryReader` (infra) e `itinerarySchemas` (interfaces) importam daqui —
 * infra e interfaces podem depender do domínio, nunca o contrário.
 */
export const ITINERARY_ASSIGNMENT_STATUSES = ['ACTIVE', 'ENDED', 'CANCELLED'] as const;
export type ItineraryAssignmentStatus = (typeof ITINERARY_ASSIGNMENT_STATUSES)[number];

export interface ServiceCoverageAssignment {
  validFrom: string;
  validTo: string | null;
  status: ItineraryAssignmentStatus;
}

export interface ServiceCoverageSlot {
  weekday: number;
  startTime: string;
  endTime: string;
  active: boolean;
  assignments: readonly ServiceCoverageAssignment[];
}

export interface ServiceCoverageInput {
  contractedHours: { weekly: number | null; authorized: number | null };
  slots: readonly ServiceCoverageSlot[];
  asOf: string;
}

export interface ServiceCoverageSlotResult extends ServiceCoverageSlot {
  hours: number;
  covered: boolean;
}

export interface ServiceCoverage {
  contratadas: { weekly: number | null; authorized: number | null };
  cobertas: ServiceWeeklyCoveredHours;
  slots: ServiceCoverageSlotResult[];
}

/** Vigente: ACTIVE e `asOf` dentro de `[validFrom, validTo]` — `validTo` é inclusivo (último dia trabalhado). */
function isVigente(assignment: ServiceCoverageAssignment, asOf: string): boolean {
  return (
    assignment.status === 'ACTIVE' &&
    assignment.validFrom <= asOf &&
    (assignment.validTo === null || assignment.validTo >= asOf)
  );
}

/**
 * `covered` = slot `active` e ≥ 1 alocação vigente (N prestadores vigentes no mesmo slot contam o
 * slot uma vez só — P2, não multiplica horas). `cobertas` = soma dos MINUTOS dos slots `covered`,
 * dividida por 60 uma vez no fim (sem deriva de ponto flutuante por soma de frações).
 */
export function computeServiceCoverage(input: ServiceCoverageInput): ServiceCoverage {
  const { contractedHours, slots, asOf } = input;

  let coveredMinutes = 0;
  const resultSlots: ServiceCoverageSlotResult[] = slots.map((slot) => {
    const minutes = slotMinutes(slot.startTime, slot.endTime);
    const hours = minutes / 60;
    const hasVigente = slot.assignments.some((assignment) => isVigente(assignment, asOf));
    const covered = slot.active && hasVigente;
    if (covered) coveredMinutes += minutes;
    return { ...slot, hours, covered };
  });

  const cobertas = (coveredMinutes / 60) as ServiceWeeklyCoveredHours;

  return {
    contratadas: { weekly: contractedHours.weekly, authorized: contractedHours.authorized },
    cobertas,
    slots: resultSlots,
  };
}
