import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { List, LayoutGrid } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useToast } from '@presentation/hooks/useToast';
import { usePatientKanban } from '@hooks/admin/usePatientKanban';
import { getCountryOptions } from '@presentation/pages/admin/patientsData';
import { friendlyStatusMessage } from '@presentation/utils/patientStatusMessages';
import { PatientKanbanBoard } from '@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard';

/** Patient lifecycle kanban page. Route: /admin/patients/kanban. */
export function PatientKanbanPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showToast = useToast();
  const [country, setCountry] = useState('');
  const { groups, isLoading, error, moveStatus } = usePatientKanban(country);
  const countryOptions = getCountryOptions(t);

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <Heading level={1} weight="semibold" color="primary">
          {t('admin.patients.kanban.title')}
        </Heading>
        {/* Spec 014 US-D5: nada indicava que arrastar é a única forma de mudar o estado. */}
        <Text size="sm" color="muted" className="basis-full sm:basis-auto" data-testid="kanban-drag-hint">
          {t('admin.patients.kanban.dragHint')}
        </Text>
        <div className="flex items-center gap-2" data-testid="patients-view-toggle">
          {/* 210px: cabe "Todos los países" sem cortar (ver PatientFilters) */}
          <div className="w-[210px]" data-testid="patient-country-filter">
            <Select
              inputSize="compact"
              options={countryOptions}
              value={country}
              onValueChange={setCountry}
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
        <PatientKanbanBoard
          groups={groups}
          onMove={async (patientId, target, opts) => {
            const err = await moveStatus(patientId, target, opts);
            if (err) {
              // Spec 014 (US-D5, lex D5.1): `err.code` é um CÓDIGO de enum quando o backend manda
              // um (PatientApiError.code) — traduz com i18n; nunca eco de campo do paciente, nunca
              // console.* com o corpo da resposta. Spec 051 (§6.4): as recusas da troca de estado
              // saem na MESMA frase amigável da ficha (sem código técnico); o resto cai no mapa por
              // código de antes e, por fim, no genérico.
              const codeMessage = t(`admin.patients.kanban.moveErrorCodes.${err.code}`, { defaultValue: '' });
              const mensagem = friendlyStatusMessage(t, err) || codeMessage || t('admin.patients.kanban.moveError');
              showToast(mensagem, 'error');
            }
            return err;
          }}
        />
      )}
    </PageContainer>
  );
}
