/**
 * fieldsToCanonical — traduz campos crus de uma fonte para CanonicalPatient
 * usando `source_field_map` (dado, não código) — spec 003, R3.
 *
 *  - campo mapeado AUSENTE no registro (`undefined`) → UNREADABLE (D167)
 *  - campo presente e vazio ('' / null) → null (vazio de verdade)
 *  - DATE_ISO aceita YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY; o resto → UNREADABLE
 *  - EXACT com "true/false/sí/no/yes" → boolean
 */
import type { CanonicalPatient, CanonicalValue } from '../domain/CanonicalPatient';
import { UNREADABLE } from '../domain/CanonicalPatient';
import type { Country } from '../domain/enums';
import type { FieldMapEntry } from './FieldMapRepository';

export const EMPTY_CANONICAL: Omit<CanonicalPatient, 'country'> = {
  firstName: null, lastName: null, birthDate: null, documentType: null, documentNumber: null, sex: null,
  phoneWhatsapp: null, healthInsuranceName: null, healthInsuranceMemberId: null, hasCud: null, hasConsent: null,
  hasJudicialProtection: null, diagnosis: null, dependencyLevel: null, clinicalSpecialty: null, serviceType: null,
  additionalComments: null, province: null, cityLocality: null, zoneNeighborhood: null, addresses: [],
  multidisciplinaryTeam: null, caseNumber: null, status: null, responsibleFirstName: null,
  responsibleLastName: null, responsibleRelationship: null,
};

export interface FieldsToCanonicalResult {
  readonly canonical: CanonicalPatient;
  /** nomes de campo presentes no registro e ausentes do mapa (nunca valores). */
  readonly unmappedFields: readonly string[];
}

export function fieldsToCanonical(
  fields: Readonly<Record<string, unknown>>,
  map: readonly FieldMapEntry[],
  country: Country,
): FieldsToCanonicalResult {
  const byField = new Map(map.filter(m => m.active).map(m => [m.sourceField, m]));
  const draft: Record<string, CanonicalValue> = {};
  for (const entry of byField.values()) {
    const raw = fields[entry.sourceField];
    const v: CanonicalValue = raw === undefined ? UNREADABLE : raw === null || raw === '' ? null : toValue(raw);
    draft[entry.canonicalField] = coerce(entry, v);
  }
  const unmappedFields = Object.keys(fields).filter(k => !byField.has(k)).sort();
  return { canonical: { ...EMPTY_CANONICAL, ...draft, country } as CanonicalPatient, unmappedFields };
}

function toValue(raw: unknown): CanonicalValue {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw) && raw.every(x => typeof x === 'string')) return raw as string[];
  return UNREADABLE;
}

function coerce(entry: FieldMapEntry, v: CanonicalValue): CanonicalValue {
  if (v === null || typeof v !== 'string') return v;
  const s = v.trim();
  switch (entry.equivalence) {
    case 'DATE_ISO': return toIsoDate(s) ?? UNREADABLE;
    case 'EXACT': {
      if (/^(true|false|sí|si|no|yes)$/i.test(s)) return /^(true|sí|si|yes)$/i.test(s);
      return s;
    }
    default: return s;
  }
}

/** Aceita YYYY-MM-DD (com ou sem hora), DD/MM/YYYY e DD-MM-YYYY; devolve ISO ou null. */
export function toIsoDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
