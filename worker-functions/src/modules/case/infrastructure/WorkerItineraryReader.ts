/**
 * WorkerItineraryReader — spec 077 F1 (T272) + FR-42: as ocorrências de turno de UM worker na janela `[dia 1 do mês anterior, hoje+14]`.
 *
 * Universo: `readOccurrenceInputsByPatient` com `scopeSql` por worker (faixas ativas com alocação ACTIVE vigente do worker na
 * janela OU ausência viva com `substitute_worker_id = worker`). As alocações/ausências lidas são TODAS as das faixas do universo
 * (a expansão precisa do titular para saber quem foi substituído). A expansão é `expandServiceOccurrences` (nada reimplementado);
 * o recorte final mantém só a ocorrência cujo executor efetivo (`workerId`) é o worker.
 *
 * Privacidade (P3, revista pela FR-39): rua, número, cidade e texto formatado do endereço não são lidos nem devolvidos. Do
 * endereço padrão ativo saem lat/lng, a qualidade do geocode e o bairro (`neighborhood`, com fallback no cadastro do paciente:
 * mesma regra do feed público, DT-21); o ponto sai DEGRADADO à grade de ~20 m (`degradePoint20m`). O ponto real nunca deixa
 * este arquivo. O paciente sai como `patient_ref` opaco (`patientRefOf`), nunca o id.
 *
 * Tombstones (C-33, DT-22): só ocorrência de HOJE (`today`) que deixou de existir, com o MESMO `occurrence_id` do item
 * (`occurrenceIdOf`). `ABSENCE` = ausência viva da titular hoje (sai da própria expansão); `ALLOCATION_ENDED` = alocação do
 * worker encerrada hoje numa faixa que ainda vale hoje, ou trocada/retirada com efeito hoje, com ou sem substituta (D669/D670);
 * `SLOT_ENDED` = alocação encerrada hoje numa faixa que deixou de valer
 * hoje (a faixa só fecha sem alocação vigente, D442). Id que segue em `items` nunca vira tombstone.
 */
