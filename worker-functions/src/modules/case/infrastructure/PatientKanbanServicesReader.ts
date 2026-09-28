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
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import type { ItinerarySlotRow, ItineraryUncoveredAbsenceRow } from './PatientItineraryReader';
import { liveVacancySelect } from './liveVacancySql';
import { uncoveredAbsenceSelect } from './absenceSql';

export interface KanbanServiceRow {
  id: string;
  serviceCode: string;
  weeklyHours: number | null;
  authorizedHours: number | null;
  liveVacancyId: string | null;
}

/** Um agrupamento por paciente — `slots` é o mesmo formato do itinerário da fase 7 (por serviço). */
export interface KanbanServicesRows {
  patientId: string;
  country: string;
  services: KanbanServiceRow[];
  slots: ItinerarySlotRow[];
  /** Opcional: nasce só na Fase 13; ausente quando o paciente não tem nenhuma ausência sem substituto (DX-13.10). */
  uncoveredAbsences?: ItineraryUncoveredAbsenceRow[];
}

interface KanbanJoinRow {
  patient_id: string;
  country: string;
  service_id: string;
  service_code: string;
  weekly_hours: string | null;
  authorized_hours: string | null;
  live_vacancy_id: string | null;
  slot_id: string | null;
  weekday: number | null;
  start_time: string | null;
  end_time: string | null;
  active: boolean | null;
  assignment_id: string | null;
  worker_id: string | null;
  application_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: ItinerarySlotRow['status'];
}

interface UncoveredAbsenceJoinRow {
  patient_id: string;
  contracted_service_id: string;
  on_date: string;
  start_time: string;
  end_time: string;
}

export class PatientKanbanServicesReader {
  /** `country` filtra como a listagem (`null` = todos os países que a RLS deixa ver). */
  async readKanbanServices(country: 'AR' | 'BR' | null): Promise<KanbanServicesRows[]> {
    return inPatientTransaction((client) => this.run(client, country));
  }

  private async run(client: PoolClient, country: 'AR' | 'BR' | null): Promise<KanbanServicesRows[]> {
    const res = await client.query<KanbanJoinRow>(
      `WITH svc AS (
         SELECT pcs.id, pcs.patient_id, pcs.service_code, pcs.weekly_hours, pcs.authorized_hours, pcs.created_at, p.country
           FROM patient_contracted_services pcs
           JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
          WHERE pcs.active AND ($1::text IS NULL OR p.country = $1)
       ), live AS (
         ${liveVacancySelect('jp.contracted_service_id IN (SELECT id FROM svc)')}
       )
       SELECT svc.patient_id, svc.country, svc.id AS service_id, svc.service_code, svc.weekly_hours, svc.authorized_hours,
              live.id AS live_vacancy_id,
              s.id AS slot_id, s.weekday, to_char(s.start_time,'HH24:MI') AS start_time, to_char(s.end_time,'HH24:MI') AS end_time, s.active,
              a.id AS assignment_id, a.worker_id, a.application_id,
              to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to, a.status
         FROM svc
         LEFT JOIN live ON live.contracted_service_id = svc.id
         LEFT JOIN patient_itinerary_slot s ON s.contracted_service_id = svc.id
         LEFT JOIN patient_itinerary_assignment a ON a.slot_id = s.id
        ORDER BY svc.patient_id, svc.created_at, svc.id, s.weekday, s.start_time, a.valid_from`,
      [country],
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
          weeklyHours: r.weekly_hours != null ? Number(r.weekly_hours) : null,
          authorizedHours: r.authorized_hours != null ? Number(r.authorized_hours) : null,
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
          endTime: r.end_time as string,
          active: r.active as boolean,
          assignmentId: r.assignment_id,
          workerId: r.worker_id,
          applicationId: r.application_id,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          status: r.status,
        });
      }
    }

    // 2ª query, DX-13.10: 1 query a mais para TODOS os pacientes do filtro — nunca por card (sem
    // N+1). `ab.on_date >= CURRENT_DATE - 1` é SUPERCONJUNTO (a data de Buenos Aires nunca é menor
    // que a UTC − 1); só poda histórico — quem decide vigência é `uncoveredDayAlerts` com o `asOf`
    // do país (caso de uso). Nenhuma coluna de nome/telefone.
    // Fragmento único em `absenceSql.ts` (só conta ausência sobre alocação ACTIVE e vigente na
    // data — gate parcial #1).
    const absencesRes = await client.query<UncoveredAbsenceJoinRow>(
      uncoveredAbsenceSelect(
        'pcs.active AND ($1::text IS NULL OR p.country = $1) AND ab.on_date >= CURRENT_DATE - 1',
        'JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL',
      ),
      [country],
    );
    for (const r of absencesRes.rows) {
      const patient = byPatient.get(r.patient_id);
      if (!patient) continue; // defensivo: o mesmo filtro de país/ativo da 1ª query
      (patient.uncoveredAbsences ??= []).push({
        serviceId: r.contracted_service_id,
        date: r.on_date,
        startTime: r.start_time,
        endTime: r.end_time,
      });
    }

    return Array.from(byPatient.values());
  }
}
