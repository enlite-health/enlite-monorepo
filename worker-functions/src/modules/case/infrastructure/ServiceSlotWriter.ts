/**
 * ServiceSlotWriter — ÚNICO escritor das faixas semanais do serviço contratado (spec 056, plan.md §6;
 * substitui o antigo sync por `schedule`). `patient_itinerary_slot` é o dono do horário: mudar o horário
 * = FECHAR a faixa que sai (`valid = daterange(lower, hoje)`) e ABRIR a nova (`[hoje, )`), na MESMA
 * transação do chamador. Nunca `DELETE` (a alocação aponta para a faixa; REVOKE DELETE da 480) e
 * nunca reativa linha: a faixa fechada fica como histórico.
 *
 * `hoje` = `operationDateOf(país do paciente, now)` — o único relógio dos escritores TS (plan.md §1.2).
 * Falhas (F1-F4): entrada inválida lança antes de qualquer query; alocação ACTIVE vigente numa faixa
 * que sai → `SlotHasActiveAllocationError` antes de qualquer escrita (D442); trigger 23514
 * `pis_vigencia_*` é bug e propaga; 23P01 `pis_sem_sobreposicao` no INSERT → `ServiceSlotOverlapError`.
 */
import type { PoolClient } from 'pg';
import {
  shiftsToSlotKeys,
  type ItinerarySlotKey,
  type ShiftEntry,
} from '../domain/ItinerarySchedule';
import { operationDateOf } from '../application/itineraryCoverage';
import { SlotHasActiveAllocationError } from '../application/ItinerarySlotWriteUseCase';
import { closeRangeAt, fromWire } from '../domain/dateRangeWire';

/** A faixa nova sobrepõe outra do mesmo serviço na mesma vigência (constraint `pis_sem_sobreposicao`). → 409 SLOT_OVERLAP */
export class ServiceSlotOverlapError extends Error {
  constructor(readonly serviceId: string) {
    super(`Itinerary slot overlaps another slot of the service: ${serviceId}`);
    this.name = 'ServiceSlotOverlapError';
  }
}

export interface VigentSlot {
  id: string;
  weekday: number;
  startTime: string;
  durationMinutes: number;
}

const keyOf = (k: { weekday: number; startTime: string; durationMinutes: number }): string =>
  `${k.weekday}|${k.startTime}|${k.durationMinutes}`;

/** Faixas do serviço vigentes em `hoje` (`YYYY-MM-DD`, dia local do país). */
export async function readVigentSlots(cli: PoolClient, serviceId: string, hoje: string): Promise<VigentSlot[]> {
  const res = await cli.query<{ id: string; weekday: number; start_time: string; duration_minutes: number }>(
    `SELECT s.id, s.weekday, to_char(s.start_time, 'HH24:MI') AS start_time, s.duration_minutes
       FROM patient_itinerary_slot s
      WHERE s.contracted_service_id = $1 AND s.valid @> $2::date
      ORDER BY s.weekday, s.start_time, s.duration_minutes`,
    [serviceId, hoje],
  );
  return res.rows.map((r) => ({
    id: r.id,
    weekday: r.weekday,
    startTime: r.start_time,
    durationMinutes: r.duration_minutes,
  }));
}

/** Abre a faixa em `[hoje, )`. 23P01 de `pis_sem_sobreposicao` → `ServiceSlotOverlapError`. */
export async function openSlot(
  cli: PoolClient,
  serviceId: string,
  key: ItinerarySlotKey,
  hoje: string,
  actorUid: string,
): Promise<string> {
  try {
    const res = await cli.query<{ id: string }>(
      `INSERT INTO patient_itinerary_slot
              (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id`,
      [serviceId, key.weekday, key.startTime, key.durationMinutes, fromWire({ validFrom: hoje, validTo: null }), actorUid],
    );
    return res.rows[0]?.id ?? '';
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23P01' && e.constraint === 'pis_sem_sobreposicao') throw new ServiceSlotOverlapError(serviceId);
    throw err;
  }
}

/** Fecha a faixa: vigente até ontem (`[lower, hoje)`); aberta e nascida hoje vira vazia (nunca vigente). */
export async function closeSlot(cli: PoolClient, slotId: string, hoje: string, actorUid: string): Promise<void> {
  const cur = await cli.query<{ valid: string }>(`SELECT valid::text AS valid FROM patient_itinerary_slot WHERE id = $1 FOR UPDATE`, [slotId]);
  if (cur.rows.length === 0) throw new Error(`itinerary slot not found: ${slotId}`);
  await cli.query(
    `UPDATE patient_itinerary_slot SET valid = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
    [slotId, closeRangeAt(cur.rows[0].valid, hoje), actorUid],
  );
}

/**
 * Troca o horário do serviço pelo conjunto `entries` (`null`/`[]` = sem horário). Faixas iguais não
 * são tocadas; as que saem fecham; as que entram abrem — fechar ANTES de abrir.
 */
export async function replaceServiceSlots(
  cli: PoolClient,
  serviceId: string,
  entries: readonly ShiftEntry[] | null,
  actorUid: string,
  now: Date = new Date(),
): Promise<{ opened: number; closed: number }> {
  // F1: entrada inválida lança ANTES de qualquer query — nada grava.
  const desired = shiftsToSlotKeys(entries);

  const country = await cli.query<{ country: string }>(
    `SELECT p.country FROM patient_contracted_services pcs JOIN patients p ON p.id = pcs.patient_id WHERE pcs.id = $1`,
    [serviceId],
  );
  if (country.rows.length === 0) throw new Error(`contracted service not found: ${serviceId}`);
  const hoje = operationDateOf(country.rows[0].country, now);

  const vigentes = await readVigentSlots(cli, serviceId, hoje);
  const desiredKeys = new Set(desired.map(keyOf));
  const vigentKeys = new Set(vigentes.map(keyOf));
  const saem = vigentes.filter((s) => !desiredKeys.has(keyOf(s)));
  const entram = desired.filter((k) => !vigentKeys.has(keyOf(k)));

  // F2 (D442): alocação ACTIVE vigente em `hoje` numa faixa que sai → recusa ANTES de qualquer escrita.
  if (saem.length > 0) {
    const blocked = await cli.query<{ id: string }>(
      `SELECT s.id FROM patient_itinerary_slot s
        WHERE s.contracted_service_id = $1 AND s.id = ANY($3::uuid[])
          AND EXISTS (
            SELECT 1 FROM patient_itinerary_assignment a
             WHERE a.slot_id = s.id AND a.status = 'ACTIVE' AND (a.valid_to IS NULL OR a.valid_to >= $2::date)
          )
        ORDER BY s.weekday, s.start_time
        LIMIT 1`,
      [serviceId, hoje, saem.map((s) => s.id)],
    );
    if (blocked.rows.length > 0) throw new SlotHasActiveAllocationError(serviceId, blocked.rows[0].id);
  }

  // F3: trigger 23514 `pis_vigencia_*` = bug, propaga.
  for (const s of saem) await closeSlot(cli, s.id, hoje, actorUid);
  // F4: 23P01 `pis_sem_sobreposicao` → ServiceSlotOverlapError.
  for (const k of entram) await openSlot(cli, serviceId, k, hoje, actorUid);

  return { opened: entram.length, closed: saem.length };
}
