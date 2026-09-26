/**
 * Detalhe do paciente — conferência de horas do Ana Care (V1). Resumo no topo + grupos por DIA
 * (ver `DayGroup`) — o eixo deixou de ser o PRESTADOR (decisão do Gabriel, 16/09: agrupar por
 * prestador põe o prestador no centro, e pra saber o que aconteceu com o paciente num dia era
 * preciso varrer todos os prestadores). Navegação semana a semana roda EM MEMÓRIA — o mês inteiro
 * já veio numa chamada só (`useAnaCareHoursPatient`), nenhum clique de navegação busca de novo; só
 * o botão "Actualizar" refaz a chamada (via `onRefresh`, ligado pelo `AnaCareHoursDetailContainer`
 * ao `refetch` do hook).
 *
 * Adaptado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHoursDetailPage.tsx`:
 *  - `blockReasonMode` passa a nascer `'corto'` (1.5a, D344) — antes era `'largo'`. O banner
 *    grande do topo continua SEMPRE com o texto longo (`blockReason(snapshot, 'largo')`,
 *    hardcoded, comportamento intocado — só o motivo POR DIA mudou de padrão).
 *  - `onContestShift` ganha o parâmetro `reason` (1.5b) — assinatura antes era `(shildId, note)`.
 *  - card do resumo do mês (ajuste 16/09, ainda aberto na época): rotulado explicitamente
 *    "Horas totales del mes" — a tabela abaixo mostra a SEMANA, e antes o rótulo não distinguia
 *    os dois; agora que o mês vem inteiro numa chamada, o agregado do mês é correto e barato,
 *    então resolvemos por RÓTULO, sem mudar o número nem o layout.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Calendar, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { AlertBanner } from '@presentation/components/organisms/Alert/AlertBanner';
import { OriginLegend } from './OriginLegend';
import { DayGroup } from './DayGroup';
import { ValidateBatchModal } from './ValidateBatchModal';
import { ContestModal } from './ContestModal';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';
import type { AnaCareHoursPatientSnapshot, AnaCareShift, ContestReason } from './types';
import {
  addDaysIso,
  allShiftsOf,
  blockReason,
  groupShiftsByDayInWeek,
  originCounts,
  patientDisplayName,
  pendingSelectionStateOf,
  selectionSummary,
  shouldShowStatusBanner,
  startOfWeekMonday,
  statusBannerKind,
  todayIsoLocal,
  totalHours,
  validationProgress,
  type BlockReasonMode,
  type SinCheckinHoursMode,
} from './selectors';

interface AnaCareHoursDetailPageProps {
  snapshot: AnaCareHoursPatientSnapshot;
  patientId: string;
  onBack: () => void;
  /** Serviço do envio ao Axonico (botão "Enviar" de cada dia) — injetado de cima, mesmo padrão de `service`. */
  axonicoService: AxonicoComprobanteService;
  /** Serviço do registro de documento do paciente (modal aberto quando falta DNI, 19/09) — injetado de cima, mesmo padrão de `axonicoService`. */
  patientDocumentService: AnaCarePatientDocumentService;
  initialContestShiftId?: string | null;
  /** Hooks de escrita — quando ausentes, o clique só fecha o modal, sem persistir nada. `AnaCareHoursDetailContainer` é quem passa os callbacks de verdade. */
  onValidateShift?: (shift: AnaCareShift) => void | Promise<void>;
  onValidateBatch?: (shiftIds: string[]) => void | Promise<void>;
  onContestShift?: (shiftId: string, reason: ContestReason, note: string) => void | Promise<void>;
  /** "Actualizar" — refaz a ÚNICA chamada do mês (D-16/09: refresh por paciente). Ausente = botão some (harness/print estático). */
  onRefresh?: () => void;
  /**
   * change `anacare-horas-feedback-visual-sync` (Requisito 4) — `true` enquanto a busca disparada
   * por `onRefresh` (ou qualquer outra que reuse o MESMO `isLoading` do hook) está em voo, mesmo
   * já havendo `snapshot` na tela. Controla SÓ o spinner/disabled deste botão — nunca a tela de
   * loading de página inteira da 1ª carga (`AnaCareHoursDetailContainer.tsx`, condição
   * `isLoading && !snapshot`, intocada). Default `false` (harness/print estático sem o container).
   */
  isRefreshing?: boolean;
  sinCheckinHoursMode?: SinCheckinHoursMode;
  /** 1.5a (D344): o motivo de bloqueio POR DIA nasce curto — o banner do topo é sempre longo, intocado por esta prop. */
  blockReasonMode?: BlockReasonMode;
  /** Célula `anacare_hours:validate` ausente (D344) — desabilita as MESMAS ações que o retrato desatualizado desabilita, com motivo visível (nunca botão morto em silêncio). */
  disableActionsReason?: string;
}

