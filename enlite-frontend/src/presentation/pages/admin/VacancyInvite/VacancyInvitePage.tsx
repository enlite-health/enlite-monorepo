import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Badge } from '@presentation/components/atoms/Badge';
import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import { useVacancyInviteBoard } from '@hooks/admin/useVacancyInviteBoard';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import { COUNTRY_TIME_ZONE } from '@presentation/utils/countryTimeZone';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import { InviteListSkeleton, InviteMapLoading } from './InviteLoadingState';
import { InviteMapPane } from './InviteMapPane';
import { InviteListHeader } from './InviteListHeader';
import { InviteListFooter } from './InviteListFooter';
import { InviteRow } from './InviteRow';
import {
  applyDocOnly,
  buildBoardView,
  openingStep,
  parseStep,
  setAllSelected,
  toggleOne,
  type BoardContext,
  type StepId,
} from './inviteBoardModel';

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Altura do mapa = viewport − barra de 72 px do cabeçalho. */
function useMapHeight(): number {
  const [h, setH] = useState(() => Math.max(480, window.innerHeight - 72));
  useEffect(() => {
    const onResize = () => setH(Math.max(480, window.innerHeight - 72));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}

/** DF-18 b: recarregar/fechar a aba interrompe a fila — aviso nativo SÓ enquanto envia. */
function useBeforeUnloadWhileSending(): void {
  const isSending = useInviteProgressStore((s) => s.isSending);
  useEffect(() => {
    if (!isSending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isSending]);
}

export default function VacancyInvitePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const mapHeight = useMapHeight();
  useBeforeUnloadWhileSending();

  const canRead = useActionGate('match', 'read').allowed;
  const canExecute = useActionGate('match', 'execute').allowed;
  // ⚑2: sem `match:read` não há dado para mostrar → "Sin permiso", e NENHUMA request (nem a da vacante).
  const noPermission = !canRead;
  const { vacancy, error: vacancyError } = useVacancyDetail(noPermission ? undefined : id);
  const isDeBaja = vacancy?.status === 'DE_BAJA';
  const isDraft = vacancy?.is_draft === true;

  const board = useVacancyInviteBoard(id, {
    enabled: !!vacancy && !isDraft && !isDeBaja && !noPermission,
    canExecute: canExecute && !isDeBaja,
  });
  const { results, currentIds } = board;

  // Docs/seleção/envios: estado de tela (a regra mora no modelo, `inviteBoardModel`).
  const [docOnly, setDocOnly] = useState(false);
  const [unselected, setUnselected] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [dialog, setDialog] = useState<'confirm' | 'finish' | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);

  const timeZone = vacancy?.country ? COUNTRY_TIME_ZONE[vacancy.country as string] : undefined;
  const ctx: BoardContext | null = useMemo(
    () =>
      results
        ? {
            candidates: results.candidates,
            currentIds,
            docOnly,
            unselected,
            operationDate: results.operationDate,
            timeZone,
            emphasizedId: hoveredId ?? selectedPin,
          }
        : null,
    [results, currentIds, docOnly, unselected, timeZone, hoveredId, selectedPin],
  );

  // Passo de abertura decidido UMA vez (DF-14): depois, só a URL (`?paso=`) o muda.
  const opening = useRef<StepId | null>(null);
  if (ctx && board.status === 'ready' && opening.current == null) opening.current = openingStep(ctx, null);
  const step: StepId | null = parseStep(searchParams.get('paso')) ?? opening.current;

  useEffect(() => {
    if (board.status !== 'ready' || !step || parseStep(searchParams.get('paso')) === step) return;
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('paso', String(step)); return n; }, { replace: true, state: location.state });
  }, [board.status, step, searchParams, setSearchParams, location.state]);

  const goBack = (): void => {
    const from = (location.state as { from?: string } | null)?.from;
    if (from) navigate(-1);
    else navigate(`/admin/vacancies/${id}?tab=encuadres`, { replace: true });
  };

  const selectStep = (next: StepId): void => {
    setSelectedPin(null);
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('paso', String(next)); return n; }, { replace: true, state: location.state });
  };

  // RF-11: clique no PINO rola e foca a linha (o clique no NOME alterna o foco do pino).
  const onPinSelect = (workerId: string | null): void => setSelectedPin(workerId);
  useEffect(() => {
    if (!selectedPin) return;
    const row = document.getElementById(`invite-row-${selectedPin}`);
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.querySelector<HTMLElement>('button')?.focus();
  }, [selectedPin]);

  if (!noPermission && isDraft) return <Navigate to={`/admin/vacancies/${id}/borrador`} replace />;

  const address: string | null = vacancy?.patient_address_formatted ?? vacancy?.patient_address_raw ?? null;
  const view = ctx && step && board.status === 'ready' ? buildBoardView(ctx, step) : null;

  const sexLabel = vacancy?.required_sex ? t(`admin.vacancyDetail.vacancyForm.sexOptions.${vacancy.required_sex}`, vacancy.required_sex) : null;
  const profession = vacancy?.required_professions?.[0];
  const professionLabel = profession ? t(`admin.vacancyDetail.vacancyForm.professionOptions.${profession}`, profession) : null;
  const caso = formatCaseNumber(vacancy?.case_number ?? null);
  const nn = vacancy?.vacancy_number != null ? String(vacancy.vacancy_number).padStart(2, '0') : null;

  const header = (
    <header data-testid="invite-header" className="flex h-[72px] items-center gap-4 border-b border-gray-300 bg-white pl-3 pr-6">
      <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-back" onClick={goBack} className="gap-2 !px-3.5">
        <ArrowLeft size={16} aria-hidden="true" />
        {t('admin.vacancyInvite.back')}
      </Button>
      <div className="min-w-0 flex-1">
        <Heading level={3} as="h1" weight="semibold" color="primary" className="truncate !leading-7" data-testid="invite-title">
          {t('admin.vacancyInvite.title')}
        </Heading>
        {caso && nn && (
          <Text size="xs" color="inherit" className="truncate text-primary/70" data-testid="invite-subtitle">
            {t('admin.vacancyInvite.subtitle', { caso, nn, profession: professionLabel ?? '—' })}
          </Text>
        )}
      </div>
      {vacancy && (
        <div className="flex items-center gap-2" data-testid="invite-chips">
          <Text as="span" size="xs" color="inherit" className="text-primary/70">{t('admin.vacancyInvite.seeking')}</Text>
          {sexLabel && <Badge tone="neutral">{t('admin.vacancyInvite.chipSex', { value: sexLabel })}</Badge>}
          {professionLabel && <Badge tone="neutral">{t('admin.vacancyInvite.chipProfession', { value: professionLabel })}</Badge>}
          {address && <Badge tone="brand">{t('admin.vacancyInvite.chipService', { value: address })}</Badge>}
        </div>
      )}
    </header>
  );

  const message = (testId: string, title: string, text: string, retry?: () => void): JSX.Element => (
    <div className="flex min-h-screen flex-col bg-white">
      {header}
      <div data-testid={testId} className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Heading level={3} weight="semibold" color="primary">{title}</Heading>
        <Text size="sm" color="inherit" className="max-w-[460px] text-primary/70">{text}</Text>
        {retry && <Button variant="primary" size="dense" shape="rounded" onClick={retry}>{t('admin.vacancyInvite.error.retry')}</Button>}
      </div>
    </div>
  );

  if (noPermission) return message('invite-no-permission', t('admin.vacancyInvite.noPermission.title'), t('admin.vacancyInvite.noPermission.text'));
  if (isDeBaja) return message('invite-de-baja', t('admin.vacancyInvite.deBaja.title'), t('admin.vacancyInvite.deBaja.text'));
  if (vacancyError || board.status === 'error') {
    return message('invite-error', t('admin.vacancyInvite.error.load'), '', board.status === 'error' ? board.reload : undefined);
  }

  const service = results?.service;

  return (
    <div className="flex min-h-screen flex-col bg-white" data-testid="invite-page" data-step={step ?? undefined} data-dialog={dialog ?? undefined}>
      {header}
      {board.status === 'noService' ? (
        <div data-testid="invite-special-case" data-kind="no-service" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[640px_1fr]">
          <div className="relative border-r border-gray-300" data-testid="invite-map-pane">
            {view && service && service.lat != null && service.lng != null ? (
              <InviteMapPane
                view={view}
                center={{ lat: service.lat, lng: service.lng }}
                height={mapHeight}
                hoveredId={hoveredId}
                selectedId={selectedPin}
                onHover={setHoveredId}
                onSelect={onPinSelect}
              />
            ) : (
              <InviteMapLoading address={address} />
            )}
          </div>
          <div className="flex min-w-0 flex-col" style={{ height: mapHeight }} data-testid="invite-list-pane">
            {view && ctx && step ? (
              <>
                <InviteListHeader
                  view={view}
                  docOnly={docOnly}
                  onSelectStep={selectStep}
                  onToggleAll={(select) => setUnselected(setAllSelected(ctx, step, select))}
                  onDocOnly={(on) => {
                    const next = applyDocOnly(on, unselected, ctx.candidates);
                    setDocOnly(next.docOnly);
                    setUnselected(next.unselected);
                  }}
                />
                <div className="min-h-0 flex-1 overflow-y-auto" data-testid="invite-rows">
                  {view.rows.map((row) => (
                    <InviteRow
                      key={row.candidate.workerId}
                      row={row}
                      focused={selectedPin === row.candidate.workerId}
                      highlighted={hoveredId === row.candidate.workerId}
                      onToggle={(wid) => setUnselected(toggleOne(unselected, wid))}
                      onNameClick={(wid) => setSelectedPin((cur) => (cur === wid ? null : wid))}
                      onHover={setHoveredId}
                    />
                  ))}
                </div>
                <InviteListFooter
                  footer={view.footer}
                  step={step}
                  invitedCount={results?.invitedCount ?? 0}
                  onInvite={() => setDialog('confirm')}
                  onMore={() => view.footer.more && selectStep(view.footer.more.km)}
                  onFinish={() => setDialog('finish')}
                />
              </>
            ) : (
              <InviteListSkeleton />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
