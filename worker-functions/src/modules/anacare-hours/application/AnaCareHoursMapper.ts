/**
 * src/modules/anacare-hours/application/AnaCareHoursMapper.ts
 *
 * Junta o turno da FONTE (`SourceShiftDTO`, adapter falso em F1) com a validação nossa
 * (`ValidationRow`, pode não existir = pendente) e projeta no shape do contrato
 * (`AnaCareShift`/`AnaCarePatient`/`AnaCareMonthSnapshot`) que o front consome — mesma
 * interface do protótipo (spec §Contrato de dados).
 *
 * Vínculo de PRESTADOR (D349, item 1): `groupIntoPatients` recebe `providerLinks` — a presença
 * da chave (`anaCareNurseId`) na Map já resolve `linked`, e o valor (nome, ou `undefined` sem a
 * célula `worker_contact:read`) resolve `name`. Quem monta essa Map é `AnaCareHoursService`
 * (lookup em `workers.ana_care_id`, D195/`MirrorWorkerService`).
 *
 * Vínculo de PACIENTE continua SEMPRE `false`/`undefined` — bloqueado por decisão (D349 item 2):
 * não existe hoje ID nosso do lado do paciente no Ana Care, nem API de leitura de paciente.
 */

import type { AnaCareRetratoSourceStatus, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { ValidationRow } from '../infrastructure/ShiftHoursValidationRepository';
import type { AnaCareMonthSnapshot, AnaCarePatient, AnaCareProvider, AnaCareShift, AnaCareSnapshotState, ValidationStatus } from '../domain/AnaCareShift';

const STATUS_MAP: Record<ValidationRow['status'], ValidationStatus> = {
  pendente: 'pendiente',
  validado: 'validado',
  contestado: 'contestado',
};

function hoursBetween(startIso: string, endIso: string): number {
  return Math.round(((new Date(endIso).getTime() - new Date(startIso).getTime()) / (1000 * 60 * 60)) * 100) / 100;
}

/**
 * Horas PREVISTAS — SEMPRE um número real no contrato (`AnaCareShift.hoursScheduled: number`,
 * nunca `null`/`NaN`). Item 7 (revisão de PR): antes, `AnaCareShiftRepository.toDTO` mascarava
 * `planned_start`/`planned_end` ausentes como `''`, e `hoursBetween('', '')` devolvia `NaN` — que o
 * JSON serializa como `null`, mentindo silenciosamente sobre um campo tipado `number`. Agora a
 * fonte propaga `null` explícito (nunca `''`) até aqui, e SEM o previsto conhecido o valor seguro é
 * `0` (mesmo padrão de "ausência de dado nunca produz um número inválido" de `computeActualHours`).
 */
function hoursScheduledOf(scheduledStart: string | null, scheduledEnd: string | null): number {
  if (!scheduledStart || !scheduledEnd) return 0;
  return hoursBetween(scheduledStart, scheduledEnd);
}

/**
 * Horas REALMENTE trabalhadas — SEMPRE de `actualStart`/`actualEnd` (check-in/checkout), nunca do
 * previsto. `null` quando falta qualquer um dos dois (turno sem check-in, ou em andamento sem
 * checkout ainda) — medido 17/09: a fonte não tem campo de hora trabalhada, só previsto
 * (`duration`), inclusive em turno não finalizado (`is_finalized=false`).
 */
export function computeActualHours(source: Pick<SourceShiftDTO, 'actualStart' | 'actualEnd'>): number | null {
  if (!source.actualStart || !source.actualEnd) return null;
  return hoursBetween(source.actualStart, source.actualEnd);
}

/**
 * `canReadNote` — espelha a célula clínica (`patient_clinical:read`, backlog D345, mas o
 * contrato já reserva o corte: sem a célula a nota NUNCA sai no payload, mesmo cifrada).
 */
export function mapShift(source: SourceShiftDTO, validation: ValidationRow | undefined, canReadNote: boolean, decryptedNote: string | null): AnaCareShift {
  const status = STATUS_MAP[validation?.status ?? 'pendente'];
  const hoursActual = status === 'validado' ? validation!.approvedHours : computeActualHours(source);
  const origin = source.checkinSource === null ? 'sin_checkin' : source.checkinSource;

  const shift: AnaCareShift = {
    id: source.sourceShiftId,
    date: source.date,
    // Contrato de wire (`AnaCareShift.scheduledStart/scheduledEnd: string`) não muda — o `''` de
    // fallback fica só AQUI, na fronteira de exibição, nunca escondido dentro do cálculo de horas
    // (ver `hoursScheduledOf`, que usa o `null` original antes desse fallback).
    scheduledStart: source.scheduledStart ?? '',
    scheduledEnd: source.scheduledEnd ?? '',
    actualStart: source.actualStart,
    actualEnd: source.actualEnd,
    hoursActual,
    hoursScheduled: hoursScheduledOf(source.scheduledStart, source.scheduledEnd),
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
 * Agrupa turnos JÁ MAPEADOS por paciente → prestador.
 *
 * `providerLinks`: chave = `anaCareNurseId`. Presença da chave = `linked: true`; o valor é o
 * nome já decidido pelo chamador (`undefined` quando o ator não tem `worker_contact:read`, mesmo
 * que o vínculo exista — D349/D344). Ausência da chave = `linked: false` (sem vínculo em `workers`).
 * Paciente permanece sempre sem vínculo (item 2 da D349, bloqueado).
 */
export function groupIntoPatients(
  shifts: ReadonlyArray<{ shift: AnaCareShift; anaCarePatientId: string; anaCareNurseId: string }>,
  providerLinks: ReadonlyMap<string, string | undefined> = new Map(),
): AnaCarePatient[] {
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
      const linked = providerLinks.has(providerAnaCareId);
      const name = linked ? providerLinks.get(providerAnaCareId) : undefined;
      providers.push({ anaCareId: providerAnaCareId, linked, name, shifts: providerShifts });
    }
    patients.push({ anaCareId, linked: false, providers });
  }
  return patients;
}

export function buildSnapshot(
  month: string,
  patients: AnaCarePatient[],
  retrato: AnaCareRetratoSourceStatus & {
    /** Item 3: `freshness.shifts === 0` — o retrato NUNCA foi sincronizado para este mês (distinto de "sincronizou, mas ficou velho"). Default `false` por compat com chamadores antigos. */
    naoConstruido?: boolean;
  },
): AnaCareMonthSnapshot {
  const naoConstruido = retrato.naoConstruido ?? false;
  const snapshotState: AnaCareSnapshotState = naoConstruido ? 'nao_construido' : retrato.stale ? 'velho' : 'fresco';
  return {
    month,
    updatedAt: new Date().toISOString(),
    // Vem da FONTE agora (`AnaCareShiftsSource.getRetratoStatus`) — fase 1 (adapter falso) sempre
    // devolve `{ stale: false, circuitBreakerOpen: false }`; staleness real é do job da fase 2/4
    // (sob PARE do lex). O bloqueio de escrita (`AnaCareHoursService.assertRetratoOk`) lê a MESMA
    // fonte, não este snapshot — as duas camadas convergem porque comem do mesmo `getRetratoStatus`.
    stale: retrato.stale,
    snapshotState,
    circuitBreakerOpen: retrato.circuitBreakerOpen,
    patients,
  };
}
