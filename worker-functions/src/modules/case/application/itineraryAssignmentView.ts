/**
 * itineraryAssignmentView — Fase 12, DX-12.5 (2): a visão da alocação no GET do itinerário.
 *
 * `buildServiceCoverages` (`itineraryCoverage.ts`, intocado) monta `slot.assignments` e descarta o
 * `assignmentId` do leitor. Esta função pura roda DEPOIS dele e devolve cada alocação com
 * `allocationId` (o id da linha do leitor) e `displayName` — pareando, por slot, as linhas com
 * `assignmentId !== null` NA MESMA ORDEM em que `buildServiceCoverages` as empilhou (a ordem do
 * leitor). Contagem ou prestador divergente no mesmo slot → erro alto, nunca pareamento errado.
 *
 * `displayName` sai SÓ de alocação vigente (`isVigente`, importado — a vigência não é recalculada
 * aqui); histórico encerrado não gasta KMS nem sai com nome. Quem decifra/projeta o nome é
 * `projectWorkerDisplayNames` (fonte única); aqui só se consulta o mapa já projetado.
 */
import type { ItinerarySlotRow } from '../infrastructure/PatientItineraryReader';
import { isVigente, type ServiceCoverageAssignment } from '../domain/ServiceCoverageCalculator';
import type { PatientItineraryAssignment, PatientItinerarySlot, PatientItineraryService } from './GetPatientItineraryUseCase';
import type { WorkerNameSource } from './workerDisplayNames';

export type PatientItineraryAssignmentView = PatientItineraryAssignment & {
  allocationId: string;
  displayName: string | null;
};

export type PatientItinerarySlotView = Omit<PatientItinerarySlot, 'assignments'> & {
  assignments: PatientItineraryAssignmentView[];
};

export type PatientItineraryServiceView = Omit<PatientItineraryService, 'slots'> & {
  slots: PatientItinerarySlotView[];
};

/** A linha do leitor, quando traz alocação, lida como a alocação que `isVigente` entende. */
function assignmentOf(row: ItinerarySlotRow): ServiceCoverageAssignment {
  return {
    validFrom: row.validFrom as string,
    validTo: row.validTo,
    status: row.status as ServiceCoverageAssignment['status'],
  };
}

function assignmentRowsBySlot(slotRows: ItinerarySlotRow[]): Map<string, ItinerarySlotRow[]> {
  const bySlot = new Map<string, ItinerarySlotRow[]>();
  for (const row of slotRows) {
    if (row.assignmentId === null) continue;
    const list = bySlot.get(row.id) ?? [];
    list.push(row);
    bySlot.set(row.id, list);
  }
  return bySlot;
}

export function withAssignmentIdentity(
  services: PatientItineraryService[],
  slotRows: ItinerarySlotRow[],
  asOf: string,
  displayNameByWorkerId: Map<string, string | null>,
): PatientItineraryServiceView[] {
  const rowsBySlot = assignmentRowsBySlot(slotRows);
  return services.map((service) => ({
    ...service,
    slots: service.slots.map((slot) => {
      const rows = rowsBySlot.get(slot.id) ?? [];
      if (rows.length !== slot.assignments.length) throw new Error('itinerary assignment pairing mismatch');
      return {
        ...slot,
        assignments: slot.assignments.map((assignment, index) => {
          const row = rows[index];
          if (row.workerId !== assignment.workerId) throw new Error('itinerary assignment pairing mismatch');
          return {
            ...assignment,
            allocationId: row.assignmentId as string,
            displayName: isVigente(assignment, asOf) ? (displayNameByWorkerId.get(assignment.workerId) ?? null) : null,
          };
        }),
      };
    }),
  }));
}

/**
 * Os `workerId` DISTINTOS das alocações VIGENTES em `asOf` dos serviços devolvidos, com a fonte
 * CIFRADA do nome — a entrada de `projectWorkerDisplayNames`. Linha de slot fora de `services`
 * (serviço inativo) não entra.
 */
export function workerIdsToName(
  slotRows: ItinerarySlotRow[],
  services: PatientItineraryService[],
  asOf: string,
): Map<string, WorkerNameSource> {
  const slotIds = new Set(services.flatMap((service) => service.slots.map((slot) => slot.id)));
  const sourceByWorkerId = new Map<string, WorkerNameSource>();
  for (const row of slotRows) {
    if (row.assignmentId === null || !slotIds.has(row.id)) continue;
    const workerId = row.workerId as string;
    if (sourceByWorkerId.has(workerId) || !isVigente(assignmentOf(row), asOf)) continue;
    sourceByWorkerId.set(workerId, {
      firstNameEncrypted: row.firstNameEncrypted ?? null,
      lastNameEncrypted: row.lastNameEncrypted ?? null,
    });
  }
  return sourceByWorkerId;
}
