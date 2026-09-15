/**
 * src/modules/anacare-hours/application/AnaCareHoursMapper.ts
 *
 * Junta o turno da FONTE (`SourceShiftDTO`, adapter falso em F1) com a validação nossa
 * (`ValidationRow`, pode não existir = pendente) e projeta no shape do contrato
 * (`AnaCareShift`/`AnaCarePatient`/`AnaCareMonthSnapshot`) que o front consome — mesma
 * interface do protótipo (spec §Contrato de dados).
 *
 * Nome/vínculo (`linked`/`name`) SEMPRE `false`/`undefined` nesta fase: a reconciliação
 * paciente/prestador (spec 003) é PRÉ-REQUISITO adiado — fase 1 só entrega turnos, horas,
 * origem e status (documentado em DIVERGÊNCIAS no fecho da fase).
 */

import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { ValidationRow } from '../infrastructure/ShiftHoursValidationRepository';
import type { AnaCareMonthSnapshot, AnaCarePatient, AnaCareProvider, AnaCareShift, ValidationStatus } from '../domain/AnaCareShift';

const STATUS_MAP: Record<ValidationRow['status'], ValidationStatus> = {
  pendente: 'pendiente',
  validado: 'validado',
  contestado: 'contestado',
};

function hoursBetween(startIso: string, endIso: string): number {
  return Math.round(((new Date(endIso).getTime() - new Date(startIso).getTime()) / (1000 * 60 * 60)) * 100) / 100;
}

/**
 * `canReadNote` — espelha a célula clínica (`patient_clinical:read`, backlog D345, mas o
 * contrato já reserva o corte: sem a célula a nota NUNCA sai no payload, mesmo cifrada).
 */
export function mapShift(source: SourceShiftDTO, validation: ValidationRow | undefined, canReadNote: boolean, decryptedNote: string | null): AnaCareShift {
  const status = STATUS_MAP[validation?.status ?? 'pendente'];
  const hoursActual = status === 'validado' ? validation!.approvedHours : source.durationHours;
  const origin = source.checkinSource === null ? 'sin_checkin' : source.checkinSource;

  const shift: AnaCareShift = {
    id: source.sourceShiftId,
    date: source.date,
    scheduledStart: source.scheduledStart,
    scheduledEnd: source.scheduledEnd,
    actualStart: source.actualStart,
    actualEnd: source.actualEnd,
    hoursActual,
    hoursScheduled: hoursBetween(source.scheduledStart, source.scheduledEnd),
    origin,
    status,
    anaCareShiftId: source.sourceShiftId,
  };

  if (status === 'validado' && validation?.validatedBy) {
    shift.validatedBy = { id: validation.validatedBy, name: validation.validatedByName ?? validation.validatedBy };
    shift.validatedAt = validation.validatedAt ?? undefined;
  }
  if (status === 'contestado' && validation?.reason) {
    shift.contestReason = validation.reason;
    if (canReadNote) shift.contestNote = decryptedNote ?? undefined;
  }
  return shift;
}

/** Agrupa turnos JÁ MAPEADOS por paciente → prestador (id da fonte, sem vínculo em F1). */
export function groupIntoPatients(shifts: ReadonlyArray<{ shift: AnaCareShift; anaCarePatientId: string; anaCareNurseId: string }>): AnaCarePatient[] {
  const byPatient = new Map<string, Map<string, AnaCareShift[]>>();
  for (const { shift, anaCarePatientId, anaCareNurseId } of shifts) {
    if (!byPatient.has(anaCarePatientId)) byPatient.set(anaCarePatientId, new Map());
    const byProvider = byPatient.get(anaCarePatientId)!;
    if (!byProvider.has(anaCareNurseId)) byProvider.set(anaCareNurseId, []);
    byProvider.get(anaCareNurseId)!.push(shift);
  }

  const patients: AnaCarePatient[] = [];
  for (const [anaCareId, byProvider] of byPatient) {
    const providers: AnaCareProvider[] = [];
    for (const [providerAnaCareId, providerShifts] of byProvider) {
      providers.push({ anaCareId: providerAnaCareId, linked: false, shifts: providerShifts });
    }
    patients.push({ anaCareId, linked: false, providers });
  }
  return patients;
}

export function buildSnapshot(month: string, patients: AnaCarePatient[]): AnaCareMonthSnapshot {
  return {
    month,
    updatedAt: new Date().toISOString(),
    // Fase 1 (adapter falso): o retrato é sempre "fresco" — staleness/disjuntor são do job REAL
    // (fase 2/4, sob PARE do lex). Documentado em PENDÊNCIAS.
    stale: false,
    circuitBreakerOpen: false,
    patients,
  };
}
