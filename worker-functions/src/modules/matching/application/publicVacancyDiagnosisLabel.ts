/**
 * publicVacancyDiagnosisLabel — spec 042 (D473). O NOME (título de catálogo CID-11, em espanhol)
 * do diagnóstico que a página pública da vaga mostra. Irmão de `vacancyPatientDiagnoses.ts`, mas
 * sem gate de célula (a rota é pública, não há ator) e sem a view do painel: devolve só
 * `string | null`.
 *
 * Mesmas regras de `vacancyPatientDiagnoses`: SEGUNDA chamada ao `PatientDiagnosisService`, nunca
 * `JOIN` na query principal; bulkhead — se o serviço falhar, devolve `null` e a vaga segue
 * servindo. O rótulo NUNCA é logado nem vai ao `reportError`: só o `vacancyId` (uuid interno).
 * `getService` é lazy e roda DENTRO do `try` (`createTerminologyPort` lança com env inválida).
 */
import type { PatientDiagnosisService } from '@modules/diagnosis/application/PatientDiagnosisService';
import { selectPublicDiagnosisLabel } from '@modules/diagnosis/domain/PublicDiagnosisSelection';
import { reportError } from '@shared/logging';

export async function loadPublicVacancyDiagnosisLabel(
  getService: () => PatientDiagnosisService,
  patientId: string | null | undefined,
  vacancyId: string,
): Promise<string | null> {
  if (!patientId) return null;
  try {
    const result = await getService().listForPatient(patientId);
    return result.found ? selectPublicDiagnosisLabel(result.diagnoses) : null;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'PublicVacancyController:diagnosisLabel', vacancyId });
    return null;
  }
}
