import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { List, LayoutGrid } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { usePatientKanban } from '@hooks/admin/usePatientKanban';
import { getCountryOptions } from '@presentation/pages/admin/patientsData';
import { PatientKanbanBoard } from '@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard';
import { Combobox } from '@presentation/components/atoms/Combobox';

/** Patient lifecycle kanban page. Route: /admin/patients/kanban. */
export function PatientKanbanPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [country, setCountry] = useState('');
  const { groups, isLoading, error, servicesStatus } = usePatientKanban(country);
  const countryOptions = getCountryOptions(t);

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <Heading level={1} weight="semibold" color="primary">
          {t('admin.patients.kanban.title')}
        </Heading>
        {/* F5 (estado-automatico-do-paciente): o board é só de leitura — o estado muda pelo fluxo automático e pelas ações da ficha. */}
        <Text size="sm" color="muted" className="basis-full sm:basis-auto" data-testid="kanban-readonly-hint">
          {t('admin.patients.kanban.readonlyHint')}
        </Text>
        <div className="flex items-center gap-2" data-testid="patients-view-toggle">
          {/* 210px: cabe "Todos los países" sem cortar (ver PatientFilters) */}
          <div className="w-[210px]" data-testid="patient-country-filter">
            <Combobox
              inputSize="compact"
              options={countryOptions}
              value={country}
              onChange={setCountry}
              placeholder={t('admin.patients.countryOptions.all')}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/admin/patients')}
            className="flex items-center gap-1"
            data-testid="patients-view-list"
          >
            <List className="w-4 h-4" />
            {t('admin.patients.kanban.toggleList')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex items-center gap-1"
            data-testid="patients-view-kanban"
          >
            <LayoutGrid className="w-4 h-4" />
            {t('admin.patients.kanban.toggleKanban')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="py-8 text-center">
          <Heading level={3} className="!text-red-600 mb-2">
            {t('admin.patients.errorLoading')}
          </Heading>
          <Text size="sm" color="secondary">{error}</Text>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : (
        <>
          {servicesStatus === 'error' && (
            <Text size="sm" color="muted" className="mb-2" data-testid="patient-kanban-services-error">
              {t('admin.patients.kanban.subcard.loadError')}
            </Text>
          )}
          <PatientKanbanBoard groups={groups} />
        </>
      )}
    </PageContainer>
  );
}
