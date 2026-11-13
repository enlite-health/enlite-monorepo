/**
 * patientRef — spec 077 FR-39 (DT-21): referência OPACA do paciente para o app da cuidadora.
 * uuid v5 do `patient_id` com namespace fixo: estável entre pulls, distinta por paciente, e o `patient_id` nunca sai.
 */
import { v5 as uuidv5 } from 'uuid';

/** Namespace fixo (DT-21). Trocar este valor muda todo `patient_ref` já guardado no app. */
export const PATIENT_REF_NAMESPACE = 'b1c7f0e2-6d3a-5f4e-9a1b-077000000001';

export function patientRefOf(patientId: string): string {
  return uuidv5(patientId, PATIENT_REF_NAMESPACE);
}
