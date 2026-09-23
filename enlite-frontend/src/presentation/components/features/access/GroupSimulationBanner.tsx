import { useTranslation } from 'react-i18next';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';

/**
 * F3 (spec 026), decisão #2 do Gabriel: SÓ sinal visual — nenhum controle
 * (nem `Select`, nem botão de sair). O controle mora inteiro em
 * `GroupSimulationSelect`, no rodapé; este banner só avisa.
 *
 * Dois estados possíveis, mutuamente exclusivos:
 *  - simulação ATIVA: avisa qual grupo está sendo visto (chave `access.simulation.viewingAs`).
 *  - simulação venceu sozinha (TTL, decisão #4) e ainda não foi dispensada:
 *    aviso "expiró" com botão de fechar que só chama `dismissSimulationExpired`
 *    (não reabre nada, não repete a call).
 * Sem nenhum dos dois: não renderiza nada.
 */
export function GroupSimulationBanner(): JSX.Element | null {
  const { t } = useTranslation();
  const authz = useAdminAuthStore((s) => s.authz);
  const simulationExpired = useAdminAuthStore((s) => s.simulationExpired);
  const dismissSimulationExpired = useAdminAuthStore((s) => s.dismissSimulationExpired);

  const simulation = authz?.simulation ?? null;

  if (simulation) {
    return (
      <div
        data-testid="group-simulation-banner"
        role="status"
        className="w-full bg-primary/10 text-primary text-center py-1.5 text-xs font-medium"
      >
        {t('access.simulation.viewingAs', { group: simulation.groupName })}
      </div>
    );
  }

  if (simulationExpired) {
    return (
      <div
        data-testid="group-simulation-banner"
        role="alert"
        className="w-full bg-amber-100 text-amber-800 text-center py-1.5 text-xs font-medium flex items-center justify-center gap-2"
      >
        <span>{t('access.simulation.expired')}</span>
        <button
          type="button"
          data-testid="group-simulation-expired-dismiss"
          onClick={dismissSimulationExpired}
          className="underline hover:opacity-70 transition-opacity"
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}
