/**
 * src/modules/anacare-hours/application/AnaCarePatientMonthAggregator.ts
 *
 * Função PURA (sem I/O) que reduz os turnos crus de UMA reserva a uma linha agregada por paciente
 * (D361, fase-6.md F6.1) — o mesmo shape que `anacare_patient_month` (migration 441) grava.
 * Chamada pelo `AnaCareHoursSyncRunner` para cada reserva, ANTES de `upsertReplacingForRun`;
 * testável isolada, sem precisar do runner nem do banco.
 *
 * Regras (espelham o que a lista já mostra hoje, `AnaCareHoursMapper`/`selectors.ts` do front):
 *   - `shiftsCount` = nº de turnos.
 *   - `providersCount` = nº de `anaCareNurseId` DISTINTOS.
 *   - `hoursActualSum` = soma de `computeActualHours` (mesma função do mapper — só turnos com
 *     check-in E checkout entram na soma; `null` não soma nada).
 *   - `hoursScheduledSumMissingActual` = soma de `hoursScheduledOf` (mesma função do mapper) SÓ
 *     dos turnos sem hora real — as duas colunas existem porque a lista tem um alternador de modo
 *     (`totalHours(shifts, mode)`, `selectors.ts:36-47` do front); colapsar em uma mataria um modo.
 *   - `originSinCheckin`/`originWebAdmin`/`originApp` = mesma classificação de
 *     `AnaCareHoursMapper.mapShift`: `origin = checkinSource === null ? 'sin_checkin' : checkinSource`.
 *   - `patientFirstName`/`patientLastName` = mesma regra de `AnaCareHoursMapper.groupIntoPatients`
 *     para o nome do paciente: o PRIMEIRO turno (na ordem recebida) cujo nome não é vazio vence, os
 *     demais não sobrescrevem — e primeiro/último nome vêm do MESMO turno (nunca misturados de
 *     turnos diferentes).
 */

import { computeActualHours, hoursScheduledOf } from './AnaCareHoursMapper';
import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { AnaCarePatientMonthAggregate } from '../domain/AnaCarePatientMonth';

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Agrega os turnos de UM ÚNICO paciente (já filtrados pelo chamador) — ver `aggregateByPatient`
 * para agrupar uma lista mista de vários pacientes antes de chamar esta função.
 */
export function aggregatePatientMonth(anaCarePatientId: string, shifts: readonly SourceShiftDTO[]): AnaCarePatientMonthAggregate {
  const nurseIds = new Set<string>();
  let hoursActualSum = 0;
  let hoursScheduledSumMissingActual = 0;
  let originSinCheckin = 0;
  let originWebAdmin = 0;
  let originApp = 0;
  let patientFirstName: string | undefined;
  let patientLastName: string | undefined;
  let nameLocked = false;

  for (const s of shifts) {
    nurseIds.add(s.anaCareNurseId);

    const actual = computeActualHours(s);
    if (actual !== null) {
      hoursActualSum += actual;
    } else {
      hoursScheduledSumMissingActual += hoursScheduledOf(s.scheduledStart, s.scheduledEnd);
    }

    if (s.checkinSource === null) originSinCheckin += 1;
    else if (s.checkinSource === 'web_admin') originWebAdmin += 1;
    else originApp += 1;

    if (!nameLocked) {
      const firstName = nonEmpty(s.patientFirstName);
      const lastName = nonEmpty(s.patientLastName);
      if (firstName || lastName) {
        patientFirstName = firstName;
        patientLastName = lastName;
        nameLocked = true;
      }
    }
  }

  return {
    anaCarePatientId,
    patientFirstName,
    patientLastName,
    providersCount: nurseIds.size,
    shiftsCount: shifts.length,
    // Arredondado a 2 casas (mesma resolução de `hoursBetween`/`hoursScheduledOf` do mapper) —
    // soma de números já arredondados pode acumular ruído de ponto flutuante além da 2ª casa.
    hoursActualSum: Math.round(hoursActualSum * 100) / 100,
    hoursScheduledSumMissingActual: Math.round(hoursScheduledSumMissingActual * 100) / 100,
    originSinCheckin,
    originWebAdmin,
    originApp,
  };
}

/**
 * Agrupa uma lista MISTA de turnos (vários pacientes, ex.: o `shifts` que uma reserva devolve) por
 * `anaCarePatientId` e agrega cada grupo — usada pelo runner, que não sabe a priori quantos
 * pacientes vieram numa chamada a `source.listShifts`.
 */
export function aggregateByPatient(shifts: readonly SourceShiftDTO[]): AnaCarePatientMonthAggregate[] {
  const byPatient = new Map<string, SourceShiftDTO[]>();
  for (const s of shifts) {
    if (!byPatient.has(s.anaCarePatientId)) byPatient.set(s.anaCarePatientId, []);
    byPatient.get(s.anaCarePatientId)!.push(s);
  }
  return [...byPatient.entries()].map(([anaCarePatientId, patientShifts]) => aggregatePatientMonth(anaCarePatientId, patientShifts));
}
