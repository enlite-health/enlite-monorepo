/**
 * Portas do "Cómo llegar" da cuidadora (spec 077 FR-46, D659). O use case `GetWorkerTransitToPatientUseCase` só conhece
 * estas interfaces e o domínio (`transitRoute`); banco, transação e Google ficam nos adaptadores de `../../infrastructure/`.
 */
import type { RawRoute } from '../../domain/transitRoute';

export interface TransitPoint {
  lat: number;
  lng: number;
}

/** Prestador pelo `uid` do token e a zona viva mais recente com ponto (D659: o critério do /admin/mapa). */
export type WorkerZoneLookup =
  | { found: false }
  | { found: true; workerId: string; disabled: boolean; zone: { label: string; point: TransitPoint } | null };

export interface WorkerZoneReader {
  findByAuthUid(authUid: string): Promise<WorkerZoneLookup>;
}

/** Item do itinerário do prestador para um `patient_ref`, já com o recorte do FR-44 aplicado pelo dono (o Reader). */
export interface PatientItineraryItem {
  /** true sse o item leva endereço (ocorrência em [hoje, hoje+7] da alocação ACTIVE). */
  hasAddress: boolean;
  /** `patients.country` (CHECK AR|BR). */
  country: string;
  /** Ponto na grade de ~20 m; null sem lat/lng. */
  point: TransitPoint | null;
}

export interface PatientItineraryPort {
  itemsOf(workerId: string, patientRef: string, today: string): Promise<PatientItineraryItem[]>;
}

/** A chamada ao Google: `called` = a requisição saiu (false só sem chave). */
export interface TransitPort {
  transitCall(origin: TransitPoint, destination: TransitPoint): Promise<{ called: boolean; routes: RawRoute[] }>;
}
