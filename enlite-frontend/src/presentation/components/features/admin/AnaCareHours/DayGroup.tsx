/**
 * Grupo por DIA dentro do detalhe do paciente (decisão do Gabriel, 16/09) — substitui o grupo
 * por PRESTADOR (`ProviderGroup`, removido: nada mais usava depois desta troca — grep confirmado
 * em `docs/diario`). O prestador vira uma COLUNA da linha, não mais o cabeçalho da seção — dois
 * prestadores no mesmo dia viram duas linhas sob o mesmo cabeçalho de dia.
 *
 * Portado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/DayGroup.tsx` sem
 * mudança de comportamento, com 1 correção no port: o `aria-label` do checkbox de turno usava
 * `providerName` no parâmetro `date` do i18n (`shiftCheckboxAriaLabel`) — corrigido para
 * `formatShortDate(shift.date)`, mesmo padrão do `ProviderGroup` antigo.
 *
 * Regras travadas preservadas (mesma origem de `ProviderGroup`): validado CONGELA; contestado
 * mostra motivo (lista fechada, sempre visível) + nota (opcional, "Nota restringida" quando
 * ausente); "Sin check-in" e "Web admin" com destaque de origem; validação é sempre por TURNO.
 *
 * Botão "Enviar" (19/09): fiado de verdade ao Axonico via `AxonicoSendControl` — as 4 condições de
 * habilitação vêm de `axonicoDayEligibility` (`selectors.ts`, dono único do cálculo). `hours` do
 * comando é o `total` já validado como hora CHEIA por essa mesma função — nunca arredondado aqui.
 */
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { OriginBadge } from './OriginBadge';
import { ValidationStatusBadge } from './ValidationStatusBadge';
import { AxonicoSendControl } from './AxonicoSendControl';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';
import type { AnaCareShift } from './types';
import {
  axonicoDayEligibility,
  axonicoSentOf,
  dayHoursSummary,
  formatShortDate,
  formatSourceRange,
  formatSourceTime,
  isShiftSelectable,
  pendingSelectionStateOf,
  providerDisplayName,
  shiftHours,
  totalHours,
  type DayGroupData,
  type SinCheckinHoursMode,
} from './selectors';

/** Diferença mínima entre real e previsto para destacar a coluna Horas. */
const HOURS_HIGHLIGHT_THRESHOLD = 15 / 60; // 15 minutos em horas

interface DayGroupProps {
  day: DayGroupData;
  disableActions: boolean;
  disableReason?: string;
  onValidateShift: (shift: AnaCareShift) => void;
  onOpenContestModal: (shift: AnaCareShift) => void;
  selectedShiftIds: ReadonlySet<string>;
  onToggleShift: (shiftId: string) => void;
  /** Marca/desmarca TODOS os pendentes DESTE DIA de uma vez (checkbox de cabeçalho). */
  onToggleDayPending: (shifts: AnaCareShift[]) => void;
  sinCheckinHoursMode?: SinCheckinHoursMode;
  /** Serviço do envio ao Axonico — injetado de cima (mesmo padrão de `AnaCareHoursService`). */
  axonicoService: AxonicoComprobanteService;
  /** Serviço do registro de documento do paciente (modal aberto quando falta DNI, 19/09) — domínio diferente do envio ao Axonico. */
  patientDocumentService: AnaCarePatientDocumentService;
  /** ↔ `AnaCarePatient.anaCareId` — sempre presente (nunca opcional, ao contrário do documento). */
  anaCarePatientId: string;
  /** ↔ `AnaCarePatient.documentNumber`/`documentType` — ausentes sem a célula `patient_identity:read` ou quando a fonte não mandou. */
  patientDocumentNumber?: string;
  patientDocumentType?: string;
  /** Chamado depois que o documento do paciente é registrado com sucesso — repassado direto a `AxonicoSendControl` (pai refaz a busca do mês). */
  onDocumentRegistered?: () => void;
  /** Chamado depois de um envio ao Axonico bem-sucedido (`enviado` OU `duplicado`) — repassado direto a `AxonicoSendControl` (pai refaz a busca do mês, mesmo mecanismo de `onDocumentRegistered`/`onValidateShift`, para que o dado PERSISTIDO — `sent` abaixo — assuma da renderização local). */
  onSent?: () => void;
}

