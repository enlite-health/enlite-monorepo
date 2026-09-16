/**
 * src/modules/anacare-hours/application/AnaCareHoursMapper.ts
 *
 * Junta o turno da FONTE (`SourceShiftDTO`, adapter falso em F1) com a validação nossa
 * (`ValidationRow`, pode não existir = pendente) e projeta no shape do contrato
 * (`AnaCareShift`/`AnaCarePatient`/`AnaCareMonthSnapshot`) que o front consome — mesma
 * interface do protótipo (spec §Contrato de dados).
 *
 * Nome do PRESTADOR (`AnaCareProvider.name`) é resolvido pelo `AnaCareHoursService` (lookup em
 * lote pós-agrupamento), não aqui — este mapper só monta a estrutura de agrupamento, sem tocar
 * banco/KMS (mantém puro/testável). Lado PACIENTE nunca resolve nome (spec 003, reconciliação
 * bloqueada) — documentado em DIVERGÊNCIAS no fecho da fase.
 */

import type { AnaCareRetratoSourceStatus, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
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

/**
 * Agrupa turnos JÁ MAPEADOS por paciente → prestador (id da fonte). Só monta a estrutura —
 * `provider.name` NÃO é resolvido aqui (responsabilidade do `AnaCareHoursService`, que faz o
 * lookup em lote depois de agrupar); paciente nunca ganha nome (fora de escopo, spec 003).
 */
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
      providers.push({ anaCareId: providerAnaCareId, shifts: providerShifts });
    }
    patients.push({ anaCareId, providers });
  }
  return patients;
}

export function buildSnapshot(month: string, patients: AnaCarePatient[], retrato: AnaCareRetratoSourceStatus): AnaCareMonthSnapshot {
  return {
    month,
    updatedAt: new Date().toISOString(),
    // Vem da FONTE agora (`AnaCareShiftsSource.getRetratoStatus`) — fase 1 (adapter falso) sempre
    // devolve `{ stale: false, circuitBreakerOpen: false }`; staleness real é do job da fase 2/4
    // (sob PARE do lex). O bloqueio de escrita (`AnaCareHoursService.assertRetratoOk`) lê a MESMA
    // fonte, não este snapshot — as duas camadas convergem porque comem do mesmo `getRetratoStatus`.
    stale: retrato.stale,
    circuitBreakerOpen: retrato.circuitBreakerOpen,
    patients,
  };
}
