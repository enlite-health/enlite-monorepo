import type { DependencyLevel } from '@modules/case/domain/enums/DependencyLevel';
import type { Profession } from '@modules/worker/domain/enums/Profession';

/**
 * Rótulos ES dos enums que o app usa, para o prompt do Gem. Espelham o front (`es.json`: `admin.patients.dependencyOptions`
 * e `jobs.profession` / `admin.workerDetail.professionValue`). O `Record<Enum, string>` faz o `tsc` recusar um valor novo sem rótulo; o teste cobre o runtime.
 */
export const DEPENDENCY_LABELS_ES: Readonly<Record<DependencyLevel, string>> = {
  MILD: 'Leve',
  MODERATE: 'Moderada',
  SEVERE: 'Grave',
  VERY_SEVERE: 'Muy grave',
};

export const PROFESSION_LABELS_ES: Readonly<Record<Profession, string>> = {
  AT: 'Acompañante Terapéutico',
  CAREGIVER: 'Cuidador/a',
  NURSE: 'Enfermero/a',
  KINESIOLOGIST: 'Kinesiólogo/a',
  PSYCHOLOGIST: 'Psicólogo/a',
};
