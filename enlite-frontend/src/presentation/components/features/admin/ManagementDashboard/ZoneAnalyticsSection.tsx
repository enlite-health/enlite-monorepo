import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, AlertTriangle, Info } from 'lucide-react';
import {
  Text,
  Select,
  type SelectOption,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useZoneAnalytics } from '@hooks/admin/useZoneAnalytics';
import { WORKER_PROFESSIONS, type WorkerProfession } from '@domain/entities/Worker';
import { SectionHeader } from './SectionHeader';

const P = 'admin.managementDashboard.zoneAnalytics.';
/**
 * Rótulos de profissão reusados do grupo canônico já usado no card/match de
 * vacante (mesmos 5 valores de WORKER_PROFESSIONS: AT/CAREGIVER/NURSE/
 * KINESIOLOGIST/PSYCHOLOGIST) — ver VacancyCaseCard/MatchCriteriaChips e
 * enumTranslationCoverage.test.ts. Não duplicar um grupo paralelo aqui.
 */
const PROFESSION_LABEL_KEY = 'admin.vacancyDetail.vacancyForm.professionOptions';

/**
 * Seção "Analytics por Zona" (ClickUp 86ajb4qnw) — pacientes, prestadores por
 * sexo, demanda e disponibilidade agrupados por zona geográfica. Filtro de
 * profissão dispara refetch no worker-functions (dimensão de BI mínima).
 * Seção auto-contida: busca seus próprios dados (endpoint e ciclo de
 * atualização independentes do restante do dashboard).
 */
export function ZoneAnalyticsSection(): JSX.Element {
  const { t } = useTranslation();
  const [profession, setProfession] = useState<WorkerProfession | undefined>(undefined);
  const { data, isLoading, error, refetch } = useZoneAnalytics(profession);

  const professionOptions: SelectOption[] = WORKER_PROFESSIONS.map((value) => ({
    value,
    label: t(`${PROFESSION_LABEL_KEY}.${value}`, value),
  }));

  return (
    <section data-testid="mgmt-zone-analytics" className="space-y-4">
      <SectionHeader
        icon={MapPin}
        accent="cyan"
        title={t('admin.managementDashboard.sections.zoneAnalytics')}
        hint={t('admin.managementDashboard.sections.zoneAnalyticsHint')}
      />

      <div
        className="flex flex-wrap items-end gap-3"
        data-testid="mgmt-zone-analytics-filters"
      >
        <div className="w-full sm:w-[220px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t(`${P}filterLabel`)}
          </Text>
          <Select
            inputSize="compact"
            options={professionOptions}
            value={profession ?? ''}
            placeholder={t(`${P}filterAll`)}
            onValueChange={(v) => setProfession(v ? (v as WorkerProfession) : undefined)}
          />
        </div>
        <button
          type="button"
          onClick={() => setProfession(undefined)}
          disabled={!profession}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-slate-50"
        >
          {t(`${P}filterAll`)}
        </button>
      </div>

      {isLoading && (
        <div data-testid="mgmt-zone-analytics-loading">
          <TableSkeleton rows={5} />
        </div>
      )}

      {!isLoading && error && (
        <div
          data-testid="mgmt-zone-analytics-error"
          className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50 py-8 text-center"
        >
          <AlertTriangle className="h-8 w-8 text-red-400" />
          <Text as="p" weight="medium" className="text-red-700">
            {t('admin.managementDashboard.errorLoading')}
          </Text>
          <button
            type="button"
            onClick={refetch}
            className="mt-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            {t('admin.managementDashboard.retry')}
          </button>
        </div>
      )}

      {!isLoading && !error && data && (
        <>
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <Table>
              <TableHeader>
                <TableHead>{t(`${P}table.zone`)}</TableHead>
                <TableHead align="right">{t(`${P}table.patients`)}</TableHead>
                <TableHead align="right">{t(`${P}table.workersMale`)}</TableHead>
                <TableHead align="right">{t(`${P}table.workersFemale`)}</TableHead>
                <TableHead align="right">{t(`${P}table.demand`)}</TableHead>
                <TableHead align="right">{t(`${P}table.availability`)}</TableHead>
              </TableHeader>
              <TableBody>
                {data.zones.length === 0 && (
                  <TableRow clickable={false}>
                    <TableCell unwrapped colSpan={6}>
                      <Text as="p" size="sm" className="py-6 text-center text-slate-500">
                        {t(`${P}empty`)}
                      </Text>
                    </TableCell>
                  </TableRow>
                )}
                {data.zones.map((zone) => (
                  <TableRow key={zone.zone} clickable={false}>
                    <TableCell weight="medium">{zone.zone}</TableCell>
                    <TableCell align="right">{zone.patients}</TableCell>
                    <TableCell align="right">{zone.workersMale}</TableCell>
                    <TableCell align="right">{zone.workersFemale}</TableCell>
                    <TableCell align="right" weight="medium">
                      {zone.demand}
                    </TableCell>
                    <TableCell align="right">{zone.availability}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data.unresolvedCount > 0 && (
            <div
              data-testid="mgmt-zone-analytics-unresolved-note"
              className="flex items-start gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <Text as="p" size="sm" className="text-slate-600">
                {t(`${P}unresolvedNote`, { count: data.unresolvedCount })}
              </Text>
            </div>
          )}
        </>
      )}
    </section>
  );
}
