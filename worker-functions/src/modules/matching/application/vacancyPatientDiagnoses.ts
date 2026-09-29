/**
 * vacancyPatientDiagnoses — o mesmo bulkhead já usado em
 * `AdminPatientsController.getPatientById` (spec 016 F2, D263), aplicado às DUAS rotas de vaga que
 * embutem o paciente (`VacanciesController.getVacancyById`, `RecruitmentAnalyticsController.getCaseAnalysis`).
 * Ponto ÚNICO que decide os dois campos — `diagnoses`/`diagnosesUnavailable` — para as duas rotas
 * irmãs não divergirem no formato (o mesmo raciocínio de `patientContainerAccess.ts`).
 *
 * ⚠️ Decisão de desenho (D286/D263): o dado é lido por uma SEGUNDA chamada, ao
 * `PatientDiagnosisService`/`PostgresPatientDiagnosisRepository` — nunca por `JOIN
 * patient_diagnoses` na query principal da vaga. As duas rotas que chamam esta função têm guarda
 * de regressão própria (`__tests__/diagnosticoForaDaVaga.test.ts`) que assere a QUERY principal,
 * não a resposta — texto clínico livre não pode sequer ser BUSCADO por ela.
 *
 * Semântica dos dois campos (as três hipóteses são distintas, nunca confundir):
 *  · vaga sem `patient_id` (não há paciente vinculado) → `diagnoses: []`, nunca indisponível —
 *    não há nada a redigir nem a buscar.
 *  · ator sem `patient_clinical:read` → `diagnoses: null` (NUNCA `[]`, que diria "paciente sem
 *    diagnóstico" — D286, o mesmo vocabulário de `patientContainerAccess.redact`).
 *  · o repositório lança (catálogo fora do ar, `TERMINOLOGY_ADAPTER` mal configurado) →
 *    `diagnosesUnavailable: true`; `diagnoses` fica `[]` — bulkhead: a vaga inteira não cai por
 *    causa da busca de diagnóstico.
 */
import { PatientDiagnosisService } from '@modules/diagnosis/application/PatientDiagnosisService';
import { toDiagnosisPublicView, type DiagnosisPublicViewItem } from '@modules/diagnosis/interfaces/DiagnosisPublicView';
import { patientContainerReadsOf } from '@modules/case/application/patientContainerAccess';
import { reportError } from '@shared/logging';

export interface VacancyPatientDiagnoses {
  readonly diagnoses: DiagnosisPublicViewItem[] | null;
  readonly diagnosesUnavailable: boolean;
}

export async function loadVacancyPatientDiagnoses(
  service: PatientDiagnosisService,
  patientId: string | null | undefined,
  cells: readonly string[] | null | undefined,
  errorSource: string,
): Promise<VacancyPatientDiagnoses> {
  if (!patientId) return { diagnoses: [], diagnosesUnavailable: false };
  if (!patientContainerReadsOf(cells).clinical) return { diagnoses: null, diagnosesUnavailable: false };
  try {
    const result = await service.listForPatient(patientId);
    return {
      diagnoses: result.found ? result.diagnoses.map(toDiagnosisPublicView) : [],
      diagnosesUnavailable: false,
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: errorSource, patientId });
    return { diagnoses: [], diagnosesUnavailable: true };
  }
}
