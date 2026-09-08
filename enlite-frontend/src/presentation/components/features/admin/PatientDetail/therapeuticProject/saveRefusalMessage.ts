/** A recusa do servidor ao salvar uma versão, em frase da tela (spec 017) — fora do componente pelo lint de fast refresh. */
import { TherapeuticProjectApiError } from '@infrastructure/http/AdminTherapeuticProjectsApiService';

/** A recusa do servidor em frase da tela: célula clínica ausente, serviço de outro paciente, catálogo desativado, CID que não resolve, catálogo CID-11 fora do ar. */
export function saveRefusalMessage(err: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (err instanceof TherapeuticProjectApiError) {
    if (err.status === 403) return t('admin.patients.detail.therapeuticProjectForm.errors.forbidden');
    if (err.code === 'catalog_items_unknown') return t('admin.patients.detail.therapeuticProjectForm.errors.catalogItemsUnknown');
    if (err.code === 'service_not_of_patient') return t('admin.patients.detail.therapeuticProjectForm.errors.serviceNotOfPatient');
    if (err.code === 'source_version_not_found') return t('admin.patients.detail.therapeuticProjectForm.errors.sourceNotFound');
    // D303: o tipo de patologia deriva do CID-11 no servidor — o diagnóstico escolhido pode não resolver, ou a porta estar fora.
    if (err.code === 'ptp_diagnosis_unknown') return t('admin.patients.detail.therapeuticProjectForm.errors.diagnosisUnknown');
    if (err.code === 'TERMINOLOGY_UNAVAILABLE') return t('admin.patients.detail.therapeuticProjectForm.errors.terminologyUnavailable');
  }
  return err instanceof Error ? err.message : String(err);
}
