import type { ClinicalSpecialty } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Segmentos Clínicos" drop-down labels to canonical ClinicalSpecialty.
 *
 * ClickUp has 14 options that are combos of (service_tier × specialty).
 * Here we extract only the specialty dimension — the tier is captured via
 * the "Servicio" field (serviceMap.ts → Profession[]).
 */
export const CLICKUP_TO_CLINICAL_SPECIALTY: Record<string, ClinicalSpecialty> = {
  'AT para Pacientes con Discapacidad Intelectual':       'INTELLECTUAL_DISABILITY',  // ClickUp (es)
  'AT para Pacientes con Enfermedades Neurológicas':      'NEUROLOGICAL',              // ClickUp (es)
  'AT para Pacientes con Limitaciones Motrices':          'MOTOR_LIMITATIONS',         // ClickUp (es)
  'AT para Pacientes con TEA':                            'ASD',                       // ClickUp (es)
  'AT para Pacientes con Trastornos Psiquiátricos':       'PSYCHIATRIC',               // ClickUp (es)
  'AT para Personas en Vulnerabilidad Social':            'SOCIAL_VULNERABILITY',      // ClickUp (es)
  'AT para Personas Mayores (Geriatría)':                 'GERIATRIC',                 // ClickUp (es)
  'Cuidado Integral en Discapacidad Intelectual':         'INTELLECTUAL_DISABILITY',   // ClickUp (es)
  'Cuidado Integral en Enfermedades Neurológicas':        'NEUROLOGICAL',              // ClickUp (es)
  'Cuidado Integral en Patologías Específicas':           'SPECIFIC_PATHOLOGY',        // ClickUp (es)
  'Cuidado Integral de Pacientes con TEA':                'ASD',                       // ClickUp (es)
  'Cuidado Integral de Personas Mayores (Geriatría)':     'GERIATRIC',                 // ClickUp (es)
  'Cuidado de Pacientes con Limitaciones Motrices':       'MOTOR_LIMITATIONS',         // ClickUp (es)
  'Segmento Personalizado':                               'CUSTOM',                    // ClickUp (es)
};

export function mapClickUpClinicalSpecialty(label: string | null): ClinicalSpecialty | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_CLINICAL_SPECIALTY[label];
  if (mapped === undefined) {
    // Unknown ClickUp option — ops may have added or renamed one. The alarm names the FIELD
    // and the SHAPE of the value; it must NOT name the value. `Segmentos Clínicos` is a
    // CLINICAL field (dato sensible-salud): C1 do parecer do `lex` de 23/08 is a PARE on the
    // raw value, the orderindex, the option uuid and the resolved label reaching a log —
    // the log bucket is global and unrestricted. "Which option does not map" is answered from
    // the CATALOG (`/field`), with zero patients involved (C2).
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Segmentos Clínicos');
    console.warn('[clinicalSpecialtyMap] Unmapped ClickUp option (value withheld — C1/lex):', {
      field: 'Segmentos Clínicos',
      valueType: typeof label,
      isArray: Array.isArray(label),
      length: label.length,
    });
    return null;
  }
  return mapped;
}