import type { PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import { addDaysToDateString, weekdayOfDateString } from '../domain/itineraryEvents';
import { isReliableGeocode, type GeocodeLocationType } from '../domain/geocodeQuality';
import { expandServiceOccurrences } from '../domain/serviceOccurrences';
import { patientRefOf } from '../domain/patientRef';
import { readOccurrenceInputsByPatient } from './occurrenceInputs';

/** Namespace fixo do contrato (`x-occurrence-id-namespace`, SUP-F1-11). */
export const OCCURRENCE_ID_NAMESPACE = '43876dea-477d-4c5b-8b30-127aa6db3f92';
/** Passo da grade de degradação (~20 m): `x-degradacao-20m` do contrato. */
export const GRID_DEG = 0.00018;
export const WINDOW_DAYS_AFTER = 14;

/** Início da janela (FR-42, D635): dia 1 do mês ANTERIOR ao `today` (data civil `YYYY-MM-DD`, já no fuso da operação). Pura. */
export function windowStart(today: string): string {
  const [y, m] = today.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

export interface PatientPoint {
  lat: number;
  lng: number;
  quality: 'RELIABLE' | 'UNRELIABLE';
}

export interface ItineraryItem {
  occurrence_id: string;
  slot_id: string;
  assignment_id: string;
  on_date: string;
  starts_at: string;
  ends_at: string;
  kind: 'REGULAR' | 'SUBSTITUTION';
  patient_first_name: string;
  /** uuid v5 opaco do paciente (FR-39, DT-21); nunca o id. */
  patient_ref: string;
  /** Bairro do endereço padrão ativo, com fallback em patients.zone_neighborhood (DT-21); null quando os dois faltam. */
  neighborhood: string | null;
  /** Endereço em texto: sempre null até a F4 (C-14/FR-44). */
  address: null;
  patient_point: PatientPoint | null;
  country: string;
  seq: number;
}

/** Motivos do tombstone (C-33, DT-22): conjunto fechado, o mesmo enum do attendance, do BFF e do app (`CancelReason`). */
export const TOMBSTONE_REASONS = ['ALLOCATION_ENDED', 'ABSENCE', 'SLOT_ENDED'] as const;
export type TombstoneReason = (typeof TOMBSTONE_REASONS)[number];

/** Ocorrência de HOJE que deixou de existir; o app a mostra como cancelada até o fim do dia (A-19). */
export interface ItineraryTombstone {
  occurrence_id: string;
  reason: TombstoneReason;
  seq: number;
}

export interface ItineraryEnvelope {
  worker_id: string;
  items: ItineraryItem[];
  tombstones: ItineraryTombstone[];
  cursor: string;
  full: true;
}

/** `occurrence_id` = uuid v5 de "slot|data|worker" (SUP-F1-11): o MESMO id no item e no tombstone. Pura. */
export function occurrenceIdOf(slotId: string, date: string, workerId: string): string {
  return uuidv5(`${slotId}|${date}|${workerId}`, OCCURRENCE_ID_NAMESPACE);
}

/** snap(v) = round(v / GRID_DEG) * GRID_DEG, a 5 casas (contrato). Pura. */
export function degradePoint20m(lat: number, lng: number): { lat: number; lng: number } {
  const snap = (v: number): number => Number((Math.round(v / GRID_DEG) * GRID_DEG).toFixed(5));
  return { lat: snap(lat), lng: snap(lng) };
}

/** Offset fixo por país (sem horário de verão hoje). País desconhecido cai em AR, único país em operação. */
const UTC_OFFSET_HOURS: Record<string, number> = { AR: -3, BR: -3, UY: -3 };

function toIso(date: string, hhmm: string, country: string, dayShift: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const offset = UTC_OFFSET_HOURS[country] ?? -3;
  return new Date(Date.UTC(y, m - 1, d + dayShift, hh - offset, mm, 0)).toISOString().replace('.000Z', 'Z');
}

interface PatientRow {
  id: string;
  first_name: string | null;
  country: string;
  lat: string | number | null;
  lng: string | number | null;
  geocode_quality: GeocodeLocationType | null;
  geocode_partial_match: boolean | null;
  neighborhood: string | null;
}

/** $1 = worker, $2 = from, $3 = to. */
const WORKER_SCOPE_SQL = `pcs.active
  AND (
    EXISTS (SELECT 1 FROM patient_itinerary_assignment wa
             WHERE wa.slot_id = s.id AND wa.worker_id = $1::uuid AND wa.status = 'ACTIVE'
               AND wa.valid_from <= $3::date AND (wa.valid_to IS NULL OR wa.valid_to >= $2::date))
    OR EXISTS (SELECT 1 FROM patient_itinerary_absence wab
                 JOIN patient_itinerary_assignment waa ON waa.id = wab.assignment_id
                WHERE waa.slot_id = s.id AND wab.substitute_worker_id = $1::uuid AND wab.cancelled_at IS NULL
                  AND wab.on_date BETWEEN $2::date AND $3::date)
  )`;

export async function readWorkerWindow(client: PoolClient, args: { workerId: string; today: string }): Promise<ItineraryEnvelope> {
  const { workerId, today } = args;
  const from = windowStart(today);
  const to = addDaysToDateString(today, WINDOW_DAYS_AFTER);

  const byPatient = await readOccurrenceInputsByPatient(client, {
    scopeSql: WORKER_SCOPE_SQL,
    extraJoin: 'JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL',
    fromSql: '$2::date',
    toSql: '$3::date',
    params: [workerId, from, to],
  });

  const patients = await readPatients(client, [...byPatient.keys()]);

  const rows: Array<Omit<ItineraryItem, 'seq'>> = [];
  const gone = new Map<string, TombstoneReason>();
  for (const [patientId, inputs] of byPatient) {
    const patient = patients.get(patientId);
    if (!patient) continue;
    const occurrences = expandServiceOccurrences(inputs.slots, inputs.assignments, inputs.absences, from, to, { workerId });
    for (const o of occurrences) {
      if (o.date === today && o.titularWorkerId === workerId && o.workerId !== workerId && o.absenceId !== null) {
        gone.set(occurrenceIdOf(o.slotId, today, workerId), 'ABSENCE');
      }
      if (o.workerId !== workerId || o.assignmentId === null) continue;
      const overnight = o.endTime <= o.startTime ? 1 : 0;
      rows.push({
        occurrence_id: occurrenceIdOf(o.slotId, o.date, workerId),
        slot_id: o.slotId,
        assignment_id: o.assignmentId,
        on_date: o.date,
        starts_at: toIso(o.date, o.startTime, patient.country, 0),
        ends_at: toIso(o.date, o.endTime, patient.country, overnight),
        kind: o.titularWorkerId !== workerId && o.substituteWorkerId === workerId ? 'SUBSTITUTION' : 'REGULAR',
        patient_first_name: patient.first_name?.trim() || 'Paciente',
        patient_ref: patientRefOf(patientId),
        neighborhood: patient.neighborhood ?? null,
        address: null,
        patient_point: pointOf(patient),
        country: patient.country,
      });
    }
  }
  rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.slot_id.localeCompare(b.slot_id) || a.occurrence_id.localeCompare(b.occurrence_id));
  const items: ItineraryItem[] = rows.map((r, i) => ({ ...r, seq: i + 1 }));

  for (const r of await readEndedToday(client, workerId, today)) {
    const id = occurrenceIdOf(r.slot_id, today, workerId);
    if (!gone.has(id)) gone.set(id, r.slot_valid_today ? 'ALLOCATION_ENDED' : 'SLOT_ENDED');
  }
  const itemIds = new Set(items.map((i) => i.occurrence_id));
  const tombstones: ItineraryTombstone[] = [...gone]
    .filter(([id]) => !itemIds.has(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([occurrence_id, reason], i) => ({ occurrence_id, reason, seq: items.length + i + 1 }));

  return {
    worker_id: workerId,
    items,
    tombstones,
    cursor: Buffer.from(new Date().toISOString()).toString('base64url'),
    full: true,
  };
}

interface EndedTodayRow {
  slot_id: string;
  slot_valid_today: boolean;
}

/**
 * Alocações do worker que deixaram de valer HOJE numa faixa do dia da semana de hoje (C-33, DT-22, D669). Não há coluna de data do
 * encerramento; os estados que tiram a ocorrência de hoje da expansão (que só lê `ACTIVE` vigente) são:
 *   - `ENDED` com `valid_to = hoje` (`ItineraryAllocationWriter.endAllocation`: `GREATEST(valid_from, hoje)`);
 *   - troca (`ItineraryAllocationUseCase.replaceWith`) ou saída sem substituta (`CreateSubstitutionRequestUseCase`, mesmo writer)
 *     com efeito hoje: `ACTIVE` com `valid_to = ontem` (`scheduleAllocationEnd`) ou `CANCELLED` com `valid_from = hoje`
 *     (`cancelAllocation`: a titular só começava hoje), com ou sem sucessora (D670). Fim agendado dias antes para ontem também
 *     casa, mas a ocorrência de hoje já saiu do app na página `full` daquele dia: tombstone de id que o app não tem é no-op.
 * `slot_valid_today` separa ALLOCATION_ENDED (a faixa segue) de SLOT_ENDED (a faixa fechou: `[lower, hoje)` ou `empty`). `today` vem
 * do caso de uso; nada de `CURRENT_DATE` aqui.
 */
async function readEndedToday(client: PoolClient, workerId: string, today: string): Promise<EndedTodayRow[]> {
  const res = await client.query<EndedTodayRow>(
    `SELECT a.slot_id, (s.valid @> $2::date) AS slot_valid_today
       FROM patient_itinerary_assignment a
       JOIN patient_itinerary_slot s ON s.id = a.slot_id
       JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
       JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
      WHERE a.worker_id = $1::uuid AND s.weekday = $3
        AND ((a.status = 'ENDED' AND a.valid_to = $2::date)
          OR (a.status = 'ACTIVE' AND a.valid_to = $2::date - 1)
          OR (a.status = 'CANCELLED' AND a.valid_from = $2::date))
      ORDER BY a.slot_id`,
    [workerId, today, weekdayOfDateString(today)],
  );
  return res.rows;
}

function pointOf(p: PatientRow): PatientPoint | null {
  if (p.lat === null || p.lng === null) return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { ...degradePoint20m(lat, lng), quality: isReliableGeocode(p.geocode_quality, p.geocode_partial_match) ? 'RELIABLE' : 'UNRELIABLE' };
}

/** Primeiro nome, país, coordenadas/qualidade e bairro do endereço padrão ativo (bairro com fallback no cadastro, DT-21). */
async function readPatients(client: PoolClient, patientIds: readonly string[]): Promise<Map<string, PatientRow>> {
  const out = new Map<string, PatientRow>();
  if (patientIds.length === 0) return out;
  const res = await client.query<PatientRow>(
    `SELECT p.id, p.first_name, p.country, pa.lat, pa.lng, pa.geocode_quality, pa.geocode_partial_match,
            COALESCE(pa.neighborhood, p.zone_neighborhood) AS neighborhood
       FROM patients p
       LEFT JOIN LATERAL (
         SELECT a.lat, a.lng, a.geocode_quality, a.geocode_partial_match, a.neighborhood
           FROM patient_addresses a
          WHERE a.patient_id = p.id AND a.is_default AND a.archived_at IS NULL
          ORDER BY a.display_order, a.id
          LIMIT 1
       ) pa ON true
      WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
    [patientIds],
  );
  for (const r of res.rows) out.set(r.id, r);
  return out;
}
