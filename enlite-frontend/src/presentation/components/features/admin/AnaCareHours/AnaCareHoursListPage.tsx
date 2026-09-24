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
import { AnaCareHoursSyncButton } from './AnaCareHoursSyncButton';
import type { AnaCareListPatient, AnaCareMonthSnapshot } from './types';
import { formatDateTime, formatMonthLabel, monthOptionsUntilNow, patientDisplayName, providerDisplayName, shouldShowStatusBanner, statusBannerKind, type SinCheckinHoursMode } from './selectors';
import type { UseAnaCareHoursSyncResult } from '@hooks/admin/useAnaCareHoursSync';

interface AnaCareHoursListPageProps {
  snapshot: AnaCareMonthSnapshot;
  onOpenPatient: (patientId: string) => void;
  onMonthChange?: (month: string) => void;
  /**
   * Mês que o seletor EXIBE — fonte da verdade é o container (`month` do `useState`, o MESMO que
   * alimenta `useAnaCareHoursSync`), nunca `snapshot.month`: enquanto o fetch do mês novo está em
   * voo, `snapshot` ainda é do mês ANTERIOR, e exibir `snapshot.month` no seletor é o que fazia o
   * seletor mentir sobre qual mês o botão "Sincronizar" ia enviar. Sem esta prop (uso isolado,
   * ex.: testes/harness), cai para `snapshot.month` — comportamento antigo preservado.
   */
  selectedMonth?: string;
  /**
   * `true` quando `snapshot` ainda é de um mês DIFERENTE do `selectedMonth` (fetch do mês novo em
   * voo) — a tabela não mostra as linhas do mês antigo sob o rótulo do mês novo (mentira visual);
   * mostra um estado de carregamento no lugar até o snapshot do mês selecionado chegar.
   */
  isLoadingSelectedMonth?: boolean;
  initialProviderFilterId?: string;
  initialSearch?: string;
  /** Decisão AINDA ABERTA do harness (task 6) — nunca hardcoded aqui. */
  sinCheckinHoursMode?: SinCheckinHoursMode;
  /** Botão "Sincronizar" (F6.4) — ausente quando o serviço injetado não implementa `triggerSync` (o botão some, nunca fica morto). */
  sync?: UseAnaCareHoursSyncResult;
}

