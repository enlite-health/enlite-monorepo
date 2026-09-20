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
import { Select } from '@presentation/components/atoms/Select';
import { DashboardSkeleton } from '@presentation/components/ui/skeletons';
import { useManagementDashboard } from '@hooks/admin/useManagementDashboard';
import { getScopedCountryOptions } from '@presentation/pages/admin/patientsData';
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
import { useContainerAccess } from '@presentation/hooks/useCellAccess';

export function ManagementDashboardPage(): JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch, funnelPeriod, setFunnelPeriod, country, setCountry } =
    useManagementDashboard();
  // PR-9 (`lex` #9, FR-734): lista SÓ os países do escopo do ator — nunca a lista fixa do
  // sistema. Vazio até a primeira resposta (o seletor não aparece sem `scope`).
  const countryOptions = getScopedCountryOptions(t, data?.scope?.countries ?? []);
  // D286: um `useContainerAccess` por bloco da tela (Pacientes fica no `ContainerGate` abaixo).
  const bloco = {
    numbers: useContainerAccess('dashboard_numbers').visible,
    team: useContainerAccess('dashboard_team').visible,
    priorities: useContainerAccess('dashboard_priorities').visible,
    registrations: useContainerAccess('dashboard_registrations').visible,
    funnel: useContainerAccess('dashboard_funnel').visible,
    zones: useContainerAccess('dashboard_zones').visible,
  };

  return (
    <PageContainer>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="h-8 w-8 text-primary" />
          <Heading level={1} weight="semibold" color="primary">
            {t('admin.managementDashboard.title')}
          </Heading>
        </div>
        {/* PR-9 (`lex` #9, US-22): seletor de país da PÁGINA INTEIRA — a seção de
            Pacientes segue este filtro, não tem mais um próprio (D286 + FR-730). */}
        {countryOptions.length > 0 && (
          <div className="w-[210px]" data-testid="mgmt-country-filter">
            <Select
              inputSize="compact"
              options={countryOptions}
              value={country}
              onValueChange={(value) => setCountry(value as 'AR' | 'BR' | '')}
              placeholder={t('admin.patients.countryOptions.all')}
            />
          </div>
        )}
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

      {/* D286: cada bloco tem célula própria e a API já veio projetada — o bloco sem célula vem
          `null` no payload, por isso a leitura das props fica DENTRO do ramo visível (o JSX de um
          filho é avaliado antes de qualquer gate decidir). */}
      {!isLoading && !error && data && (
        <div data-testid="mgmt-content" className="space-y-10">
          {bloco.numbers && (
            <BigNumbersSection
              data={data.bigNumbers}
              pacientes={data.pacientes}
              horas={data.horas}
              pctRespostaRapida={data.equipoArmada.pctRespostaRapidaArmado}
              pctCapacidade={data.encuadres.pctCapacidadeSemana}
            />
          )}
          {bloco.team && <EquipoArmadaSection equipoArmada={data.equipoArmada} horas={data.horas} />}
          {bloco.priorities && <PrioridadesSection data={data.prioridades} />}
          {/* Registros ANTES da Totalización — acordo da call 22/07 (02:21, D7). */}
          {bloco.registrations && <CadastrosSection data={data.cadastros} />}
          {bloco.funnel && (
            <FunnelTotalsSection
              funnelPorPrestador={data.funnelPorPrestador}
              encuadres={data.encuadres}
              period={funnelPeriod}
              onPeriodChange={setFunnelPeriod}
            />
          )}
          {bloco.zones && <ZoneAnalyticsSection />}
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
          <PacientesSection country={country} />
        </div>
      </ContainerGate>
    </PageContainer>
  );
}
