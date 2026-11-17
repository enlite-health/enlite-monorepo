/** A recusa do servidor ao salvar uma versão, em frase da tela (spec 017) — fora do componente pelo lint de fast refresh. */
import { TherapeuticProjectApiError } from '@infrastructure/http/AdminTherapeuticProjectsApiService';

/** 091 (§9.4, DD-21): recusas do plano por diagnóstico — código → chave i18n da raiz `therapeuticProjectForm`; `block` = a frase também vai ao bloco do `details.diagnosisIndex`. Tabela, sem if por código. */
const PLAN_REFUSAL: Readonly<Record<string, { key: string; block: boolean }>> = {
  ptp_plan_block_incomplete: { key: 'therapeuticProjectForm.planIncomplete', block: true },
  ptp_plan_objective_invalid: { key: 'therapeuticProjectForm.catalogChanged', block: true },
  ptp_plan_activity_invalid: { key: 'therapeuticProjectForm.catalogChanged', block: true },
  ptp_plan_block_without_catalog: { key: 'therapeuticProjectForm.catalogChanged', block: true },
  ptp_format_mismatch: { key: 'therapeuticProjectForm.formatMismatch', block: false },
};

/** O bloco (índice do diagnóstico no corpo enviado) que o servidor apontou, com a frase da tela; `null` se a recusa não é de bloco. */
export function saveRefusalBlock(err: unknown, t: (k: string) => string): { diagnosisIndex: number; message: string } | null {
  if (!(err instanceof TherapeuticProjectApiError)) return null;
  const entry = err.code ? PLAN_REFUSAL[err.code] : undefined;
  const index = err.details?.diagnosisIndex;
  return entry?.block && typeof index === 'number' ? { diagnosisIndex: index, message: t(entry.key) } : null;
}

/**
 * A recusa do servidor em frase da tela: célula clínica ausente, serviço de outro paciente, catálogo
 * desativado, CID que não resolve, catálogo CID-11 fora do ar, MACRO travado fora de `mode:'new'`,
 * versão que deixou de ser vigente, contato selecionado que ficou inativo (PR-7, D328/lex #7 C7 —
 * `details.fields`/`kind`/`id` nunca carregam o VALOR, só o nome/ids do que foi recusado).
 */
export function saveRefusalMessage(err: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (err instanceof TherapeuticProjectApiError) {
    if (err.status === 403) return t('admin.patients.detail.therapeuticProjectForm.errors.forbidden');
    if (err.code === 'catalog_items_unknown') return t('admin.patients.detail.therapeuticProjectForm.errors.catalogItemsUnknown');
    if (err.code === 'service_not_of_patient') return t('admin.patients.detail.therapeuticProjectForm.errors.serviceNotOfPatient');
    if (err.code === 'source_version_not_found') return t('admin.patients.detail.therapeuticProjectForm.errors.sourceNotFound');
    // D303: o tipo de patologia deriva do CID-11 no servidor — o diagnóstico escolhido pode não resolver, ou a porta estar fora.
    if (err.code === 'ptp_diagnosis_unknown') return t('admin.patients.detail.therapeuticProjectForm.errors.diagnosisUnknown');
    if (err.code === 'TERMINOLOGY_UNAVAILABLE') return t('admin.patients.detail.therapeuticProjectForm.errors.terminologyUnavailable');
    // D328/ADR-4: `mode:'edit'` mudando campo MACRO — só nomes de campo no `details.fields`.
    if (err.code === 'ptp_macro_locked') {
      const fields = Array.isArray(err.details?.fields) ? (err.details!.fields as string[]).join(', ') : '';
      return t('admin.patients.detail.therapeuticProjectForm.errors.ptpMacroLocked', { fields });
    }
    // ADR-4/SUP-25: a versão de origem deixou de ser a vigente entre abrir o form e salvar.
    if (err.code === 'ptp_not_current') return t('admin.patients.detail.therapeuticProjectForm.errors.ptpNotCurrent');
    // lex #7 C7: nunca nome/telefone do contato — só a mensagem genérica.
    if (err.code === 'ptp_contact_inactive') return t('admin.patients.detail.therapeuticProjectForm.errors.ptpContactInactive');
    // 091: nunca o texto cru do back, nem o URI/ids do `details`.
    const plan = err.code ? PLAN_REFUSAL[err.code] : undefined;
    if (plan) return t(plan.key);
  }
  return err instanceof Error ? err.message : String(err);
}
