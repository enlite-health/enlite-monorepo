/**
 * Lista do mês — conferência de horas do Ana Care (V1, protótipo visual).
 *
 * Filtros travados: paciente (busca livre) e prestador (select) + mês. NADA de filtro por obra
 * social ou outro filtro (regra dura do brief). Nome só aparece se o paciente/prestador está
 * vinculado à nossa base — não vinculado mostra "Sin vínculo · ID Ana Care" (regra dura).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { AlertBanner } from '@presentation/components/organisms/Alert/AlertBanner';
import { OriginLegend } from './OriginLegend';
import { ProviderFilterCombobox } from './ProviderFilterCombobox';
import type { AnaCareMonthSnapshot, AnaCarePatient } from './types';
import { allShiftsOf, originCounts, patientDisplayName, providerDisplayName, totalHours, validationProgress, type SinCheckinHoursMode } from './selectors';

const MONTH_VALUES = ['2026-08', '2026-09'] as const;

interface AnaCareHoursListPageProps {
  snapshot: AnaCareMonthSnapshot;
  onOpenPatient: (patientId: string) => void;
  onMonthChange?: (month: string) => void;
  initialProviderFilterId?: string;
  initialSearch?: string;
  /** Decisão AINDA ABERTA do harness (task 6) — nunca hardcoded aqui. */
  sinCheckinHoursMode?: SinCheckinHoursMode;
}

