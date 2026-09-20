/**
 * CanonicalPatient — um paciente como uma fonte o vê, já no vocabulário da
 * plataforma (spec 003).
 *
 * É a "foto" gravada em patient_source_snapshots.canonical. Regras:
 *
 *  - lex C2: NUNCA contém telefone, e-mail nem documento de responsável ou de
 *    profissional tratante. Esses campos continuam entrando na base CIFRADOS
 *    pelo caminho normal do espelho (PatientService.upsertFromClickUp); aqui
 *    não existem. `toCanonical()` é a única porta de entrada e os descarta.
 *  - D167: campo que a fonte tem mas não conseguimos ler vira UNREADABLE,
 *    nunca `null` (null = vazio de verdade).
 *  - Tudo serializável em JSON (datas em ISO `YYYY-MM-DD`).
 */

import type { PatientServiceUpsertInput } from '@modules/case';

/** Marcador de "não consegui ler" — distinto de null (vazio). */
export const UNREADABLE = { $unreadable: true } as const;
export type Unreadable = typeof UNREADABLE;

export type CanonicalValue = string | number | boolean | null | Unreadable | readonly string[];

export interface CanonicalAddress {
  readonly kind: 'PRIMARY' | 'SECONDARY' | 'TERTIARY';
  readonly formatted: string | null;
  readonly raw: string | null;
}

export interface CanonicalPatient {
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** ISO date `YYYY-MM-DD` */
  readonly birthDate: string | null;
  readonly documentType: string | null;
  readonly documentNumber: string | null;
  readonly sex: string | null;
  readonly phoneWhatsapp: string | null;
  readonly healthInsuranceName: string | null;
  readonly healthInsuranceMemberId: string | null;
  readonly hasCud: boolean | null;
  readonly hasConsent: boolean | null;
  readonly hasJudicialProtection: boolean | null;
  readonly diagnosis: string | null;
  readonly dependencyLevel: string | null;
  readonly clinicalSpecialty: string | null;
  readonly serviceType: readonly string[] | null;
  readonly additionalComments: string | null;
  readonly province: string | null;
  readonly cityLocality: string | null;
  readonly zoneNeighborhood: string | null;
  readonly addresses: readonly CanonicalAddress[];
  readonly multidisciplinaryTeam: boolean | null;
  readonly caseNumber: number | null;
  readonly status: string | null;
  /** Nome e relação do responsável ficam; contato e documento NÃO (C2). */
  readonly responsibleFirstName: string | null;
  readonly responsibleLastName: string | null;
  readonly responsibleRelationship: string | null;
  readonly country: string;
}

/** Chaves que NUNCA podem aparecer num canonical, em qualquer nível (C2). */
export const FORBIDDEN_CANONICAL_KEYS: readonly string[] = [
  'responsibles',
  'professionals',
  'phone',
  'email',
  'responsiblePhone',
  'responsibleEmail',
  'responsibleDocumentType',
  'responsibleDocumentNumber',
];

/**
 * Converte a saída do ClickUpPatientMapper (PatientServiceUpsertInput) para o
 * canônico. É a ÚNICA porta: quem passar por aqui sai sem contato de terceiro.
 */
export function toCanonical(input: PatientServiceUpsertInput, country: string): CanonicalPatient {
  const primaryResponsible = (input.responsibles ?? []).find(r => r.isPrimary) ?? input.responsibles?.[0];
  const addresses: CanonicalAddress[] = (input.addresses ?? []).map(a => ({
    kind: a.addressType === 'secondary' ? 'SECONDARY' : a.addressType === 'tertiary' ? 'TERTIARY' : 'PRIMARY',
    formatted: pickString(a.addressFormatted),
    raw: pickString(a.addressRaw),
  }));

  return {
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    birthDate: input.birthDate ? toIsoDate(input.birthDate) : null,
    documentType: input.documentType ?? null,
    documentNumber: input.documentNumber ?? null,
    sex: input.sex ?? null,
    phoneWhatsapp: input.phoneWhatsapp ?? null,
    healthInsuranceName: input.healthInsuranceName ?? null,
    healthInsuranceMemberId: input.healthInsuranceMemberId ?? null,
    hasCud: input.hasCud ?? null,
    hasConsent: input.hasConsent ?? null,
    hasJudicialProtection: input.hasJudicialProtection ?? null,
    diagnosis: input.diagnosis ?? null,
    dependencyLevel: input.dependencyLevel ?? null,
    clinicalSpecialty: input.clinicalSpecialty ?? null,
    serviceType: input.serviceType ? [...input.serviceType] : null,
    additionalComments: input.additionalComments ?? null,
    province: input.province ?? null,
    cityLocality: input.cityLocality ?? null,
    zoneNeighborhood: input.zoneNeighborhood ?? null,
    addresses,
    multidisciplinaryTeam: (input.professionals ?? []).some(p => p.isTeam === true) || null,
    caseNumber: input.caseNumber ?? null,
    status: input.status ?? null,
    responsibleFirstName: primaryResponsible?.firstName ?? null,
    responsibleLastName: primaryResponsible?.lastName ?? null,
    responsibleRelationship: primaryResponsible?.relationship ?? null,
    country,
  };
}

/** Verdadeiro se alguma chave proibida (C2) aparecer, em qualquer profundidade. */
export function containsForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKeys);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => FORBIDDEN_CANONICAL_KEYS.includes(k) || containsForbiddenKeys(v),
    );
  }
  return false;
}

export function isUnreadable(v: unknown): v is Unreadable {
  return !!v && typeof v === 'object' && (v as { $unreadable?: unknown }).$unreadable === true;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
