import { useTranslation } from 'react-i18next';
import { useAppVersionPolling } from '@hooks/useAppVersionPolling';
import { Text } from '@presentation/components/atoms/Text';

/**
 * Banner global servido no topo da SPA quando o bundle JS em memória do operador
 * diverge do bundle disponível em produção. Ações futuras (deploy de fixes, novas
 * features) só "entram em vigor" depois que o operador recarrega o tab — e
 * operadores não-técnicos raramente fazem isso por conta própria.
 *
 * Estratégia conservadora: o reload é manual (botão), nunca automático, para
 * não destruir edições em forms abertos. O banner persiste até o operador clicar.
 */
export function NewVersionBanner(): JSX.Element | null {
  const { t } = useTranslation();
  const hasNewVersion = useAppVersionPolling();

  if (!hasNewVersion) return null;

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[100] bg-primary text-white px-6 py-3 flex items-center justify-center gap-4 shadow-md"
      data-testid="new-version-banner"
    >
      <Text size="sm" color="inherit" className="text-white">
        {t('app.newVersion.message')}
      </Text>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="bg-white text-primary rounded-full px-4 py-1 text-sm font-semibold hover:bg-white/90 transition-colors"
        data-testid="new-version-banner-reload"
      >
        {t('app.newVersion.reload')}
      </button>
    </div>
  );
}