export function AnaCareHoursListPage({
  snapshot,
  onOpenPatient,
  onMonthChange,
  initialProviderFilterId = '',
  initialSearch = '',
  sinCheckinHoursMode = 'zero',
}: AnaCareHoursListPageProps): JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState(initialSearch);
  const [providerFilterId, setProviderFilterId] = useState(initialProviderFilterId);
  const monthOptions = useMemo(
    () => MONTH_VALUES.map((value) => ({ value, label: t(`admin.anacareHours.months.${value}`) })),
    [t],
  );

  const providerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const patient of snapshot.patients) {
      for (const provider of patient.providers) {
        seen.set(provider.anaCareId, providerDisplayName(provider));
      }
    }
    return Array.from(seen.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [snapshot.patients]);

  const filteredPatients = useMemo(() => {
    return snapshot.patients.filter((patient) => {
      if (providerFilterId && !patient.providers.some((p) => p.anaCareId === providerFilterId)) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const label = patientDisplayName(patient).toLowerCase();
        if (!label.includes(q) && !patient.anaCareId.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot.patients, providerFilterId, search]);

  const retratoDesactualizado = snapshot.stale || snapshot.circuitBreakerOpen;

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Heading level={1}>{t('admin.anacareHours.title')}</Heading>
            <Text size="xs" color="muted" className="mt-1">
              {t('admin.anacareHours.updatedAt', { datetime: formatDateTime(snapshot.updatedAt) })}
            </Text>
          </div>
          <div className="w-48">
            <Select
              inputSize="compact"
              options={monthOptions}
              value={snapshot.month}
              onValueChange={(v) => onMonthChange?.(v)}
              aria-label={t('admin.anacareHours.monthAriaLabel')}
            />
          </div>
        </div>

        {retratoDesactualizado && (
          <AlertBanner
            variant="warning"
            title={
              // Item 3 (revisão de PR): "nunca construído" NÃO é "mais de 24 horas" — mensagem
              // própria, para não afirmar uma sincronização que nunca aconteceu.
              snapshot.snapshotState === 'nao_construido'
                ? t('admin.anacareHours.stale.titleNaoConstruido')
                : t('admin.anacareHours.stale.title')
            }
            message={
              snapshot.snapshotState === 'nao_construido'
                ? t('admin.anacareHours.stale.messageNaoConstruido')
                : snapshot.circuitBreakerOpen
                  ? t('admin.anacareHours.stale.messageCircuitBreaker')
                  : t('admin.anacareHours.stale.messageSimple')
            }
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-64">
            <Input
              inputSize="compact"
              placeholder={t('admin.anacareHours.list.searchPlaceholder')}
              leftIcon={<Search className="w-4 h-4 text-gray-800" />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('admin.anacareHours.list.searchAriaLabel')}
              data-testid="anacare-hours-patient-search"
            />
          </div>
          <div className="w-64">
            <ProviderFilterCombobox
              id="anacare-hours-provider-filter"
              options={providerOptions}
              value={providerFilterId}
              onValueChange={setProviderFilterId}
              placeholder={t('admin.anacareHours.list.providerFilterPlaceholder')}
              ariaLabel={t('admin.anacareHours.list.providerFilterAriaLabel')}
            />
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableHead>{t('admin.anacareHours.list.table.patient')}</TableHead>
            <TableHead align="center">{t('admin.anacareHours.list.table.providers')}</TableHead>
            <TableHead align="center">{t('admin.anacareHours.list.table.shifts')}</TableHead>
            <TableHead align="right">{t('admin.anacareHours.list.table.totalHours')}</TableHead>
            <TableHead>{t('admin.anacareHours.list.table.validation')}</TableHead>
            <TableHead unwrapped>
              <div className="flex items-center gap-1.5">
                <Text as="span" size="xs" weight="medium" color="secondary">
                  {t('admin.anacareHours.list.table.originCheckin')}
                </Text>
                <OriginLegend testIdPrefix="anacare-hours-origin-legend-list" />
              </div>
            </TableHead>
          </TableHeader>
          <TableBody>
            {filteredPatients.length === 0 ? (
              <TableRow clickable={false}>
                <TableCell unwrapped colSpan={6}>
                  <div className="py-10 text-center">
                    <Text color="muted">
                      {snapshot.patients.length === 0
                        ? t('admin.anacareHours.list.emptyNoShifts')
                        : t('admin.anacareHours.list.emptyNoMatch')}
                    </Text>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredPatients.map((patient) => (
                <PatientRow key={patient.anaCareId} patient={patient} onOpen={onOpenPatient} sinCheckinHoursMode={sinCheckinHoursMode} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  );
}

function PatientRow({
  patient,
  onOpen,
  sinCheckinHoursMode = 'zero',
}: {
  patient: AnaCarePatient;
  onOpen: (id: string) => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}): JSX.Element {
  const { t } = useTranslation();
  const shifts = allShiftsOf(patient);
  const progress = validationProgress(shifts);
  const origins = originCounts(shifts);
  const hours = totalHours(shifts, sinCheckinHoursMode);

  return (
    <TableRow onClick={() => onOpen(patient.anaCareId)} data-testid={`anacare-hours-patient-row-${patient.anaCareId}`}>
      <TableCell weight="medium">{patientDisplayName(patient)}</TableCell>
      <TableCell align="center">{patient.providers.length}</TableCell>
      <TableCell align="center">{shifts.length}</TableCell>
      <TableCell align="right">{hours.toFixed(1)} h</TableCell>
      <TableCell unwrapped>
        <div className="flex flex-col gap-1 min-w-[140px]">
          <ProgressBar percentage={progress.percentage} height="sm" className="w-24" />
          <Text as="span" size="xs" color="muted" className="whitespace-nowrap">
            {t('admin.anacareHours.list.validationSummary', { count: progress.validated, total: progress.total })}
            {progress.contested > 0 ? t('admin.anacareHours.list.validationSummaryContestedSuffix', { count: progress.contested }) : ''}
          </Text>
        </div>
      </TableCell>
      <TableCell unwrapped>
        <div className="flex flex-wrap items-center gap-1.5">
          {origins.sinCheckin > 0 && (
            <MiniOriginCount label={t('admin.anacareHours.origin.sinCheckin')} count={origins.sinCheckin} origin="sin_checkin" />
          )}
          {origins.webAdmin > 0 && (
            <MiniOriginCount label={t('admin.anacareHours.origin.webAdmin')} count={origins.webAdmin} origin="web_admin" />
          )}
          {origins.app > 0 && <MiniOriginCount label={t('admin.anacareHours.origin.app')} count={origins.app} origin="app" />}
        </div>
      </TableCell>
    </TableRow>
  );
}

function MiniOriginCount({ count, origin, label }: { count: number; origin: 'sin_checkin' | 'web_admin' | 'app'; label: string }): JSX.Element {
  const bg = origin === 'sin_checkin' ? 'bg-red-100 text-red-700' : origin === 'web_admin' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${bg}`} title={label}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {count}
      </Text>
    </span>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
