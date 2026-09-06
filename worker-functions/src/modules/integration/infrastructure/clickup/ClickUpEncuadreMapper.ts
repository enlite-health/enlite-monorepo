import * as crypto from 'crypto';
import { z } from 'zod';
import { ClickUpFieldResolver } from './ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from './ClickUpTask';
import { mapClickUpGender } from './mappings/genderMap';
import { mapClickUpProfession } from './mappings/professionMap';
import { ENCUADRES_STATUS_TO_RESULTADO } from './mappings/encuadreStatusMap';
import { asIndexable } from './helpers/asIndexable';
import type { EncuadreResultado } from '@modules/matching/domain/Encuadre';
import type { Profession } from '@modules/worker/domain/enums/Profession';
import type { Gender } from '@modules/worker/domain/enums/Gender';

// ── Zod schemas for input validation at the boundary ─────────────────────────

const CustomFieldSchema = z.object({
  id:    z.string(),
  name:  z.string(),
  type:  z.string(),
  value: z.unknown().optional(),
});

const TaskStatusSchema = z.object({
  status: z.string(),
  color:  z.string().optional(),
  type:   z.string().optional(),
});

export const ClickUpTaskSchema = z.object({
  id:            z.string(),
  name:          z.string(),
  status:        TaskStatusSchema,
  parent:        z.string().nullable(),
  custom_fields: z.array(CustomFieldSchema),
  url:           z.string().optional(),
  date_created:  z.string().optional(),
  date_updated:  z.string().optional(),
});

// ── Output types ──────────────────────────────────────────────────────────────

export interface EncuadreWorkerData {
  email:        string | null;
  phone:        string | null;   // normalized E.164 (or best-effort)
  rawWhatsapp:  string | null;   // original raw value from ClickUp
  firstName:    string | null;
  lastName:     string | null;
  birthDate:    Date | null;
  gender:       Gender | null;
  profession:   Profession | null;
}

export interface EncuadreData {
  clickupTaskId: string;
  caseNumber:    number;          // always a real number — no case → encuadre is null
  rawName:       string | null;
  rawPhone:      string | null;
  resultado:     EncuadreResultado;
  importSourceAudit: string;      // always 'ClickUp'
  dedupHash:     string;          // MD5('clickup|{taskId}|{caseNumber}')
}

/**
 * One entry per case number extracted from the task name.
 * - encuadre is null when no case number could be extracted.
 */
export interface EncuadreMapperEntry {
  worker:   EncuadreWorkerData;
  encuadre: EncuadreData | null;
}

type CustomFieldMap = Record<string, unknown>;

// ── Status → resultado mapping ────────────────────────────────────────────────

function mapStatusToResultado(status: string): EncuadreResultado {
  const lower = status.toLowerCase().trim();
  const mapped = ENCUADRES_STATUS_TO_RESULTADO[lower];
  if (mapped === undefined) {
    // Unknown ClickUp status — ops may have added a new value. Log it so it can be mapped.
    // Falling back to 'PENDIENTE' produces a PLAUSIBLE value, indistinguishable from a real
    // classification — so the warning is the only signal that the mapping is missing.
    console.warn('[ClickUpEncuadreMapper] Unknown ClickUp status:', { field: 'Encuadres task status', label: status, fallback: 'PENDIENTE' });
    return 'PENDIENTE';
  }
  return mapped;
}

// ── Case-number extraction ────────────────────────────────────────────────────

/**
 * parseCaseNumbersFromName — extracts case numbers from the beginning of a
 * ClickUp task name (Encuadres list).
 *
 * Validated patterns (empirical, 2018 tasks):
 *   "690 - Nome"                 → [690]
 *   "Caso 690 - Nome"            → [690]
 *   "Cod 690 - Nome"             → [690]
 *   "Cod. 690 - Nome"            → [690]
 *   "Código 603 - Nome"          → [603]
 *   "CD690 - Nome"               → [690]
 *   "🔹 COD 434 - Nome"          → [434]
 *   "613-440 - Ariel"            → [613, 440]
 *   "Cod: 440-663-613 - Maria"   → [440, 663, 613]
 *   "690-690 - João"             → [690]   (dedup)
 *   "Cuidadora - Pamela"         → []      (no case)
 *   "Form Submission - #2026-..."→ []      (timestamp not a case)
 *   "90 - Ferreyra - C/… 11-1"  → [90]    (address numbers not captured)
 *
 * A second sequence of numbers only counts as part of the case block if it
 * comes IMMEDIATELY after the first number(s) in the N-N pattern BEFORE the
 * first separator followed by a letter (name starts).
 */
