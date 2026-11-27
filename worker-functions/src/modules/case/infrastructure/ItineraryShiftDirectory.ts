/**
 * ItineraryShiftDirectory — resolve `occurrence_id` → o turno do itinerário (emenda 077 §5.2): paciente, serviço, país, fim previsto e `is_test`.
 * A faixa vem de `occurrenceWindowOf` (a MESMA função do itinerário do prestador) e o universo de `WORKER_SCOPE_SQL` + `expandServiceOccurrences`
 * (nada reimplementado). `occurrence_id` = uuid v5 de "slot|data|worker" (`occurrenceIdOf`): só devolve a ocorrência que EXISTE no itinerário do
 * worker; o resto (R1/R3) fica de fora. Lê só ids, horários, país e as marcas `is_test`; nenhuma coluna de nome, endereço ou clínico.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { expandServiceOccurrences } from '../domain/serviceOccurrences';
import { occurrenceWindowOf } from '../domain/occurrenceWindow';
import type { ShiftDirectory, ShiftFacts } from '../application/ports/CoordinationAlertPorts';
import { readOccurrenceInputsByPatient } from './occurrenceInputs';
import { occurrenceIdOf, WORKER_SCOPE_SQL } from './WorkerItineraryReader';

export class ItineraryShiftDirectory implements ShiftDirectory {
  private poolMemo?: Pool;

  constructor(pool?: Pool) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async resolve(candidates: ReadonlyArray<{ occurrenceId: string; workerId: string }>, window: { from: string; to: string }): Promise<Map<string, ShiftFacts>> {
    const wanted = new Map(candidates.map((c) => [c.occurrenceId, c.workerId]));
    const workerIds = [...new Set(candidates.map((c) => c.workerId))];
    const found = new Map<string, ShiftFacts>();
    if (workerIds.length === 0) return found;

    await withActorContext(this.pool, async (client) => {
      const workerTest = await this.workerTestFlags(client, workerIds);
      for (const workerId of workerIds) {
        const byPatient = await readOccurrenceInputsByPatient(client, {
          scopeSql: WORKER_SCOPE_SQL,
          extraJoin: 'JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL',
          fromSql: '$2::date',
          toSql: '$3::date',
          params: [workerId, window.from, window.to],
        });
        const patients = await this.patientFlags(client, [...byPatient.keys()]);
        for (const [patientId, inputs] of byPatient) {
          const patient = patients.get(patientId);
          if (!patient) continue;
          for (const o of expandServiceOccurrences(inputs.slots, inputs.assignments, inputs.absences, window.from, window.to, { workerId })) {
            if (o.workerId !== workerId || o.assignmentId === null) continue;
            const occurrenceId = occurrenceIdOf(o.slotId, o.date, workerId);
            if (wanted.get(occurrenceId) !== workerId) continue;
            const { startsAt, endsAt } = occurrenceWindowOf({ date: o.date, startTime: o.startTime, endTime: o.endTime, country: patient.country });
            found.set(occurrenceId, {
              occurrenceId, slotId: o.slotId, onDate: o.date, workerId, serviceId: o.serviceId, patientId, country: patient.country,
              startsAt, endsAt, startTime: o.startTime, endTime: o.endTime, isTest: patient.isTest || workerTest.get(workerId) === true,
            });
          }
        }
      }
    });
    return found;
  }

  private async workerTestFlags(client: PoolClient, workerIds: string[]): Promise<Map<string, boolean>> {
    const res = await client.query<{ id: string; is_test: boolean }>(`SELECT id, is_test FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]);
    return new Map(res.rows.map((r) => [r.id, r.is_test === true]));
  }

  private async patientFlags(client: PoolClient, patientIds: string[]): Promise<Map<string, { country: string; isTest: boolean }>> {
    if (patientIds.length === 0) return new Map();
    const res = await client.query<{ id: string; country: string; is_test: boolean }>(`SELECT id, country, is_test FROM patients WHERE id = ANY($1::uuid[])`, [patientIds]);
    return new Map(res.rows.map((r) => [r.id, { country: r.country, isTest: r.is_test === true }]));
  }
}
