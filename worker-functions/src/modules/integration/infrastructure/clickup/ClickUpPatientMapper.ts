import type { PatientServiceUpsertInput } from '@modules/case';
import type { PatientResponsibleInput } from '@modules/case';
import type { PatientAddress, PatientProfessional } from '../../../../infrastructure/repositories/PatientRepository';
import { ClickUpFieldResolver } from './ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from './ClickUpTask';
import {
  mapClickUpDependencyLevel,
  mapClickUpSex,
  mapClickUpDocumentType,
  mapClickUpRelationship,
  mapClickUpClinicalSpecialty,
  mapClickUpService,
} from './mappings';
import { mapClickUpVacancyStatus } from './mappings/vacancyStatusMap';
import {
  extractStateFromLocation,
  extractCityFromLocation,
  extractNeighborhood,
} from './helpers/locationHelpers';

type CustomFieldMap = Record<string, unknown>;

/**
 * ClickUpPatientMapper — converts a ClickUp task from "Estado de Pacientes" list
 * into a PatientServiceUpsertInput ready for PatientService.upsertFromClickUp().
 *
 * Mapping strategy:
 *   - Drop-down fields → resolved via ClickUpFieldResolver (orderindex → label)
 *   - Labels fields    → resolved via ClickUpFieldResolver (uuid → label)
 *   - Text/number/date → value used directly from custom_fields[].value
 *   - Unknown drop-down labels → null (never persist raw external values)
 */
export class ClickUpPatientMapper {
  constructor(private readonly resolver: ClickUpFieldResolver) {}

