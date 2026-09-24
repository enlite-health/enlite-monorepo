import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';

/**
 * F2 (spec 026, `troca-de-grupo-simulado-com-feedback-e-cache-versionado`) —
 * overlay de TELA CHEIA durante a troca de grupo simulado. Dor original do
 * Gabriel (24/09): "escolho o grupo no select e demora, não sei se está
 * mudando ou travado". `startSimulation`/`endSimulation` (adminAuthStore)
 * agora confirmam a troca (refazem `fetchAuthz()` em loop até o contrato
 * refletir) e expõem esse andamento em `switching`/`switchError` — este
 * componente só RENDERIZA o que a store decide, sem lógica própria.
 *
 * Bloqueia interação de propósito (cobre tudo, sem `Escape`/clique fora) —
 * enquanto a troca está em curso não há o que fazer na tela de baixo, e
 * deixar clicar teria efeito indefinido (célula do grupo velho ou do novo?).
 * `z-[100]` — mesmo teto que `NewVersionBanner`/`Toaster` (nenhum outro
 * elemento fixo do app passa disso; ver grep `z-\[` em `src/presentation`).
 *
 * Efeito colateral desejado: como o overlay é OPACO e cobre o banner
 * (`GroupSimulationBanner`), ele também esconde o "flash" de `simulationExpired`
 * que a store liga momentaneamente durante o loop de confirmação (decisão #4 —
 * `fetchAuthz()` genérico marca `simulationExpired` a cada chamada; só o `set`
 * final de `endSimulation`/`startSimulation` zera de novo). L37: com o overlay
 * por cima, ninguém vê esse intermediário — o banner só reaparece já com
 * `simulationExpired: false`.
 */
export function GroupSwitchOverlay(): JSX.Element | null {
  const { t } = useTranslation();
  const switching = useAdminAuthStore((s) => s.switching);
  const switchError = useAdminAuthStore((s) => s.switchError);
  const dismissSwitchError = useAdminAuthStore((s) => s.dismissSwitchError);

  if (!switching && !switchError) return null;

  const mensagem = switchError
    ? t('access.simulation.switchUnconfirmed')
    : switching?.kind === 'start'
      ? t('access.simulation.switchingTo', { group: switching.groupName })
      : t('access.simulation.switchingBack');

  return (
    <div
      data-testid="group-switch-overlay"
      role="status"
      aria-live="polite"
      aria-busy={!switchError}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background/90"
    >
      {!switchError && (
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" aria-hidden="true" />
      )}
      <Text size="sm" weight="medium" color="secondary" className="text-center px-6">
        {mensagem}
      </Text>
      {switchError && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="group-switch-retry"
          onClick={dismissSwitchError}
        >
          {t('access.simulation.switchRetry')}
        </Button>
      )}
    </div>
  );
}
