/**
 * TactiqExtensionRow — estado da extensão do Tactiq no Chrome do operador (sem_relatorio / ausente / desativada /
 * instalada). Só informa; não há ação aqui (instalar/ativar é no Chrome). Tons iguais aos do vínculo (`SealChip`):
 * instalada ok · ausente/sem relatório atenção · desativada quebrado. Cor nunca é a única pista: o estado vem escrito.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { SealChip } from '@presentation/components/features/admin/PatientDetail/admission/AdmissionSeals';
import type { SealTone } from '@presentation/components/features/admin/PatientDetail/admission/sealTones';
import { formatInstant } from '@presentation/utils/dateTimeFormat';
import type { TactiqExtensionState, TactiqExtensionStatus } from '@infrastructure/http/AdminAdmissionApiService';
import { ProfileField } from './ProfileField';

const EXTENSION_TONE: Record<TactiqExtensionState, SealTone> = {
  instalada: 'ok',
  sem_relatorio: 'neutral',
  ausente: 'warn',
  desativada: 'bad',
};

interface Props {
  /** Ausente (back antigo, que ainda não manda o campo) = `sem_relatorio`. */
  extension: TactiqExtensionStatus | undefined;
  locale: string;
}

/**
 * Devolve as CÉLULAS da metade (cabeçalho, ajuda, par "Último reporte") — o pai é o contêiner de linhas
 * compartilhadas (subgrid) e define o espaçamento; aqui vão o conteúdo e o `row-start` de cada célula.
 */
export function TactiqExtensionRow({ extension, locale }: Props): JSX.Element {
  const { t } = useTranslation();
  const tt = (key: string): string => t(`admin.profile.tactiq.extension.${key}`);
  // Tolera campo ausente e valor desconhecido (back mais novo que o front): ambos caem em "sem relatório".
  const state: TactiqExtensionState = extension && extension.state in EXTENSION_TONE ? extension.state : 'sem_relatorio';
  const reportedAt = extension?.reportedAt
    ? formatInstant(extension.reportedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, locale)
    : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 xl:row-start-1" data-testid="tactiq-extension">
        <Text as="span" size="2xs" color="primary" className="uppercase">{tt('label')}</Text>
        <SealChip tone={EXTENSION_TONE[state]} testId="tactiq-extension-state">{tt(`state.${state}`)}</SealChip>
      </div>
      <Text color="inherit" size="sm" className="text-gray-900 mt-5 xl:row-start-2" data-testid="tactiq-extension-help">{tt(`help.${state}`)}</Text>
      {reportedAt && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5 xl:row-start-3">
          <ProfileField label={tt('reportedAt')} value={reportedAt} testId="tactiq-extension-reported" />
        </div>
      )}
    </>
  );
}