export function AnaCareHoursListPage({
  snapshot,
  onOpenPatient,
  onMonthChange,
  selectedMonth,
  isLoadingSelectedMonth = false,
  initialProviderFilterId = '',
  initialSearch = '',
  sinCheckinHoursMode = 'zero',
  sync,
}: AnaCareHoursListPageProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState(initialSearch);
  const [providerFilterId, setProviderFilterId] = useState(initialProviderFilterId);
  const displayedMonth = selectedMonth ?? snapshot.month;
  const monthOptions = useMemo(
    () => monthOptionsUntilNow().map((value) => ({ value, label: formatMonthLabel(value, i18n.language) })),
    [i18n.language],
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

  // F2 (migration 457): 2 estados novos (`parcial`/`desconhecido`) somam ao banner — nenhum dos
  // dois altera `stale` (mantido compat: `nao_construido || velho`, ver `types.ts`), então o
  // gatilho de EXIBIÇÃO precisa checar `snapshotState` além de `stale`/`circuitBreakerOpen`
  // (`shouldShowStatusBanner`, único dono da decisão — `selectors.ts`).
  const showStatusBanner = shouldShowStatusBanner(snapshot);
  const bannerKind = statusBannerKind(snapshot);
  const temContagemDaCorrida = snapshot.reservationsTotal != null && snapshot.reservationsDone != null;

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
          <div className="flex items-end gap-3">
            <div className="w-48">
              <Select
                inputSize="compact"
                options={monthOptions}
                value={displayedMonth}
                onValueChange={(v) => onMonthChange?.(v)}
                aria-label={t('admin.anacareHours.monthAriaLabel')}
              />
            </div>
            {sync && (
              <AnaCareHoursSyncButton
                status={sync.status}
                round={sync.round}
                reservationsProcessed={sync.reservationsProcessed}
                reservationsTotal={sync.reservationsTotal}
                reservationsDone={sync.reservationsDone}
                error={sync.error}
                resumableCursor={sync.resumableCursor}
                interruptedMonth={sync.interruptedMonth}
                onStart={sync.start}
              />
            )}
          </div>
        </div>

        {showStatusBanner && (
          <AlertBanner
            variant="warning"
            title={
              // Item 3 (revisão de PR) + F2: cada estado tem título PRÓPRIO — nunca afirmar uma
              // sincronização que nunca aconteceu (`nao_construido`), nem "sabemos que está
              // incompleto" quando na verdade não sabemos nada (`desconhecido`).
              bannerKind === 'naoConstruido'
                ? t('admin.anacareHours.stale.titleNaoConstruido')
                : bannerKind === 'desconhecido'
                  ? t('admin.anacareHours.stale.titleDesconhecido')
                  : bannerKind === 'parcial'
                    ? t('admin.anacareHours.stale.titleParcial')
                    : t('admin.anacareHours.stale.title')
            }
            message={
              bannerKind === 'naoConstruido'
                ? t('admin.anacareHours.stale.messageNaoConstruido')
                : bannerKind === 'desconhecido'
                  ? t('admin.anacareHours.stale.messageDesconhecido')
                  : bannerKind === 'parcial'
                    ? temContagemDaCorrida
                      ? t('admin.anacareHours.stale.messageParcialComContagem', {
                          done: snapshot.reservationsDone,
                          total: snapshot.reservationsTotal,
                        })
                      : t('admin.anacareHours.stale.messageParcial')
                    : bannerKind === 'circuitBreaker'
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
            {isLoadingSelectedMonth ? (
              // `snapshot` ainda é do mês ANTERIOR (fetch do `displayedMonth` em voo) — mostrar
              // essas linhas aqui seria dado de agosto sob rótulo de setembro. Zera em vez de
              // mentir (ver comentário de `selectedMonth`/`isLoadingSelectedMonth` acima).
              <TableRow clickable={false} data-testid="anacare-hours-list-loading-month">
                <TableCell unwrapped colSpan={6}>
                  <div className="py-10 text-center">
                    <Text color="muted">{t('admin.anacareHours.list.loading')}</Text>
                  </div>
                </TableCell>
              </TableRow>
            ) : filteredPatients.length === 0 ? (
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
  patient: AnaCareListPatient;
  onOpen: (id: string) => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}): JSX.Element {
  const { t } = useTranslation();
  // F6.3: os agregados vêm PRONTOS do backend (`anacare_patient_month`) — nunca mais recalculados
  // percorrendo `patient.providers[].shifts[]` (o array de turnos nem existe mais aqui). Modo
  // `'zero'` = `hoursActualSum` sozinho; modo `'scheduled'` soma `hoursScheduledSumMissingActual`
  // (nunca isolado, nunca somado duas vezes — ver `types.ts` `AnaCareListPatient`).
  const hours = sinCheckinHoursMode === 'scheduled' ? patient.hoursActualSum + patient.hoursScheduledSumMissingActual : patient.hoursActualSum;
  const total = patient.shiftsCount;
  const percentage = total === 0 ? 0 : Math.round((patient.validated / total) * 100);

  return (
    <TableRow onClick={() => onOpen(patient.anaCareId)} data-testid={`anacare-hours-patient-row-${patient.anaCareId}`}>
      <TableCell weight="medium">{patientDisplayName(patient)}</TableCell>
      <TableCell align="center">{patient.providersCount}</TableCell>
      <TableCell align="center">{patient.shiftsCount}</TableCell>
      <TableCell align="right">{hours.toFixed(1)} h</TableCell>
      <TableCell unwrapped>
        <div className="flex flex-col gap-1 min-w-[140px]">
          <ProgressBar percentage={percentage} height="sm" className="w-24" />
          <Text as="span" size="xs" color="muted" className="whitespace-nowrap">
            {t('admin.anacareHours.list.validationSummary', { count: patient.validated, total })}
            {patient.contested > 0 ? t('admin.anacareHours.list.validationSummaryContestedSuffix', { count: patient.contested }) : ''}
          </Text>
        </div>
      </TableCell>
      <TableCell unwrapped>
        <div className="flex flex-wrap items-center gap-1.5">
          {patient.originSinCheckin > 0 && (
            <MiniOriginCount label={t('admin.anacareHours.origin.sinCheckin')} count={patient.originSinCheckin} origin="sin_checkin" />
          )}
          {patient.originWebAdmin > 0 && (
            <MiniOriginCount label={t('admin.anacareHours.origin.webAdmin')} count={patient.originWebAdmin} origin="web_admin" />
          )}
          {patient.originApp > 0 && <MiniOriginCount label={t('admin.anacareHours.origin.app')} count={patient.originApp} origin="app" />}
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