export function parseCaseNumbersFromName(name: string): number[] {
  if (!name) return [];

  // Strip leading non-word characters (emojis, spaces, dots, etc.)
  // then optionally a prefix keyword (caso/cod/código/cd) and separator
  const PREFIX_RE =
    /^[\s\W]*(?:caso|c[oó]digo|cod|cd)?\s*[:.\-]?\s*/i;

  const stripped = name.replace(PREFIX_RE, '');

  // The remaining string must start with one or more digit-groups separated by
  // hyphens/en-dashes, followed by a space+dash separator and then a letter
  // (beginning of the name).  The second numbers after the separator belong to
  // the address — we do NOT capture those.
  //
  // Pattern: (N ([-–]N)*)  [-–]+  [A-Za-zÀ-ÿ]
  const BLOCK_RE =
    /^(\d{1,5}(?:\s*[-–]\s*\d{1,5})*)\s*[-–]+\s*[A-Za-zÀ-ÿ]/;

  const m = BLOCK_RE.exec(stripped);
  if (!m) return [];

  // m[1] is e.g. "613", "613-440", "440-663-613", "690-690"
  const block = m[1];

  // Split block by hyphens/en-dashes and parse each segment as integer
  const parts = block
    .split(/[-–]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n) && n > 0);

  // Dedup (preserving first-seen order)
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const n of parts) {
    if (!seen.has(n)) {
      seen.add(n);
      unique.push(n);
    }
  }

  return unique;
}

// ── Mapper class ──────────────────────────────────────────────────────────────

/**
 * ClickUpEncuadreMapper — converts a ClickUp task from the "Encuadres" list
 * into an array of { worker, encuadre } entries ready for DB upsert.
 *
 * Returns null if the task has neither email nor whatsapp (non-identifiable).
 * Returns an array with encuadre=null when no case number is extractable.
 * Returns N entries (one per case number) when the name contains multiple cases.
 */
export class ClickUpEncuadreMapper {
  constructor(private readonly resolver: ClickUpFieldResolver) {}

  map(task: ClickUpTask): EncuadreMapperEntry[] | null {
    // Validate task shape at the boundary
    const parsed = ClickUpTaskSchema.safeParse(task);
    if (!parsed.success) return null;

    const cf = this.buildCfMap(parsed.data.custom_fields);

    const email       = this.asString(cf['Email Prestador']);
    const rawWhatsapp = this.asString(cf['Whatsapp Prestador']);

    // Skip non-identifiable workers (no email AND no whatsapp)
    if (!email && !rawWhatsapp) return null;

    // Resolve dropdown fields
    const sexLabel        = this.resolver.resolveDropdown('Sexo Prestador',     asIndexable('Sexo Prestador', cf['Sexo Prestador']));
    const professionLabel = this.resolver.resolveDropdown('Tipo de Profesional', asIndexable('Tipo de Profesional', cf['Tipo de Profesional']));

    // Parse name from "Apellido y Nombre Prestador" field
    const rawName = this.asString(cf['Apellido y Nombre Prestador']);
    const { firstName, lastName } = this.parseName(rawName);

    const worker: EncuadreWorkerData = {
      email,
      phone:      rawWhatsapp,  // raw; normalization happens in the script
      rawWhatsapp,
      firstName,
      lastName,
      birthDate:  this.parseDate(this.asString(cf['Fecha Nacimiento Prestador'])),
      gender:     mapClickUpGender(sexLabel),
      profession: mapClickUpProfession(professionLabel),
    };

    const resultado    = mapStatusToResultado(task.status.status);
    const caseNumbers  = parseCaseNumbersFromName(parsed.data.name);

    // No case extractable → 1 entry with encuadre=null (worker still imported)
    if (caseNumbers.length === 0) {
      return [{ worker, encuadre: null }];
    }

    // 1+ cases → 1 entry per case, same worker
    return caseNumbers.map(caseNumber => {
      const dedupHash = crypto
        .createHash('md5')
        .update(`clickup|${task.id}|${caseNumber}`)
        .digest('hex');

      const encuadre: EncuadreData = {
        clickupTaskId: task.id,
        caseNumber,
        rawName,
        rawPhone:  rawWhatsapp,
        resultado,
        importSourceAudit: 'ClickUp',
        dedupHash,
      };

      return { worker, encuadre };
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private buildCfMap(fields: readonly ClickUpTaskCustomField[]): CustomFieldMap {
    const map: CustomFieldMap = {};
    for (const field of fields) {
      map[field.name] = field.value;
    }
    return map;
  }

  /**
   * Parses "Apellido y Nombre" string (common formats):
   *   "García, Juan"         → { lastName: "García", firstName: "Juan" }
   *   "GARCÍA JUAN"          → { lastName: "GARCÍA", firstName: "JUAN" } (best effort)
   *   "Juan García"          → { lastName: null,     firstName: "Juan García" } (fallback)
   */
  private parseName(raw: string | null): { firstName: string | null; lastName: string | null } {
    if (!raw) return { firstName: null, lastName: null };
    const trimmed = raw.trim();
    if (!trimmed) return { firstName: null, lastName: null };

    const commaParts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
    if (commaParts.length >= 2) {
      return { lastName: commaParts[0], firstName: commaParts.slice(1).join(' ') };
    }

    // No comma — treat full value as firstName, lastName null
    return { firstName: trimmed, lastName: null };
  }

  private parseDate(value: string | null): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  private asString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() || null;
    return null;
  }

  // asIndexable() moved to helpers/asIndexable.ts (C5 do parecer do `lex`, 23/08).
  // This file carried a SECOND copy of the same `Number(value)` pre-coercion — same
  // fabrication door, on 'Sexo Prestador' and 'Tipo de Profesional'. Fixing one copy
  // and leaving the other would leave the class open. See the helper's header.
}
