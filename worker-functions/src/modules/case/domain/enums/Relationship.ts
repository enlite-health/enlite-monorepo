/**
 * Relationship — canonical vocabulary for patient responsible's relationship to patient.
 * Rule: feedback_enum_values_english_uppercase.md
 *
 * Ampliado na migration 421 (spec 018, PR-2, SUP-16): +GRANDPARENT, UNCLE_AUNT, COUSIN, IN_LAW,
 * STEP_RELATIVE, RESPONSIBLE_PERSON. Lista fechada — tem de bater com o CHECK
 * `patient_responsibles_relationship_check` da migration mais recente que o define
 * (relationshipParity.contract.test.ts) e com `RELATIONSHIP_CODES` em patientEnums.ts.
 */

export type Relationship =
  | 'CHILD'
  | 'PARENT'
  | 'SIBLING'
  | 'NEPHEW'
  | 'GRANDCHILD'
  | 'GUARDIAN'
  | 'FRIEND'
  | 'PARTNER'
  | 'OTHER'
  | 'GRANDPARENT'
  | 'UNCLE_AUNT'
  | 'COUSIN'
  | 'IN_LAW'
  | 'STEP_RELATIVE'
  | 'RESPONSIBLE_PERSON';

export const RELATIONSHIPS: readonly Relationship[] = [
  'CHILD',
  'PARENT',
  'SIBLING',
  'NEPHEW',
  'GRANDCHILD',
  'GUARDIAN',
  'FRIEND',
  'PARTNER',
  'OTHER',
  'GRANDPARENT',
  'UNCLE_AUNT',
  'COUSIN',
  'IN_LAW',
  'STEP_RELATIVE',
  'RESPONSIBLE_PERSON',
] as const;

export function isRelationship(value: unknown): value is Relationship {
  return typeof value === 'string' && (RELATIONSHIPS as readonly string[]).includes(value);
}