export function DayGroup({
  day,
  disableActions,
  disableReason,
  onValidateShift,
  onOpenContestModal,
  selectedShiftIds,
  onToggleShift,
  onToggleDayPending,
  sinCheckinHoursMode = 'zero',
  axonicoService,
  patientDocumentService,
  anaCarePatientId,
  patientDocumentNumber,
  patientDocumentType,
  onDocumentRegistered,
  onSent,
}: DayGroupProps): JSX.Element {
  const { t } = useTranslation();
  const shifts = day.entries.map((e) => e.shift);
  const pendingSelectionState = pendingSelectionStateOf(shifts, selectedShiftIds);
  const hasPending = shifts.some((s) => s.status === 'pendiente');
  const heading = formatWeekdayHeading(day.date);
  const { total, validated } = dayHoursSummary(shifts, sinCheckinHoursMode);
  const axonicoEligibility = axonicoDayEligibility(shifts, patientDocumentNumber, sinCheckinHoursMode);
  // change `axonico-envio-rastreavel`: dado PERSISTIDO do dia — presente em QUALQUER turno do dia
  // já é o bastante (o backend anexa o MESMO valor a todos os turnos do dia lançado).
  const axonicoSent = axonicoSentOf(shifts);

  return (
    <div className="border border-gray-600 rounded-xl overflow-hidden" data-testid={`anacare-hours-day-group-${day.date}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-gray-300">
        <div className="flex flex-wrap items-center gap-3">
          {hasPending && (
            <Checkbox
              checked={pendingSelectionState === 'all'}
              disabled={disableActions}
              onChange={() => onToggleDayPending(shifts)}
              aria-label={t('admin.anacareHours.dayGroup.selectAllPendingAriaLabel', { date: heading })}
              data-testid={`anacare-hours-select-all-pending-day-${day.date}`}
              data-selection-state={pendingSelectionState}
            />
          )}
          <Heading level={4} as="h3">
            {heading}
          </Heading>
          <Text size="xs" color="muted" data-testid={`anacare-hours-day-totals-${day.date}`}>
            {t('admin.anacareHours.dayGroup.totalsSummary', { total: total.toFixed(1), validated: validated.toFixed(1) })}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          {disableActions && (
            <Text size="xs" className="!text-red-600" data-testid={`anacare-hours-disable-reason-day-${day.date}`}>
              {t('admin.anacareHours.stale.blockedPrefix', { reason: disableReason })}
            </Text>
          )}
          <AxonicoSendControl
            date={day.date}
            service={axonicoService}
            patientDocumentService={patientDocumentService}
            anaCarePatientId={anaCarePatientId}
            eligibility={axonicoEligibility}
            disableActions={disableActions}
            sent={axonicoSent}
            command={{
              documentNumber: patientDocumentNumber ?? '',
              documentType: patientDocumentType,
              serviceDate: day.date,
              hours: Math.round(totalHours(shifts, sinCheckinHoursMode)),
            }}
            onDocumentRegistered={onDocumentRegistered}
            onSent={onSent}
          />
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableHead unwrapped aria-label={t('admin.anacareHours.providerGroup.table.select')} />
          <TableHead>{t('admin.anacareHours.dayGroup.table.provider')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.scheduled')}</TableHead>
          <TableHead>{t('admin.anacareHours.dayGroup.table.checkin')}</TableHead>
          <TableHead>{t('admin.anacareHours.dayGroup.table.checkout')}</TableHead>
          <TableHead align="right">{t('admin.anacareHours.providerGroup.table.hours')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.origin')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.status')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.actions')}</TableHead>
        </TableHeader>
        <TableBody>
          {day.entries.map(({ shift, provider }) => (
            <ShiftRow
              key={shift.id}
              shift={shift}
              providerName={providerDisplayName(provider)}
              disableActions={disableActions}
              onValidateShift={onValidateShift}
              onOpenContestModal={onOpenContestModal}
              selected={selectedShiftIds.has(shift.id)}
              onToggleShift={onToggleShift}
              highlight={shift.origin === 'sin_checkin'}
              sinCheckinHoursMode={sinCheckinHoursMode}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ShiftRow({
  shift,
  providerName,
  disableActions,
  onValidateShift,
  onOpenContestModal,
  selected,
  onToggleShift,
  highlight,
  sinCheckinHoursMode = 'zero',
}: {
  shift: AnaCareShift;
  providerName: string;
  disableActions: boolean;
  onValidateShift: (shift: AnaCareShift) => void;
  onOpenContestModal: (shift: AnaCareShift) => void;
  selected: boolean;
  onToggleShift: (shiftId: string) => void;
  highlight: boolean;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}): JSX.Element {
  const { t } = useTranslation();
  const hours = shiftHours(shift, sinCheckinHoursMode);
  const diffFromScheduled = shift.hoursActual !== null && Math.abs(hours - shift.hoursScheduled) >= HOURS_HIGHLIGHT_THRESHOLD;
  const showDash = shift.hoursActual === null && sinCheckinHoursMode === 'zero';

  return (
    <>
      <TableRow clickable={false} className={highlight ? 'bg-red-50' : undefined} data-testid={`anacare-hours-shift-row-${shift.id}`}>
        <TableCell unwrapped>
          {isShiftSelectable(shift) && (
            <Checkbox
              checked={selected}
              disabled={disableActions}
              onChange={() => onToggleShift(shift.id)}
              aria-label={t('admin.anacareHours.providerGroup.shiftCheckboxAriaLabel', { date: formatShortDate(shift.date) })}
              data-testid={`anacare-hours-select-shift-${shift.id}`}
            />
          )}
        </TableCell>
        <TableCell weight="medium">{providerName}</TableCell>
        <TableCell>{formatSourceRange(shift.scheduledStart, shift.scheduledEnd)}</TableCell>
        <TableCell data-testid={`anacare-hours-shift-checkin-${shift.id}`}>{formatSourceTime(shift.actualStart) ?? '—'}</TableCell>
        <TableCell data-testid={`anacare-hours-shift-checkout-${shift.id}`}>{formatSourceTime(shift.actualEnd) ?? '—'}</TableCell>
        <TableCell align="right" unwrapped>
          <Text as="span" size="sm" weight={diffFromScheduled ? 'semibold' : 'normal'} className={diffFromScheduled ? '!text-amber-700' : undefined}>
            {showDash ? '—' : `${hours.toFixed(1)} h`}
          </Text>
        </TableCell>
        <TableCell unwrapped>
          <div className="flex items-center gap-1.5">
            <OriginBadge origin={shift.origin} />
            {shift.origin === 'sin_checkin' && (
              <Text size="xs" color="muted">
                {t('admin.anacareHours.origin.scheduledNoActivity')}
              </Text>
            )}
          </div>
        </TableCell>
        <TableCell unwrapped>
          <ValidationStatusBadge status={shift.status} />
        </TableCell>
        <TableCell unwrapped>
          {shift.status === 'validado' ? (
            <Text size="xs" color="muted">
              {t('admin.anacareHours.providerGroup.validatedBy', {
                name: shift.validatedBy?.name,
                date: formatShortDate(shift.validatedAt?.slice(0, 10) ?? shift.date),
              })}
            </Text>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disableActions}
                onClick={() => onValidateShift(shift)}
                className="shrink-0 whitespace-nowrap"
                data-testid={`anacare-hours-validate-shift-${shift.id}`}
              >
                {t('admin.anacareHours.providerGroup.validateAction')}
              </Button>
              {shift.status === 'pendiente' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disableActions}
                  onClick={() => onOpenContestModal(shift)}
                  data-testid={`anacare-hours-contest-shift-${shift.id}`}
                >
                  {t('admin.anacareHours.providerGroup.contestAction')}
                </Button>
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
      {shift.status === 'contestado' && shift.contestReason && (
        <TableRow clickable={false}>
          <TableCell unwrapped colSpan={9}>
            <div className="px-2 py-1 bg-red-50 rounded flex flex-col gap-0.5">
              <Text size="xs" className="!text-red-700">
                {t('admin.anacareHours.providerGroup.reason', { reason: t(`admin.anacareHours.contestModal.reasons.${shift.contestReason}`) })}
              </Text>
              <Text size="xs" className="!text-red-700">
                {shift.contestNote
                  ? t('admin.anacareHours.providerGroup.note', { note: shift.contestNote })
                  : t('admin.anacareHours.providerGroup.noteRestricted')}
              </Text>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** "Martes, 1 de septiembre" — es-AR, primeira letra maiúscula (Intl devolve minúscula). */
function formatWeekdayHeading(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const formatted = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}
