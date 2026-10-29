import type { ContractedServiceScheduleSlot } from '@domain/entities/PatientContractedService';

// Extraído de `ContractedServiceFormRow` (teto de 400 linhas, spec 027 Fase 3). Só FORMA mudou de lugar.

export function empty(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export function numOrNull(v: string): number | null {
  const s = v.trim();
  return s === '' ? null : Number(s);
}

/** `[]` no formulário é "ainda sem horário" e viaja como `null` (migration 330). */
export function scheduleOrNull(slots: ContractedServiceScheduleSlot[]): ContractedServiceScheduleSlot[] | null {
  return slots.length === 0 ? null : slots;
}

export type SaveErrorKind =
  | { kind: 'overlap' }
  | { kind: 'message'; key: string }
  | { kind: 'addressLocked'; reason: 'LIVE_VACANCY' | 'ALLOCATION' }
  | { kind: 'generic' };

/** Duck-typing no `code` (409 SLOT_OVERLAP e os 422 da Trava B): sem depender da classe de erro do service. Chaves de `admin.patients.editDrawer`. */
export function classifySaveError(e: unknown): SaveErrorKind {
  const err = e as { code?: string; details?: { field?: string; reason?: string } } | null;
  switch (err?.code) {
    case 'SLOT_OVERLAP': return { kind: 'overlap' };
    case 'PROVIDERS_NEEDED_BELOW_OCCUPANCY': return { kind: 'message', key: 'providersNeededBelowOccupancy' };
    case 'PROVIDERS_NEEDED_CANNOT_CLEAR': return { kind: 'message', key: 'providersNeededCannotClear' };
    case 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY':
      return { kind: 'message', key: err.details?.field === 'providers_needed' ? 'providersNeededRequiredByLiveVacancy' : 'serviceFieldRequiredByLiveVacancy' };
    case 'SERVICE_ADDRESS_LOCKED':
      return { kind: 'addressLocked', reason: err.details?.reason === 'LIVE_VACANCY' ? 'LIVE_VACANCY' : 'ALLOCATION' };
    default: return { kind: 'generic' };
  }
}
