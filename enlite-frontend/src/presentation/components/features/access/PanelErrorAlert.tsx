import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms';

/**
 * O alerta de erro do painel — um só, para as cinco telas. Recebe a CHAVE de
 * i18n (as páginas guardam a chave, não a frase, para `t` não entrar em deps).
 */
export function PanelErrorAlert({ keyName }: { keyName: string | null }): JSX.Element | null {
  const { t } = useTranslation();
  if (!keyName) return null;
  return (
    <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg" role="alert">
      <Text size="sm" color="primary">{t(keyName)}</Text>
    </div>
  );
}