  /**
   * Converts a ClickUp task to PatientServiceUpsertInput.
   * Returns null if the task has no usable patient data (no first or last name).
   */
  map(task: ClickUpTask): PatientServiceUpsertInput | null {
    const cf = this.buildCustomFieldMap(task.custom_fields);

    // Identity: prefer custom fields; fall back to parsing task.name when empty.
    // Many ClickUp tasks carry the patient name only in the title (e.g. "Castillo, Priscila"
    // or "BUZZALINO, ANA - Caso 644" or "Falieres, Candela (Cod 433)").
    let firstName = this.asString(cf['Nombre de Paciente']);
    let lastName  = this.asString(cf['Apellido del Paciente']);

    if (!firstName && !lastName) {
      const parsed = this.parseNameFromTitle(task.name);
      if (parsed) {
        firstName = parsed.firstName;
        lastName  = parsed.lastName;
      }
    }

    if (!firstName && !lastName) return null;

    const dependencyLabel    = this.resolver.resolveDropdown('Dependencia', this.asIndexable(cf['Dependencia']));
    const sexLabel           = this.resolver.resolveDropdown('Sexo Asignado al Nacer (Uso Clínico)', this.asIndexable(cf['Sexo Asignado al Nacer (Uso Clínico)']));
    const docTypeLabel       = this.resolver.resolveDropdown('Tipo de Documento Paciente', this.asIndexable(cf['Tipo de Documento Paciente']));
    const specialtyLabel     = this.resolver.resolveDropdown('Segmentos Clínicos', this.asIndexable(cf['Segmentos Clínicos']));
    const serviceLabel       = this.resolver.resolveDropdown('Servicio', this.asIndexable(cf['Servicio']));

    const serviceTypes = mapClickUpService(serviceLabel);

    // Derive patient status from ClickUp task status.
    // task.status.status is the raw ClickUp label (lowercase, e.g. "busqueda", "admisión").
    // mapClickUpVacancyStatus handles whitespace trimming and lowercasing internally.
    const statusRaw      = task.status?.status;
    const statusMapping  = mapClickUpVacancyStatus(statusRaw);
    const patientStatus  = statusMapping?.patientStatus ?? null;
    if (statusRaw && !statusMapping) {
      // Unknown ClickUp status — ops may have added a new value. Log it so it can be mapped.
      console.warn('[ClickUpPatientMapper] Unknown ClickUp status:', { statusRaw, taskId: task.id });
    }

    const input: PatientServiceUpsertInput = {
      clickupTaskId:      task.id,
      firstName:          firstName ?? '',
      lastName:           lastName  ?? '',
      birthDate:          this.parseDate(this.asString(cf['Fecha de Nacimiento'])),
      documentType:       mapClickUpDocumentType(docTypeLabel),
      documentNumber:     this.asString(cf['Número de Documento Paciente']),
      sex:                mapClickUpSex(sexLabel),
      phoneWhatsapp:      this.cleanPhone(this.asString(cf['Número de WhatsApp Paciente'])),
      hasCud:             cf['Posee CUD'] === true,
      hasConsent:         cf['Consentimiento'] === true,
      hasJudicialProtection: cf['Amparo Judicial'] === true,
      country:            'AR',

      // Clinical
      diagnosis:          this.asString(cf['Diagnóstico (si lo conoce)']),
      dependencyLevel:    mapClickUpDependencyLevel(dependencyLabel),
      clinicalSpecialty:  mapClickUpClinicalSpecialty(specialtyLabel),
      serviceType:        serviceTypes.length > 0 ? serviceTypes : null,
      additionalComments: this.asString(cf['Comentarios Adicionales Paciente']),

      // Health insurance (fill-only via COALESCE in PatientIdentityRepository)
      // ClickUp: "Cobertura Informada"
      healthInsuranceName:     this.asString(cf['Cobertura Informada']),
      // ClickUp: "Número ID Afiliado Paciente"
      healthInsuranceMemberId: this.asString(cf['Número ID Afiliado Paciente']),
      // ClickUp: "Caso Número" — PII-safe operational identifier. Migration 164.
      caseNumber:              extractCaseNumber(task),
      // Lifecycle status derived from ClickUp task status (migration 143).
      // null when ClickUp status is unrecognised — loggable above.
      status:                  patientStatus,

      // Related records
      responsibles:  this.buildResponsibles(cf),
      addresses:     this.buildAddresses(cf),
      professionals: this.buildProfessionals(cf, cf['Equipo Tratante Multidisciplinario']),
    };

    return input;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private buildCustomFieldMap(fields: ClickUpTaskCustomField[]): CustomFieldMap {
    const map: CustomFieldMap = {};
    for (const field of fields) {
      map[field.name] = field.value;
    }
    return map;
  }

  /**
   * Parses patient name from a ClickUp task title. Supports formats:
   *   - "Sobrenome, Nome"                         → "Sobrenome", "Nome"
   *   - "SOBRENOME, NOME - Caso 644"              → "SOBRENOME", "NOME"
   *   - "Falieres, Candela Agostina (Cod 433)"    → "Falieres", "Candela Agostina"
   *   - "Castillo, Priscila"                      → "Castillo", "Priscila"
   * Returns null if title has no recognizable "Sobrenome, Nome" pattern.
   */
  private parseNameFromTitle(title: string): { firstName: string; lastName: string } | null {
    if (!title) return null;
    const cleaned = title
      .replace(/\s*-\s*Caso\s+\d+.*$/i, '')
      .replace(/\s*\(C[oó]d(?:igo)?\.?\s*\d+\)\s*$/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();

    const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const lastName  = parts[0];
    const firstName = parts.slice(1).join(' ');
    if (!lastName || !firstName) return null;
    return { firstName, lastName };
  }

  private buildResponsibles(cf: CustomFieldMap): PatientResponsibleInput[] {
    const firstName = this.asString(cf['Nombre de Responsable']);
    const lastName  = this.asString(cf['Apellido de Responsable']);
    if (!firstName && !lastName) return [];

    const relLabel = this.resolver.resolveDropdown(
      'Relación con el Paciente',
      this.asIndexable(cf['Relación con el Paciente']),
    );

    return [{
      firstName:    firstName ?? '',
      lastName:     lastName  ?? '',
      relationship: mapClickUpRelationship(relLabel),
      phone:        this.cleanPhone(this.asString(cf['Número de WhatsApp Responsable'])),
      email:        this.asString(cf['Email del Responsable']),
      documentType: mapClickUpDocumentType(
        this.resolver.resolveDropdown(
          'Tipo de Documento Responsable',
          this.asIndexable(cf['Tipo de Documento Responsable']),
        ),
      ),
      documentNumber: this.asString(cf['Número de Documento Responsable']),
      isPrimary:    true,
      displayOrder: 1,
      source:       'clickup',
    }];
  }

  private buildAddresses(cf: CustomFieldMap): PatientAddress[] {
    const addresses: PatientAddress[] = [];

    // ClickUp stores structured location values as objects with lat/lng/formatted_address
    // and also accepts plain text in "Domicilio Informado" fields.
    //
    // Location metadata (state/city/neighborhood) is extracted from dedicated fields:
    //   "Provincia del Paciente"           → state  (location field)
    //   "Ciudad / Localidad del Paciente"  → city   (location field)
    //   "Zona o Barrio Paciente"           → neighborhood (short_text)
    // These are patient-level fields, not per-address. We populate them on the primary
    // address (slot 1) only, since the zona/barrio refers to the patient's usual zone.
    const patientState        = extractStateFromLocation(cf['Provincia del Paciente'])
                             ?? this.extractFormattedAddress(cf['Provincia del Paciente']);
    const patientCity         = extractCityFromLocation(cf['Ciudad / Localidad del Paciente'])
                             ?? this.extractFormattedAddress(cf['Ciudad / Localidad del Paciente']);
    const patientNeighborhood = extractNeighborhood(cf['Zona o Barrio Paciente']);

    const slots = [
      {
        location: cf['Domicilio 1 Principal Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 1']),
        type:     'primary' as const,
        order:    1,
        // Patient-level location metadata applied to primary address
        state:        patientState,
        city:         patientCity,
        neighborhood: patientNeighborhood,
      },
      {
        location: cf['Domicilio 2 Principal Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 2']),
        type:     'secondary' as const,
        order:    2,
        state:        null,
        city:         null,
        neighborhood: null,
      },
      {
        location: cf['Domicilio 3 Principal Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 3']),
        type:     'secondary' as const,
        order:    3,
        state:        null,
        city:         null,
        neighborhood: null,
      },
    ];

