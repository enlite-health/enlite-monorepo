/**
 * ManagementDashboardPage — "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 * Rota: /admin/dashboard
 *
 * Snapshot operacional read-only para a coordenação priorizar rápido: big numbers,
 * prioridades de contato, totalização do funil e cadastros. Só orquestra — a
 * agregação vive no worker-functions (GET /analytics/dashboard/management).
 */
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, AlertTriangle } from 'lucide-react';
import { PageContainer, Heading, Text } from '@presentation/components/atoms';
import { DashboardSkeleton } from '@presentation/components/ui/skeletons';
import { useManagementDashboard } from '@hooks/admin/useManagementDashboard';
import {
  BigNumbersSection,
  EquipoArmadaSection,
  PrioridadesSection,
  FunnelTotalsSection,
  CadastrosSection,
  PacientesSection,
  ZoneAnalyticsSection,
} from '@presentation/components/features/admin/ManagementDashboard';
import { ContainerGate } from '@presentation/components/features/access';

export function ManagementDashboardPage(): JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch, funnelPeriod, setFunnelPeriod } =
    useManagementDashboard();

  return (
    <PageContainer>
      <div className="mb-8 flex items-center gap-3">
        <LayoutDashboard className="h-8 w-8 text-primary" />
        <Heading level={1} weight="semibold" color="primary">
          {t('admin.managementDashboard.title')}
        </Heading>
      </div>

      {isLoading && (
        <div data-testid="mgmt-loading">
          <DashboardSkeleton />
        </div>
      )}

      {!isLoading && error && (
        <div
          data-testid="mgmt-error"
          className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50 py-12 text-center"
        >
          <AlertTriangle className="h-10 w-10 text-red-400" />
          <Text as="p" weight="medium" className="text-red-700">
            {t('admin.managementDashboard.errorLoading')}
          </Text>
          <Text as="p" size="sm" className="text-red-500">
            {error}
          </Text>
          <button
            type="button"
            onClick={refetch}
            className="mt-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            {t('admin.managementDashboard.retry')}
          </button>
        </div>
      )}

      {!isLoading && !error && data && (
        <div data-testid="mgmt-content" className="space-y-10">
          <BigNumbersSection
            data={data.bigNumbers}
            pacientes={data.pacientes}
            horas={data.horas}
            pctRespostaRapida={data.equipoArmada.pctRespostaRapidaArmado}
            pctCapacidade={data.encuadres.pctCapacidadeSemana}
          />
          <EquipoArmadaSection equipoArmada={data.equipoArmada} horas={data.horas} />
          <PrioridadesSection data={data.prioridades} />
          {/* Registros ANTES da Totalización — acordo da call 22/07 (02:21, D7). */}
          <CadastrosSection data={data.cadastros} />
          <FunnelTotalsSection
            funnelPorPrestador={data.funnelPorPrestador}
            encuadres={data.encuadres}
            period={funnelPeriod}
            onPeriodChange={setFunnelPeriod}
          />
          <ZoneAnalyticsSection />
        </div>
      )}

      {/*
        Pacientes tem fonte própria (/patients/stats + /patients/funnel), por isso
        fica FORA do bloco acima: se a agregação de recrutamento falhar, estes
        números continuam aparecendo.
      */}
      {/* D286: a seção de pacientes lê /patients/stats + /patients/funnel (patient:read) — sem a
          célula o container some; os números de recrutamento acima ficam. */}
      <ContainerGate resource="patient">
        <div className="mt-10">
          <PacientesSection />
        </div>
      </ContainerGate>
    </PageContainer>
  );
}
