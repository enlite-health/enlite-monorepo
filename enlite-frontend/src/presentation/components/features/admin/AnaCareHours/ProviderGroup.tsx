/**
 * Grupo por PRESTADOR dentro do detalhe do paciente. Nome sempre RESOLVIDO. Regras travadas:
 * validado CONGELA (sem reabrir/editar, mostra quem e quando); contestado mostra o motivo (lista
 * fechada, sempre visível) e a nota (só com `patient_clinical:read` — sem a célula o backend não
 * manda o campo e a linha mostra "Nota restringida") e GANHA ação "Validar" (pode ser validado
 * depois — só validado é definitivo); "Sin check-in" e "Web admin" com destaque de origem.
 *
 * Adaptado de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/ProviderGroup.tsx`:
 * `shift.validatedBy?.name` → `shift.validatedByName` (Validator removido, contrato HTTP fixo);
 * nova linha do motivo (`contestReason`) sempre visível; nota vira "Nota restringida" quando
 * `contestNote` está ausente num turno contestado.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { OriginBadge } from './OriginBadge';
import { ValidationStatusBadge } from './ValidationStatusBadge';
import type { AnaCareProvider, AnaCareShift } from './types';
import {
  isShiftSelectable,
  pendingShiftsOf,
  providerDisplayName,
  providerPendingSelectionState,
  shiftHours,
  totalHours,
  validationProgress,
  type SinCheckinHoursMode,
} from './selectors';

/** Diferença mínima entre real e previsto para destacar a coluna Horas. */
const HOURS_HIGHLIGHT_THRESHOLD = 15 / 60; // 15 minutos em horas

interface ProviderGroupProps {
  provider: AnaCareProvider;
  disableActions: boolean;
  disableReason?: string;
  onValidateShift: (shift: AnaCareShift) => void;
  onOpenContestModal: (shift: AnaCareShift) => void;
  /** Turnos selecionados no PACIENTE inteiro — pode misturar prestadores diferentes. */
  selectedShiftIds: ReadonlySet<string>;
  onToggleShift: (shiftId: string) => void;
  /** Marca/desmarca TODOS os pendentes deste prestador de uma vez (checkbox de cabeçalho). */
  onToggleProviderPending: (provider: AnaCareProvider) => void;
  highlightNoCheckIn?: boolean;
  sinCheckinHoursMode?: SinCheckinHoursMode;
}

export function ProviderGroup({
  provider,
  disableActions,
  disableReason,
  onValidateShift,
  onOpenContestModal,
  selectedShiftIds,
  onToggleShift,
  onToggleProviderPending,
  highlightNoCheckIn = false,
  sinCheckinHoursMode = 'zero',
}: ProviderGroupProps): JSX.Element {
  const { t } = useTranslation();
  const shifts = provider.shifts;
  const progress = validationProgress(shifts);
  const hours = totalHours(shifts, sinCheckinHoursMode);
  const pending = pendingShiftsOf(provider);
  const allValidated = progress.total > 0 && progress.validated === progress.total;
  const pendingSelectionState = providerPendingSelectionState(provider, selectedShiftIds);

  return (
    <div className="border border-gray-600 rounded-xl overflow-hidden" data-testid={`anacare-hours-provider-group-${provider.anaCareId}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-gray-300">
        <div className="flex items-center gap-3">
          {pending.length > 0 && (
            <Checkbox
              checked={pendingSelectionState === 'all'}
              disabled={disableActions}
              onChange={() => onToggleProviderPending(provider)}
              aria-label={t('admin.anacareHours.providerGroup.selectAllPendingAriaLabel', { provider: providerDisplayName(provider) })}
              data-testid={`anacare-hours-select-all-pending-${provider.anaCareId}`}
              data-selection-state={pendingSelectionState}
            />
          )}
          {/* Nome do prestador (PII) — mascarado no Clarity, mesmo padrão de PatientIdentityCard.tsx (parecer do lex, condição a). */}
          <div data-clarity-mask="True">
            <Heading level={4} as="h3">
              {providerDisplayName(provider)}
            </Heading>
          </div>
          <Text size="xs" color="muted">
            {t('admin.anacareHours.providerGroup.shiftsAndHours', { count: shifts.length, hours: hours.toFixed(1) })}
          </Text>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-3">
            <ProgressBar percentage={progress.percentage} height="sm" className="w-32" />
            <Text size="xs" color="muted">
              {progress.validated}/{progress.total}
            </Text>
            {pending.length === 0 &&
              (allValidated ? (
                <Text
                  size="xs"
                  className="!text-gray-800 whitespace-nowrap shrink-0"
                  data-testid={`anacare-hours-no-pending-${provider.anaCareId}`}
                >
                  {t('admin.anacareHours.providerGroup.allValidated')}
                </Text>
              ) : (
                <Text size="xs" className="!text-gray-800" data-testid={`anacare-hours-no-pending-${provider.anaCareId}`}>
                  {t('admin.anacareHours.providerGroup.noPendingContested')}
                </Text>
              ))}
          </div>
          {disableActions && (
            <Text size="xs" className="!text-red-600" data-testid={`anacare-hours-disable-reason-${provider.anaCareId}`}>
              {t('admin.anacareHours.stale.blockedPrefix', { reason: disableReason })}
            </Text>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableHead unwrapped aria-label={t('admin.anacareHours.providerGroup.table.select')} />
          <TableHead>{t('admin.anacareHours.providerGroup.table.date')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.scheduled')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.actual')}</TableHead>
          <TableHead align="right">{t('admin.anacareHours.providerGroup.table.hours')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.origin')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.status')}</TableHead>
          <TableHead>{t('admin.anacareHours.providerGroup.table.actions')}</TableHead>
        </TableHeader>
        <TableBody>
          {shifts.map((shift) => (
            <ShiftRows
              key={shift.id}
              shift={shift}
              disableActions={disableActions}
              onValidateShift={onValidateShift}
              onOpenContestModal={onOpenContestModal}
              selected={selectedShiftIds.has(shift.id)}
              onToggleShift={onToggleShift}
              highlight={highlightNoCheckIn && shift.origin === 'sin_checkin'}
              sinCheckinHoursMode={sinCheckinHoursMode}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ShiftRows({
  shift,
  disableActions,
  onValidateShift,
  onOpenContestModal,
  selected,
  onToggleShift,
  highlight,
  sinCheckinHoursMode = 'zero',
}: {
  shift: AnaCareShift;
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
        <TableCell>{formatShortDate(shift.date)}</TableCell>
        <TableCell>
          {shift.scheduledStart}–{shift.scheduledEnd}
        </TableCell>
        <TableCell>
          {shift.actualStart && shift.actualEnd ? `${shift.actualStart}–${shift.actualEnd}` : '—'}
        </TableCell>
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
            // D5 (cobertura, 15/09): o `ValidationStatus` é um union FECHADO de 3 valores
            // ('pendiente'|'validado'|'contestado') — excluído 'validado' acima, sobra
            // exatamente `canValidate` (pendiente/contestado). O `: canValidate ? (...) : null`
            // de antes tinha um `null` MORTO (nenhum 4º status existe pra cair nele) —
            // removido em vez de marcado como ignorado.
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
          <TableCell unwrapped colSpan={8}>
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

function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return `${day}/${month}`;
}
