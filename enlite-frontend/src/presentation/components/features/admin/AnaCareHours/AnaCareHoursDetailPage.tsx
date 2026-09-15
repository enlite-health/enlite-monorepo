/**
 * Detalhe do paciente — conferência de horas do Ana Care (V1). Resumo no topo + grupos por
 * prestador (ver `ProviderGroup`). Adaptado de `repos/infra/_worktrees/proto-anacare-horas/.../
 * AnaCareHoursDetailPage.tsx`:
 *  - `blockReasonMode` passa a nascer `'corto'` (1.5a, D344) — antes era `'largo'`. O banner
 *    grande do topo continua SEMPRE com o texto longo (`blockReason(snapshot, 'largo')`,
 *    hardcoded, comportamento intocado — só o motivo POR PRESTADOR mudou de padrão).
 *  - `onContestShift` ganha o parâmetro `reason` (1.5b) — assinatura antes era `(shiftId, note)`.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { AlertBanner } from '@presentation/components/organisms/Alert/AlertBanner';
import { OriginLegend } from './OriginLegend';
import { ProviderGroup } from './ProviderGroup';
import { ValidateBatchModal } from './ValidateBatchModal';
import { ContestModal } from './ContestModal';
import type { AnaCareMonthSnapshot, AnaCareProvider, AnaCareShift, ContestReason } from './types';
import {
  allShiftsOf,
  blockReason,
  originCounts,
  patientDisplayName,
  pendingShiftsOf,
  providerPendingSelectionState,
  selectionSummary,
  totalHours,
  validationProgress,
  type BlockReasonMode,
  type SinCheckinHoursMode,
} from './selectors';

interface AnaCareHoursDetailPageProps {
  snapshot: AnaCareMonthSnapshot;
  patientId: string;
  onBack: () => void;
  initialContestShiftId?: string | null;
  /** Hooks de escrita — quando ausentes, o clique só fecha o modal, sem persistir nada. `AnaCareHoursDetailContainer` é quem passa os callbacks de verdade. */
  onValidateShift?: (shift: AnaCareShift) => void | Promise<void>;
  onValidateBatch?: (shiftIds: string[]) => void | Promise<void>;
  onContestShift?: (shiftId: string, reason: ContestReason, note: string) => void | Promise<void>;
  sinCheckinHoursMode?: SinCheckinHoursMode;
  /** 1.5a (D344): o motivo de bloqueio POR PRESTADOR nasce curto — o banner do topo é sempre longo, intocado por esta prop. */
  blockReasonMode?: BlockReasonMode;
  /** Célula `anacare_hours:validate` ausente (D344) — desabilita as MESMAS ações que o retrato desatualizado desabilita, com motivo visível (nunca botão morto em silêncio). */
  disableActionsReason?: string;
}