export function AnaCareHoursDetailPage({
  snapshot,
  patientId,
  onBack,
  axonicoService,
  patientDocumentService,
  initialContestShiftId = null,
  onValidateShift,
  onValidateBatch,
  onContestShift,
  onRefresh,
  isRefreshing = false,
  sinCheckinHoursMode = 'zero',
  blockReasonMode = 'corto',
  disableActionsReason,
}: AnaCareHoursDetailPageProps): JSX.Element {
  const { t } = useTranslation();
  const patient = snapshot.patients.find((p) => p.anaCareId === patientId);
  const [contestShiftId, setContestShiftId] = useState<string | null>(initialContestShiftId);
  const [selectedShiftIds, setSelectedShiftIds] = useState<Set<string>>(new Set());
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  // change `anacare-horas-validando-prd` (26/09): feedback visual — nada indicava que a validação
  // (turno único ou lote) estava em voo, e a operadora podia achar que a tela travou. `validatingShiftIds`
  // guarda os ids com `onValidateShift` pendente (repassado ao `DayGroup`/`ShiftRow`, que troca o
  // rótulo do botão pra "Validando…"); `isValidatingBatch` faz o mesmo pro "Confirmar" do
  // `ValidateBatchModal`, que agora só fecha/limpa a seleção DEPOIS que a promise assenta.
  const [validatingShiftIds, setValidatingShiftIds] = useState<Set<string>>(new Set());
  const [isValidatingBatch, setIsValidatingBatch] = useState(false);

  const shifts = useMemo(() => (patient ? allShiftsOf(patient) : []), [patient]);
  const progress = useMemo(() => validationProgress(shifts), [shifts]);
  const origins = useMemo(() => originCounts(shifts), [shifts]);
  const hours = useMemo(() => totalHours(shifts, sinCheckinHoursMode), [shifts, sinCheckinHoursMode]);
  const selectedShifts = useMemo(() => shifts.filter((s) => selectedShiftIds.has(s.id)), [shifts, selectedShiftIds]);
  const selectionStats = useMemo(() => selectionSummary(selectedShifts, sinCheckinHoursMode), [selectedShifts, sinCheckinHoursMode]);
  const isSelectionBarVisible = selectionStats.count > 0;

  // Navegação semana a semana (decisão do Gabriel, 18/09) — abre na semana de HOJE se o mês
  // exibido (`snapshot.month`, YYYY-MM) contém a data de hoje; senão abre na primeira semana do
  // mês exibido. NUNCA busca de novo: o mês inteiro já está em `snapshot` (uma chamada só, ver
  // `useAnaCareHoursPatient`), então trocar de semana só filtra em memória via `groupShiftsByDayInWeek`.
  const todayIso = todayIsoLocal();
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const effectiveWeekStart =
    weekStart ?? startOfWeekMonday(snapshot.month === todayIso.slice(0, 7) ? todayIso : `${snapshot.month}-01`);
  const weekEnd = addDaysIso(effectiveWeekStart, 6);
  const dayGroups = useMemo(() => (patient ? groupShiftsByDayInWeek(patient, effectiveWeekStart) : []), [patient, effectiveWeekStart]);

  const selectionBarRef = useRef<HTMLDivElement>(null);
  const [selectionBarHeight, setSelectionBarHeight] = useState(0);

  useLayoutEffect(() => {
    if (!isSelectionBarVisible) {
      setSelectionBarHeight(0);
      return;
    }
    // Conserto de conformidade (cobertura, 15/09): `el` SEMPRE existe aqui — a div com este ref só
    // é renderizada no MESMO ramo booleano (`isSelectionBarVisible && <div ref={selectionBarRef}>`
    // mais abaixo), e `selectedShiftIds` nasce `new Set()` (mount sempre com a barra invisível), então
    // não há como este efeito rodar com `isSelectionBarVisible=true` antes do commit da div. O
    // antigo `if (!el) return;` era ramo morto (nenhum teste real o alcança) — removido em vez de
    // marcado `v8 ignore`, mesmo padrão do comentário D5 em `ShiftRows`.
    const el = selectionBarRef.current!;
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
  // não afetado por `blockReasonMode`. Só o motivo curto dentro de cada `DayGroup` obedece.
  // Item 3 (conserto, 17/09) + F2 (migration 457): cada estado (`nao_construido`/`desconhecido`/
  // `parcial`) tem título e mensagem PRÓPRIOS — antes, `blockReason` colapsava em "retrato com
  // mais de 24 horas", falso quando o sync nunca rodou. `statusBannerKind`/`shouldShowStatusBanner`
  // (`selectors.ts`) são o MESMO dono que `AnaCareHoursListPage` usa — nenhuma lógica duplicada.
  // 🔴 `parcial`/`desconhecido` são SÓ informativos (proposal.md §Não-objetivos) — NÃO entram em
  // `staleDisable`/`disableActions`/`dayBlockReason` abaixo, que continuam intocados.
  const showStatusBanner = shouldShowStatusBanner(snapshot);
  const bannerKind = statusBannerKind(snapshot);
  const temContagemDaCorrida = snapshot.reservationsTotal != null && snapshot.reservationsDone != null;
  const alertTitle =
    bannerKind === 'naoConstruido'
      ? t('admin.anacareHours.stale.titleNaoConstruido')
      : bannerKind === 'desconhecido'
        ? t('admin.anacareHours.stale.titleDesconhecido')
        : bannerKind === 'parcial'
          ? t('admin.anacareHours.stale.titleParcial')
          : t('admin.anacareHours.stale.title');
  const alertMessage =
    bannerKind === 'naoConstruido'
      ? t('admin.anacareHours.stale.messageNaoConstruido')
      : bannerKind === 'desconhecido'
        ? t('admin.anacareHours.stale.messageDesconhecido')
        : bannerKind === 'parcial'
          ? temContagemDaCorrida
            ? t('admin.anacareHours.stale.messageParcialComContagem', { done: snapshot.reservationsDone, total: snapshot.reservationsTotal })
            : t('admin.anacareHours.stale.messageParcial')
          : blockReason(snapshot, 'largo');
  // Retrato desatualizado tem prioridade de mensagem sobre a célula ausente — os dois desabilitam,
  // mas o motivo mostrado no `DayGroup` é sempre um só por vez.
  const dayBlockReason = staleDisable ? blockReason(snapshot, blockReasonMode) : disableActionsReason;

  const contestShift = shifts.find((s) => s.id === contestShiftId) ?? null;

  async function handleValidateShift(shift: AnaCareShift): Promise<void> {
    setValidatingShiftIds((prev) => new Set(prev).add(shift.id));
    try {
      await onValidateShift?.(shift);
    } catch {
      // O erro de verdade já é tratado por quem chama (`AnaCareHoursDetailContainer
      // .handleValidateShift`, que nunca rejeita — só chega aqui num teste unitário com mock cru
      // passando `onValidateShift` direto). Sem re-throw: este wrapper só cuida do rótulo
      // "Validando…", nunca da mensagem de erro.
    } finally {
      setValidatingShiftIds((prev) => {
        const next = new Set(prev);
        next.delete(shift.id);
        return next;
      });
    }
  }

  function toggleShift(shiftId: string): void {
    setSelectedShiftIds((prev) => {
      const next = new Set(prev);
      if (next.has(shiftId)) next.delete(shiftId);
      else next.add(shiftId);
      return next;
    });
  }

  /** Checkbox de cabeçalho do DIA — marca/desmarca TODOS os pendentes DESTE DIA (nunca contestados, regra travada). */
  function toggleDayPending(dayShifts: AnaCareShift[]): void {
    const pending = dayShifts.filter((s) => s.status === 'pendiente');
    const state = pendingSelectionStateOf(dayShifts, selectedShiftIds);
    const pendingIds = pending.map((s) => s.id);
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

  async function handleConfirmBatch(): Promise<void> {
    setIsValidatingBatch(true);
    try {
      await onValidateBatch?.(Array.from(selectedShiftIds));
    } catch {
      // Idem `handleValidateShift`: o container já trata o erro de verdade — catch aqui é só rede
      // de segurança pro estado visual em teste unitário com mock cru.
    } finally {
      setIsValidatingBatch(false);
      setSelectedShiftIds(new Set());
      setIsBatchModalOpen(false);
    }
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
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack} data-testid="anacare-hours-back">
              <span className="inline-flex items-center gap-1.5">
                <ArrowLeft className="w-4 h-4" />
                {t('admin.anacareHours.detail.back')}
              </span>
            </Button>
            <Heading level={1}>{patientDisplayName(patient)}</Heading>
          </div>
          {onRefresh && (
            // Requisito 4: `isLoading={false}` de propósito (mesmo padrão do botão de sync,
            // decisão de design #2/#4) — `disabled={isRefreshing}` já bloqueia o clique durante a
            // busca, sem deixar `Button.tsx` trocar o `children` inteiro por "Cargando…" (o rótulo
            // "Actualizar" continua visível; só o ícone gira).
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              isLoading={false}
              disabled={isRefreshing}
              data-testid="anacare-hours-refresh"
            >
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw
                  data-testid="anacare-hours-refresh-spinner"
                  data-spinning={isRefreshing}
                  className={isRefreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'}
                />
                {t('admin.anacareHours.detail.refreshAction')}
              </span>
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Text size="sm" color="muted" data-testid="anacare-hours-week-label">
            {t('admin.anacareHours.detail.weekLabel', { start: formatWeekRangeDate(effectiveWeekStart), end: formatWeekRangeDate(weekEnd) })}
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDaysIso(effectiveWeekStart, -7))} data-testid="anacare-hours-week-prev">
              <span className="inline-flex items-center gap-1">
                <ChevronLeft className="w-4 h-4" />
                {t('admin.anacareHours.detail.weekPrev')}
              </span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDaysIso(effectiveWeekStart, 7))} data-testid="anacare-hours-week-next">
              <span className="inline-flex items-center gap-1">
                {t('admin.anacareHours.detail.weekNext')}
                <ChevronRight className="w-4 h-4" />
              </span>
            </Button>
            <Input
              type="date"
              inputSize="compact"
              className="!w-auto"
              leftIcon={<Calendar className="w-4 h-4 text-gray-600" />}
              value={effectiveWeekStart}
              onChange={(e) => {
                if (e.target.value) setWeekStart(startOfWeekMonday(e.target.value));
              }}
              aria-label={t('admin.anacareHours.detail.weekPickerAriaLabel')}
              data-testid="anacare-hours-week-datepicker"
            />
          </div>
        </div>

        {/* D5 (cobertura, 15/09) + F2: `alertMessage` NUNCA é undefined aqui — os 3 ramos novos
            (`naoConstruido`/`desconhecido`/`parcial`) sempre traduzem uma chave própria, e o ramo
            que ainda cai em `blockReason` só é alcançado quando `showStatusBanner` já garantiu
            `stale || circuitBreakerOpen`. O `?? ''` de antes era branch morto — removido em vez de
            marcado como ignorado. */}
        {showStatusBanner && <AlertBanner variant="warning" title={alertTitle} message={alertMessage as string} />}

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
          {dayGroups.length === 0 && (
            <Text color="muted" data-testid="anacare-hours-week-empty">
              {t('admin.anacareHours.detail.weekEmpty')}
            </Text>
          )}
          {dayGroups.map((day) => (
            <DayGroup
              key={day.date}
              day={day}
              disableActions={disableActions}
              disableReason={dayBlockReason}
              onValidateShift={handleValidateShift}
              onOpenContestModal={(s) => setContestShiftId(s.id)}
              selectedShiftIds={selectedShiftIds}
              onToggleShift={toggleShift}
              validatingShiftIds={validatingShiftIds}
              onToggleDayPending={toggleDayPending}
              sinCheckinHoursMode={sinCheckinHoursMode}
              axonicoService={axonicoService}
              patientDocumentService={patientDocumentService}
              anaCarePatientId={patient.anaCareId}
              patientDocumentNumber={patient.documentNumber}
              patientDocumentType={patient.documentType}
              onDocumentRegistered={onRefresh}
              onSent={onRefresh}
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
          isValidating={isValidatingBatch}
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

/** "1 de septiembre" — es-AR, usado no rótulo "semana de X a Y". */
function formatWeekRangeDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
}
