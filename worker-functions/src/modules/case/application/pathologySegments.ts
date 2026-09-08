/**
 * derivePathologySegments — "Tipo de patología (segmento)" do Projeto Terapêutico NÃO se escolhe:
 * deriva dos diagnósticos CID-11 da versão (Gabriel, 08/09; D163/D164). Hoje o agrupador é o
 * CAPÍTULO, resolvido pela `TerminologyPort` — a mesma régua de `patient_diagnoses.concept_group`
 * (spec 016) e a suspensão declarada da D164 (D261: bloco não tem código nem linha no catálogo
 * local; `2026-08-05a#ABERTO-12` no Marcel). Trocar para bloco quando a porta o devolver é mexer
 * SÓ aqui.
 *
 * Puro em relação ao banco: recebe a porta por parâmetro (DIP), não conhece `pg`. Nunca loga a
 * URI (texto clínico identificado — T7 da terminologia): o erro tipado é o status.
 */
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import { TerminologyEntityNotFoundError } from '@modules/terminology/infrastructure/IcdCatalogTerminology';
import type { PathologySegment, TherapeuticDiagnosis } from '../domain/TherapeuticProject';

/** Uma URI escolhida no combobox não resolve no catálogo corrente — 422, nunca 500. */
export class DiagnosisUnknownError extends Error {
  readonly code = 'ptp_diagnosis_unknown';
  constructor() {
    super('Diagnosis URI not found in the terminology catalog');
    this.name = 'DiagnosisUnknownError';
  }
}

/** Capítulos CID-11 DISTINTOS dos diagnósticos, ordenados por código — `{ id: code, label: title }`. */
export async function derivePathologySegments(
  terminology: TerminologyPort,
  diagnoses: readonly Pick<TherapeuticDiagnosis, 'uri'>[],
): Promise<PathologySegment[]> {
  const byCode = new Map<string, PathologySegment>();
  for (const uri of new Set(diagnoses.map((d) => d.uri))) {
    let chapter: { code: string; title: string };
    try {
      ({ chapter } = await terminology.ancestorsOf(uri));
    } catch (err) {
      if (err instanceof TerminologyEntityNotFoundError) throw new DiagnosisUnknownError();
      throw err;
    }
    byCode.set(chapter.code, { id: chapter.code, label: chapter.title });
  }
  return [...byCode.values()].sort((a, b) => a.id.localeCompare(b.id));
}