export function AnaCareHoursDetailPage({
  snapshot,
  patientId,
  onBack,
  initialContestShiftId = null,
  onValidateShift,
  onValidateBatch,
  onContestShift,
  sinCheckinHoursMode = 'zero',
  blockReasonMode = 'corto',
  disableActionsReason,
}: AnaCareHoursDetailPageProps): JSX.Element {
  const { t } = useTranslation();
  const patient = snapshot.patients.find((p) => p.anaCareId === patientId);
  const [contestShiftId, setContestShiftId] = useState<string | null>(initialContestShiftId);
  const [selectedShiftIds, setSelectedShiftIds] = useState<Set<string>>(new Set());
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);

  const shifts = useMemo(() => (patient ? allShiftsOf(patient) : []), [patient]);
  const progress = useMemo(() => validationProgress(shifts), [shifts]);
  const origins = useMemo(() => originCounts(shifts), [shifts]);
  const hours = useMemo(() => totalHours(shifts, sinCheckinHoursMode), [shifts, sinCheckinHoursMode]);
  const selectedShifts = useMemo(() => shifts.filter((s) => selectedShiftIds.has(s.id)), [shifts, selectedShiftIds]);
  const selectionStats = useMemo(() => selectionSummary(selectedShifts, sinCheckinHoursMode), [selectedShifts, sinCheckinHoursMode]);
  const isSelectionBarVisible = selectionStats.count > 0;

  const selectionBarRef = useRef<HTMLDivElement>(null);
  const [selectionBarHeight, setSelectionBarHeight] = useState(0);

  useLayoutEffect(() => {
    if (!isSelectionBarVisible) {
      setSelectionBarHeight(0);
      return;
    }
    const el = selectionBarRef.current;
    if (!el) return;
    const measure = (): void => setSelectionBarHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isSelectionBarVisible]);

  if (!patient) {
    return (
      <PageContainer>
        <Text color="muted">{t('admin.anacareHours.detail.patientNotFound', { month: snapshot.month })}</Text>
      </PageContainer>
    );
  }

  const staleDisable = snapshot.stale || snapshot.circuitBreakerOpen;
  const disableActions = staleDisable || Boolean(disableActionsReason);
  // O banner grande (AlertBanner) mantém sempre o texto LARGO — comportamento aprovado (D342),
  // não afetado por `blockReasonMode`. Só o motivo curto dentro de cada `ProviderGroup` obedece.
  const alertMessage = blockReason(snapshot, 'largo');
  // Retrato desatualizado tem prioridade de mensagem sobre a célula ausente — os dois desabilitam,
  // mas o motivo mostrado no `ProviderGroup` é sempre um só por vez.
  const providerBlockReason = staleDisable ? blockReason(snapshot, blockReasonMode) : disableActionsReason;

  const contestShift = shifts.find((s) => s.id === contestShiftId) ?? null;

  function handleValidateShift(shift: AnaCareShift): void {
    void onValidateShift?.(shift);
  }

  function toggleShift(shiftId: string): void {
    setSelectedShiftIds((prev) => {
      const next = new Set(prev);
      if (next.has(shiftId)) next.delete(shiftId);
      else next.add(shiftId);
      return next;
    });
  }

  function toggleProviderPending(provider: AnaCareProvider): void {
    const pendingIds = pendingShiftsOf(provider).map((s) => s.id);
    const state = providerPendingSelectionState(provider, selectedShiftIds);
    setSelectedShiftIds((prev) => {
      const next = new Set(prev);
      if (state === 'all') {
        pendingIds.forEach((id) => next.delete(id));
      } else {
        pendingIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function handleConfirmBatch(): void {
    void onValidateBatch?.(Array.from(selectedShiftIds));
    setSelectedShiftIds(new Set());
    setIsBatchModalOpen(false);
  }

  function handleConfirmContest(reason: ContestReason, note: string): void {
    if (contestShiftId) {
      void onContestShift?.(contestShiftId, reason, note);
    }
    setContestShiftId(null);
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6" style={isSelectionBarVisible ? { paddingBottom: selectionBarHeight } : undefined}>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} data-testid="anacare-hours-back">
            <span className="inline-flex items-center gap-1.5">
              <ArrowLeft className="w-4 h-4" />
              {t('admin.anacareHours.detail.back')}
            </span>
          </Button>
          <Heading level={1}>{patientDisplayName(patient)}</Heading>
        </div>

        {/* D5 (cobertura, 15/09): `alertMessage` NUNCA é undefined aqui — `blockReason` só devolve
            undefined quando `!stale && !circuitBreakerOpen`, e `staleDisable` já garante o contrário
            pra este ramo renderizar. O `?? ''` de antes era branch morto (nunca exercitável por
            nenhum snapshot real) — removido em vez de marcado como ignorado. */}
        {staleDisable && <AlertBanner variant="warning" title={t('admin.anacareHours.stale.title')} message={alertMessage as string} />}

        <div className="border border-gray-600 rounded-xl p-5 flex flex-wrap items-center justify-between gap-6">
          <div>
            <Text size="xs" color="muted">
              {t('admin.anacareHours.detail.totalHoursLabel')}
            </Text>
            <Heading level={2}>{hours.toFixed(1)} h</Heading>
          </div>
          <div className="flex-1 min-w-[220px]">
            <Text size="xs" color="muted">
              {t('admin.anacareHours.detail.validationLabel', { validated: progress.validated, total: progress.total })}
              {progress.contested > 0 ? t('admin.anacareHours.detail.validationContestedSuffix', { count: progress.contested }) : ''}
            </Text>
            <ProgressBar percentage={progress.percentage} height="md" />
          </div>
          <div className="flex items-center gap-2">
            {origins.sinCheckin > 0 && <OriginCountPill label={t('admin.anacareHours.origin.sinCheckin')} count={origins.sinCheckin} tone="red" />}
            {origins.webAdmin > 0 && <OriginCountPill label={t('admin.anacareHours.origin.webAdmin')} count={origins.webAdmin} tone="amber" />}
            {origins.app > 0 && <OriginCountPill label={t('admin.anacareHours.origin.app')} count={origins.app} tone="green" />}
            <OriginLegend testIdPrefix="anacare-hours-origin-legend-detail" />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {patient.providers.map((provider) => (
            <ProviderGroup
              key={provider.anaCareId}
              provider={provider}
              disableActions={disableActions}
              disableReason={providerBlockReason}
              onValidateShift={handleValidateShift}
              onOpenContestModal={(s) => setContestShiftId(s.id)}
              selectedShiftIds={selectedShiftIds}
              onToggleShift={toggleShift}
              onToggleProviderPending={toggleProviderPending}
              highlightNoCheckIn
              sinCheckinHoursMode={sinCheckinHoursMode}
            />
          ))}
        </div>
      </div>

      {isSelectionBarVisible && (
        <div
          ref={selectionBarRef}
          className="fixed inset-x-0 bottom-0 z-40 bg-white border-t border-gray-600 shadow-lg px-6 py-3 flex flex-wrap items-center justify-between gap-3"
          data-testid="anacare-hours-selection-bar"
        >
          <Text size="sm" weight="medium">
            {t('admin.anacareHours.selectionBar.summary', {
              count: selectionStats.count,
              hours: selectionStats.hours.toFixed(1),
              sinCheckin: selectionStats.sinCheckinCount,
            })}
          </Text>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={disableActions}
              onClick={() => setSelectedShiftIds(new Set())}
              data-testid="anacare-hours-selection-clear"
            >
              {t('admin.anacareHours.selectionBar.clear')}
            </Button>
            <Button size="sm" disabled={disableActions} onClick={() => setIsBatchModalOpen(true)} data-testid="anacare-hours-selection-validate">
              {t('admin.anacareHours.selectionBar.validate')}
            </Button>
          </div>
        </div>
      )}

      {isBatchModalOpen && (
        <ValidateBatchModal
          shifts={selectedShifts}
          sinCheckinHoursMode={sinCheckinHoursMode}
          onConfirm={handleConfirmBatch}
          onCancel={() => setIsBatchModalOpen(false)}
        />
      )}

      {contestShift && (
        <ContestModal
          shiftDate={contestShift.date.split('-').reverse().slice(0, 2).join('/')}
          onConfirm={handleConfirmContest}
          onCancel={() => setContestShiftId(null)}
        />
      )}
    </PageContainer>
  );
}

function OriginCountPill({ label, count, tone }: { label: string; count: number; tone: 'red' | 'amber' | 'green' }): JSX.Element {
  const classes = tone === 'red' ? 'bg-red-100 text-red-700' : tone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700';
  return (
    <div className={`flex flex-col items-center px-3 py-1.5 rounded-lg ${classes}`}>
      <Text as="span" size="sm" weight="semibold" color="inherit">
        {count}
      </Text>
      <Text as="span" size="xs" color="inherit">
        {label}
      </Text>
    </div>
  );
}