    for (const slot of slots) {
      const formatted = this.extractFormattedAddress(slot.location);
      if (!formatted && !slot.raw) continue;

      addresses.push({
        addressType:      slot.type,
        addressFormatted: formatted ?? undefined,
        addressRaw:       slot.raw   ?? undefined,
        displayOrder:     slot.order,
        state:            slot.state ?? undefined,
        city:             slot.city ?? undefined,
        neighborhood:     slot.neighborhood ?? undefined,
      });
    }

    return addresses;
  }

  private buildProfessionals(cf: CustomFieldMap, isTeamFlag: unknown): PatientProfessional[] {
    const isTeam = isTeamFlag === true || this.asString(isTeamFlag as unknown as string) === 'Sí';
    const slots  = [
      { nameCf: 'Profesional Tratante Principal', phoneCf: 'Tel Profesional Tratante Principal', emailCf: 'Email Profesional Tratante Principal', order: 1 },
      { nameCf: 'Profesional Tratante 2',         phoneCf: 'Tel Profesional Tratante 2',         emailCf: 'Email Profesional Tratante 2',         order: 2 },
      { nameCf: 'Profesional Tratante 3',         phoneCf: 'Tel Profesional Tratante 3',         emailCf: 'Email Profesional Tratante 3',         order: 3 },
    ];

    const professionals: PatientProfessional[] = [];
    for (const slot of slots) {
      const name = this.asString(cf[slot.nameCf]);
      if (!name?.trim()) continue;

      professionals.push({
        name:         name.trim(),
        phone:        this.cleanPhone(this.asString(cf[slot.phoneCf])),
        email:        this.asString(cf[slot.emailCf]),
        displayOrder: slot.order,
        isTeam:       slot.order === 1 ? isTeam : false,
      } as PatientProfessional);
    }

    return professionals;
  }

  /** Returns null for phone-only placeholders (just country code or < 10 digits). */
  private cleanPhone(raw: string | null): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) return null;
    // Strip leading 54 (Argentina country code) if the result is still long enough
    return raw.trim();
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

  /** Converts a custom-field value to a number suitable for resolveDropdown(). */
  private asIndexable(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  private extractFormattedAddress(location: unknown): string | null {
    if (!location || typeof location !== 'object') return null;
    const loc = location as Record<string, unknown>;
    return typeof loc['formatted_address'] === 'string' ? loc['formatted_address'] : null;
  }
}

/**
 * Extracts the operational case number from the ClickUp "Caso Número" custom field.
 * Uses a regex to extract the first digit sequence, so values like "Caso 766" or
 * "766" both yield 766.  Returns null when the field is absent, empty, or contains
 * no digits at all.
 */
export function extractCaseNumber(task: ClickUpTask): number | null {
  const raw = task.custom_fields.find(f => f.name === 'Caso Número')?.value;
  if (raw == null || raw === '') return null;
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}
