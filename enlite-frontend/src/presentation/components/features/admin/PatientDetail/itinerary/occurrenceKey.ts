import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';

/** Chave e testid do turno: `slotId + data` — a faixa sem alocação não tem `assignmentId` (spec 069, FR-12). */
export const occurrenceKey = (event: Pick<PatientItineraryEvent, 'slotId' | 'date'>): string => `${event.slotId}-${event.date}`;
