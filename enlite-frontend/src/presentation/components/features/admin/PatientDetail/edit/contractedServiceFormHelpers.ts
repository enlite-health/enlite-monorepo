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
