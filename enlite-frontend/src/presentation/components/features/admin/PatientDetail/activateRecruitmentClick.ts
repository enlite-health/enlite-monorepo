import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';

/**
 * UMA linha da tabela — as 5 colunas do Figma (decisão do Gabriel 05/09; "Sexo" ficou de fora a
 * pedido dele). Dispositivo ≠ Local ≠ Endereço: três coisas distintas. O endereço é resolvido
 * pelo PONTEIRO `service.addressId` contra `patient.addresses` — nada de endereço é copiado no
 * serviço (migration 330). Clique na linha abre o detalhe completo (`ContractedServiceDetailDrawer`).
 */
/**
 * Ícone "Activar reclutamiento" — 1 por linha de serviço ATIVO (spec 018, PR-6, ADR-5,
 * `contracts/activation.md`). Desabilitado + tooltip quando falta código do gate
 * (`RECRUITMENT_BLOCKING_CODES`); some (vira "Ver vacante") quando o serviço já tem vaga viva.
 * A régua real é sempre o backend (422 `PATIENT_NOT_READY`) — este componente só antecipa o
 * estado na tela para a operadora não bater numa recusa óbvia.
 */
interface ActivateRecruitmentClickDeps {
  patientId: string;
  serviceId: string;
  missing: string[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onActivated: () => void;
  /** `tc` — já namespaced em `contractedServicesCard.` (ver uso abaixo). */
  tc: (k: string, o?: Record<string, unknown>) => string;
  /** `t` cru — os códigos de `completeness.items.*` vivem fora do namespace do `tc`. */
  t: (k: string, o?: any) => string;
  showToast: (message: string, kind: 'success' | 'error') => void;
}

/**
 * Guarda + chamada do `activate-recruitment` — extraído do `onClick` para ser testável DIRETO,
 * sem depender de disparar clique num botão HTML `disabled` (o `disabled` nativo já barra o
 * clique antes de o handler rodar — mesma armadilha do `runAssociateProvider` vizinho, "QA-caça
 * #4" no histórico deste diretório). O guard (`missing.length > 0 || busy`) é redundante com o
 * `disabled` do botão só NA UI; continua aqui porque é este código, e não o atributo HTML, que a
 * suíte prova.
 */
export async function runActivateRecruitmentClick(deps: ActivateRecruitmentClickDeps): Promise<void> {
  if (deps.missing.length > 0 || deps.busy) return;
  deps.setBusy(true);
  try {
    await AdminContractedServicesApiService.activateRecruitment(deps.patientId, deps.serviceId);
    deps.showToast(deps.tc('activateRecruitmentToast'), 'success');
    deps.onActivated();
  } catch (err) {
    if (err instanceof ContractedServiceApiError && err.code === 'SERVICE_ALREADY_RECRUITING') {
      deps.showToast(deps.tc('activateRecruitmentAlreadyRecruiting'), 'error');
      deps.onActivated(); // refetch: a ficha vai mostrar "Ver vacante" agora
    } else if (err instanceof ContractedServiceApiError && err.code === 'PATIENT_NOT_READY') {
      const codes = ((err.details?.missing as string[] | undefined) ?? []).map((code) =>
        deps.t(`admin.patients.detail.completeness.items.${code}`, code),
      );
      deps.showToast(deps.tc('activateRecruitmentTooltip', { items: codes.join(', ') }), 'error');
    } else {
      deps.showToast(deps.tc('activateRecruitmentError'), 'error');
    }
  } finally {
    deps.setBusy(false);
  }
}
