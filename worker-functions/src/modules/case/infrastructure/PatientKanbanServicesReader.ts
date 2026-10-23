/**
 * PatientKanbanServicesReader — leitura crua do agregado do subcard do Kanban (fase 8, DX-8.4).
 *
 * `readKanbanServices` roda TUDO dentro de `inPatientTransaction` (RLS de país; memória
 * `connect-cru-sem-actor-context-da-500`): UMA consulta só, no client da transação — serviço ativo
 * + a MESMA junção de vaga viva da ficha, agora fonte única em `liveVacancySql.ts`
 * (`ContractedServiceDetailMapper.ts` reusa o mesmo fragmento — achado #5 do gate parcial da Fase
 * 8) + slot + alocação. O pool é pego DENTRO da função (nada no construtor).
 *
 * Datas/horas saem do banco como TEXTO (`to_char`) — mesma regra da fase 7 (o driver `pg`
 * converteria `date`/`time` em `Date` à meia-noite LOCAL do processo).
 *
 * Nenhuma coluna de nome, telefone, diagnóstico ou endereço; nenhuma leitura de
 * `contracted_service_providers`.
 * `readForPatientWith`: a mesma leitura, 1 paciente, no client da transação do escritor, sem a query
 * das ausências — cadeia Fase 15.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import type { ItinerarySlotRow } from './PatientItineraryReader';
import { liveVacancySelect } from './liveVacancySql';
import { slotEndTimeSql, slotVigenteSql } from '@shared/sql/serviceScheduleSql';
import { readOccurrenceInputsByPatient, type OccurrenceInputs } from './occurrenceInputs';
import { UNCOVERED_HORIZON_DAYS } from '../domain/serviceOccurrences';

export interface KanbanServiceRow {
  id: string;
  serviceCode: string;
  liveVacancyId: string | null;
}

/** Um agrupamento por paciente — `slots` é o mesmo formato do itinerário da fase 7 (por serviço). */
export interface KanbanServicesRows {
  patientId: string;
  country: string;
  services: KanbanServiceRow[];
  slots: ItinerarySlotRow[];
  /**
   * Spec 069 (FR-12, P7): faixas × alocações × ausências vivas da janela superconjunto `[CURRENT_DATE - 1, CURRENT_DATE + horizonte]`.
   * Ausente quando o paciente não tem nenhuma faixa tocando a janela (e na leitura `readForPatientWith`, que não lê ocorrência).
   */
  occurrences?: OccurrenceInputs;
}

interface KanbanJoinRow {
  patient_id: string;
  country: string;
  service_id: string;
  service_code: string;
  live_vacancy_id: string | null;
  slot_id: string | null;
  weekday: number | null;
  start_time: string | null;
  duration_minutes: number | null;
  slot_end: string | null;
  assignment_id: string | null;
  worker_id: string | null;
  application_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: ItinerarySlotRow['status'];
}

export class PatientKanbanServicesReader {
  /** `country` filtra como a listagem (`null` = todos os países que a RLS deixa ver). */
  async readKanbanServices(country: 'AR' | 'BR' | null): Promise<KanbanServicesRows[]> {
    return inPatientTransaction((client) => this.run(client, country));
  }

  /**
   * Um paciente só, no client recebido (sem transação própria); `null` quando ele não tem serviço ativo.
   * SEM a 2ª query (ausências): a derivação não as lê — a ausência datada nunca entra na conta.
   */
  async readForPatientWith(client: PoolClient, patientId: string): Promise<KanbanServicesRows | null> {
    return (await this.run(client, null, patientId, false))[0] ?? null;
  }

  private async run(
    client: PoolClient,
    country: 'AR' | 'BR' | null,
    patientId: string | null = null,
    withAbsences = true,
  ): Promise<KanbanServicesRows[]> {
    const res = await client.query<KanbanJoinRow>(
      `WITH svc AS (
         SELECT pcs.id, pcs.patient_id, pcs.service_code, pcs.created_at, p.country
           FROM patient_contracted_services pcs
           JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
          WHERE pcs.active AND ($1::text IS NULL OR p.country = $1) AND ($2::uuid IS NULL OR p.id = $2)
       ), live AS (
         ${liveVacancySelect('jp.contracted_service_id IN (SELECT id FROM svc)')}
       )
       SELECT svc.patient_id, svc.country, svc.id AS service_id, svc.service_code,
              live.id AS live_vacancy_id,
              s.id AS slot_id, s.weekday, to_char(s.start_time,'HH24:MI') AS start_time, s.duration_minutes, ${slotEndTimeSql('s')} AS slot_end,
              a.id AS assignment_id, a.worker_id, a.application_id,
              to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to, a.status
         FROM svc
         LEFT JOIN live ON live.contracted_service_id = svc.id
         LEFT JOIN patient_itinerary_slot s ON s.contracted_service_id = svc.id AND ${slotVigenteSql('s')}
         LEFT JOIN patient_itinerary_assignment a ON a.slot_id = s.id
        ORDER BY svc.patient_id, svc.created_at, svc.id, s.weekday, s.start_time, a.valid_from`,
      [country, patientId],
    );

    const byPatient = new Map<string, KanbanServicesRows>();
    for (const r of res.rows) {
      let patient = byPatient.get(r.patient_id);
      if (!patient) {
        patient = { patientId: r.patient_id, country: r.country, services: [], slots: [] };
        byPatient.set(r.patient_id, patient);
      }
      if (!patient.services.some((svc) => svc.id === r.service_id)) {
        patient.services.push({
          id: r.service_id,
          serviceCode: r.service_code,
          liveVacancyId: r.live_vacancy_id,
        });
      }
      // Linha com `slot_id` NULL = serviço sem faixa: entra em `services`, não gera slot.
      if (r.slot_id != null) {
        patient.slots.push({
          id: r.slot_id,
          contractedServiceId: r.service_id,
          weekday: r.weekday as number,
          startTime: r.start_time as string,
          durationMinutes: r.duration_minutes as number,
          endTime: r.slot_end as string,
          assignmentId: r.assignment_id,
          workerId: r.worker_id,
          applicationId: r.application_id,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          status: r.status,
        });
      }
    }
    if (!withAbsences) return Array.from(byPatient.values());

    // Ocorrências (spec 069, FR-12/P7): as 3 consultas de `occurrenceInputs` rodam UMA vez para TODOS os pacientes do filtro —
    // nunca por card (sem N+1). A janela em SQL é SUPERCONJUNTO (a data de Buenos Aires nunca é menor que a UTC − 1 e o horizonte
    // tem teto em CURRENT_DATE + horizonte): só poda histórico e futuro distante; quem decide a janela exata é o caso de uso
    // com o `asOf` do país. Nenhuma coluna de nome/telefone.
    const occurrences = await readOccurrenceInputsByPatient(client, {
      scopeSql: `pcs.active AND ($1::text IS NULL OR p.country = $1) AND ($2::uuid IS NULL OR p.id = $2)`,
      extraJoin: 'JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL',
      fromSql: 'CURRENT_DATE - 1',
      toSql: `CURRENT_DATE + ${UNCOVERED_HORIZON_DAYS}`,
      params: [country, patientId],
    });
    for (const [pid, inputs] of occurrences) {
      const patient = byPatient.get(pid);
      if (patient) patient.occurrences = inputs; // defensivo: o mesmo filtro de país/ativo da 1ª query
    }

    return Array.from(byPatient.values());
  }
}
