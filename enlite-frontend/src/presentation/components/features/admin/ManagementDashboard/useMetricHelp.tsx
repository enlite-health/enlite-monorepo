import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpDrawer } from './HelpDrawer';
import type { ManagementHelpKey } from './helpKeys';

/**
 * Estado do "¿Qué es este número?" de uma seção do dashboard.
 *
 * Cada seção monta seu próprio drawer (mesmo padrão de montagem condicional
 * dos drawers de edição do admin):
 *
 *   const { helpProps, openHelp, helpDrawer } = useMetricHelp();
 *   <MetricCard {...helpProps('pacientesActivos')} ... />
 *   {helpDrawer}
 *
 * `helpProps` é para MetricCard; `openHelp` serve para blocos que não são
 * MetricCard (caixa de casos não medíveis, colunas do funil, header de zona).
 */
export function useMetricHelp(): {
  helpProps: (key: ManagementHelpKey) => { onHelpClick: () => void; helpAriaLabel: string };
  openHelp: (key: ManagementHelpKey) => void;
  helpAriaLabel: string;
  helpDrawer: JSX.Element | null;
} {
  const { t } = useTranslation();
  const [helpKey, setHelpKey] = useState<ManagementHelpKey | null>(null);
  const helpAriaLabel = t('admin.managementDashboard.help.ariaLabel');

  return {
    helpProps: (key: ManagementHelpKey) => ({
      onHelpClick: () => setHelpKey(key),
      helpAriaLabel,
    }),
    openHelp: (key: ManagementHelpKey) => setHelpKey(key),
    helpAriaLabel,
    helpDrawer: helpKey ? <HelpDrawer helpKey={helpKey} onClose={() => setHelpKey(null)} /> : null,
  };
}
