/**
 * Container REAL da lista — busca via hook (`useAnaCareHoursMonth`) injetando o serviço recebido
 * por prop (produção: `AnaCareHoursHttpService`), delega a apresentação a `AnaCareHoursListPage`.
 * Portado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHoursListContainer.tsx`
 * (harness/preview, "NÃO é rota real") — aqui É a rota real (`App.tsx`,
 * `feature="screen:ana-care"`). Único ajuste: erro `'FONTE_NAO_CONFIGURADA'` (contrato HTTP: GET
 * 503) vira uma mensagem TRADUZIDA e clara — nunca tela branca (brief).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Text } from '@presentation/components/atoms/Text';
import { useAnaCareHoursMonth } from '@hooks/admin/useAnaCareHoursMonth';
import { AnaCareHoursListPage } from './AnaCareHoursListPage';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { SinCheckinHoursMode } from './selectors';

interface AnaCareHoursListContainerProps {
  service: AnaCareHoursService;
  onOpenPatient: (patientId: string) => void;
  initialMonth?: string;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}

export function AnaCareHoursListContainer({
  service,
  onOpenPatient,
  initialMonth = '2026-08',
  sinCheckinHoursMode,
}: AnaCareHoursListContainerProps): JSX.Element {
  const { t } = useTranslation();
  const [month, setMonth] = useState(initialMonth);
  const { snapshot, isLoading, error } = useAnaCareHoursMonth(service, month);

  if (isLoading && !snapshot) {
    return (
      <PageContainer>
        <Text color="muted" data-testid="anacare-hours-list-loading">
          {t('admin.anacareHours.list.loading')}
        </Text>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <Text className="!text-red-600" data-testid="anacare-hours-list-error">
          {error === 'FONTE_NAO_CONFIGURADA' ? t('admin.anacareHours.error.sourceNotConfigured') : error}
        </Text>
      </PageContainer>
    );
  }

  if (!snapshot) {
    return <PageContainer>{null}</PageContainer>;
  }

  return (
    <AnaCareHoursListPage snapshot={snapshot} onOpenPatient={onOpenPatient} onMonthChange={setMonth} sinCheckinHoursMode={sinCheckinHoursMode} />
  );
}
