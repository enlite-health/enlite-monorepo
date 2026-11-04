/**
 * UncoveredAlertReader — as leituras do alerta diário "Sin cubrir" (spec 069 F4). SÓ leitura, no client da transação do chamador.
 *
 * `readUniverse`: para o país e a janela `[asOf, asOf + 6]`, as entradas de ocorrência (faixas × alocações × ausências — a MESMA
 * leitura do Kanban e do GET) + os fatos do universo (`readAlertUniverseFacts`) de cada paciente com faixa. A REGRA do universo não
 * mora aqui: é `itineraryAlerts.uncoveredDayAlerts`, chamada pelo caso de uso (um conceito, uma regra).
 * `readLabels`: nome de exibição (a MESMA projeção do Kanban/lista: nome + sobrenome do paciente, senão o responsável primário) e código do
 * serviço — só dos pacientes que TÊM alerta (o nome só entra no e-mail, nunca no payload in-app nem em log).
 */
import type { PoolClient } from 'pg';
import { uncoveredWindow } from '../domain/serviceOccurrences';
import type { AlertUniverseFacts } from '../domain/itineraryAlerts';
import { readAlertUniverseFacts, readOccurrenceInputsByPatient, type OccurrenceInputs } from './occurrenceInputs';

export interface UniversePatient {
  patientId: string;
  facts: AlertUniverseFacts;
  inputs: OccurrenceInputs;
}

export interface PatientServiceLabel {
  patientId: string;
  serviceId: string;
  patientName: string;
  serviceCode: string;
}

export class UncoveredAlertReader {
  async readUniverse(client: PoolClient, country: string, asOf: string): Promise<UniversePatient[]> {
    const { from, to } = uncoveredWindow(asOf);
    const byPatient = await readOccurrenceInputsByPatient(client, {
      scopeSql: 'pcs.active AND p.country = $1',
      extraJoin: 'JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL',
      fromSql: '$2::date',
      toSql: '$3::date',
      params: [country, from, to],
    });
    const facts = await readAlertUniverseFacts(client, [...byPatient.keys()]);
    return [...byPatient.entries()].flatMap(([patientId, inputs]) => {
      const f = facts.get(patientId);
      return f ? [{ patientId, facts: f, inputs }] : [];
    });
  }

  async readLabels(client: PoolClient, patientIds: readonly string[]): Promise<PatientServiceLabel[]> {
    if (patientIds.length === 0) return [];
    const res = await client.query<{ patient_id: string; service_id: string; patient_name: string; service_code: string }>(
      `SELECT p.id AS patient_id, pcs.id AS service_id, pcs.service_code,
              COALESCE(
                NULLIF(btrim(concat_ws(' ', p.first_name, NULLIF(p.last_name, ''))), ''),
                (SELECT NULLIF(btrim(concat_ws(' ', r.first_name, NULLIF(r.last_name, ''))), '')
                   FROM patient_responsibles r
                  WHERE r.patient_id = p.id AND r.is_primary AND r.active
                  ORDER BY r.display_order, r.created_at
                  LIMIT 1),
                'Paciente sin nombre'
              ) AS patient_name
         FROM patients p
         JOIN patient_contracted_services pcs ON pcs.patient_id = p.id AND pcs.active
        WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
      [patientIds],
    );
    return res.rows.map((r) => ({ patientId: r.patient_id, serviceId: r.service_id, patientName: r.patient_name, serviceCode: r.service_code }));
  }
}
