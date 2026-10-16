/**
 * CreateEnquadreEventDrawer — "Crear evento" (spec 052, E6-E8): entrevistador, data, hora, duração e prestadores a
 * convocar, num `SlideOverPanel` modal. Molde: NewAdmissionModal (a mesma trava VISÍVEL do vínculo: entrevistador
 * sem vínculo aparece desabilitado, com o motivo; o servidor continua sendo quem impõe).
 *
 * O que vai ao servidor é a hora de PAREDE digitada (`YYYY-MM-DDTHH:mm`, sem `Date`): o fuso é decidido lá.
 * Erro do `createEvent` (ex.: Google Calendar) fica DENTRO do drawer: ele não fecha e a seleção não se perde; o texto
 * diz que nada foi gravado. Sucesso: `onCreated()` (a aba fecha e recarrega lista e contador).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { Input } from '@presentation/components/atoms/Input';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { useEnquadreHosts } from '@hooks/admin/useEnquadreHosts';
import { useEnquadreFreeSlots } from '@hooks/admin/useEnquadreFreeSlots';
import type { EnquadreHostOption, EnquadreWorkerOption } from '@domain/entities/EnquadreEvent';
import type { EnquadreLoadStatus } from '@hooks/admin/useEnquadreEvents';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import { timeZoneForCountry, toWallClock, wallClockNow } from '../../PatientDetail/admission/admissionTime';
import { EnquadreWorkerPicker } from './EnquadreWorkerPicker';
import { enquadreErrorKey, isEnquadreStateConflict } from './enquadreErrors';

const DEFAULT_DURATION_MINUTES = 60;

interface Props {
  vacancyId: string;
  workers: readonly EnquadreWorkerOption[];
  workersStatus: EnquadreLoadStatus;
  onCreated: () => void;
  onClose: () => void;
  /** Um 409 de estado (ex.: prestador que já não está disponível): quem montou o drawer recarrega a lista. */
  onStaleData?: () => void;
  /** Relógio injetável (teste e harness). */
  now?: () => Date;
}

export function CreateEnquadreEventDrawer({ vacancyId, workers, workersStatus, onCreated, onClose, onStaleData, now = () => new Date() }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const { hosts, status: hostsStatus, reload: reloadHosts } = useEnquadreHosts(vacancyId);

  const [hostId, setHostId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(String(DEFAULT_DURATION_MINUTES));
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wall = toWallClock(date, time);
  const minutes = Number(duration);
  const freeSlots = useEnquadreFreeSlots(vacancyId, hostId, date, minutes);
  const canSubmit = !busy && hostId !== null && wall !== null && workerIds.length > 0 && Number.isInteger(minutes) && minutes > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit || !wall || !hostId) return;
    setBusy(true);
    setError(null);
    try {
      await AdminEnquadreApiService.createEvent(vacancyId, { hostId, startsAt: wall, durationMinutes: minutes, workerIds });
      onCreated();
    } catch (err) {
      setError(t(enquadreErrorKey(err)));
      if (isEnquadreStateConflict(err)) onStaleData?.();
      setBusy(false);
    }
  };

  const retryHosts = (): void => { void reloadHosts(); };
  const hostReason = (h: EnquadreHostOption): string => te(`create.hostReason.${h.linkState}`);
  const timeZone = timeZoneForCountry('AR');

  return (
    <SlideOverPanel
      isOpen
      modal
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={te('create.title')}
      widthClassName="max-w-lg"
      testId="enquadre-create-drawer"
      closeAriaLabel={te('create.close')}
    >
      <div className="px-6 pt-6 pb-4 border-b border-gray-600 shrink-0">
        <Heading level={2} weight="semibold" color="primary">{te('create.title')}</Heading>
      </div>

      <div className="px-6 py-5 flex flex-col gap-5 overflow-y-auto flex-1">
        <fieldset className="flex flex-col gap-2" data-testid="enquadre-create-host-list" disabled={busy}>
          <legend className="mb-1"><Text as="span" size="2xs" color="primary" className="uppercase">{te('create.host')}</Text></legend>
          {hostsStatus === 'loading' && <Text size="sm" color="secondary" data-testid="enquadre-create-hosts-loading">{te('create.hostsLoading')}</Text>}
          {hostsStatus === 'error' && (
            <div className="flex items-center gap-3" role="alert">
              <Text color="inherit" size="sm" className="text-red-800" data-testid="enquadre-create-hosts-error">{te('create.hostsError')}</Text>
              <Button variant="outline" size="xs" onClick={retryHosts} data-testid="enquadre-create-hosts-retry">{te('create.retry')}</Button>
            </div>
          )}
          {hostsStatus === 'ok' && hosts.length === 0 && <Text size="sm" color="secondary" data-testid="enquadre-create-hosts-empty">{te('create.hostsEmpty')}</Text>}
          {hostsStatus === 'ok' && hosts.map((h) => {
            const disabled = h.linkState !== 'linked';
            const checked = hostId === h.id;
            return (
              <label
                key={h.id}
                data-testid={`enquadre-create-host-${h.id}`}
                data-disabled={disabled ? 'true' : 'false'}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${checked ? 'border-primary bg-gray-200' : 'border-gray-600 bg-white'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary'}`}
              >
                <input
                  type="radio"
                  name="enquadre-create-host"
                  value={h.id}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => setHostId(h.id)}
                  className="mt-1"
                  data-testid={`enquadre-create-host-radio-${h.id}`}
                />
                <span className="flex flex-col min-w-0">
                  <Text as="span" size="sm" weight="medium" color="inherit" className={`truncate ${disabled ? 'text-slate-600' : 'text-gray-900'}`} data-clarity-mask="True">{h.name}</Text>
                  {disabled && (
                    <Text color="inherit" as="span" size="xs" weight="medium" className="text-amber-900" data-testid={`enquadre-create-host-reason-${h.id}`}>{hostReason(h)}</Text>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="enquadre-create-date" className="text-[11px] uppercase text-primary font-lexend">{te('create.date')}</label>
            <Input id="enquadre-create-date" inputSize="compact" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} data-testid="enquadre-create-date-input" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="enquadre-create-time" className="text-[11px] uppercase text-primary font-lexend">{te('create.time')}</label>
            <Input id="enquadre-create-time" inputSize="compact" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} disabled={busy} data-testid="enquadre-create-time-input" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="enquadre-create-duration" className="text-[11px] uppercase text-primary font-lexend">{te('create.duration')}</label>
            <Input id="enquadre-create-duration" inputSize="compact" type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} disabled={busy} data-testid="enquadre-create-duration-input" />
          </div>
        </div>
        <div className="flex flex-col gap-2" data-testid="enquadre-create-slots">
          <Text as="span" size="2xs" color="primary" className="uppercase">{te('create.freeSlots')}</Text>
          {freeSlots.status === 'idle' && <Text size="sm" color="secondary" data-testid="enquadre-create-slots-idle">{te('create.slotsIdle')}</Text>}
          {freeSlots.status === 'loading' && <Text size="sm" color="secondary" data-testid="enquadre-create-slots-loading">{te('create.slotsLoading')}</Text>}
          {freeSlots.status === 'error' && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="enquadre-create-slots-error">{te('create.slotsError')}</Text>}
          {freeSlots.status === 'ok' && freeSlots.slots.length === 0 && <Text size="sm" color="secondary" data-testid="enquadre-create-slots-empty">{te('create.slotsEmpty')}</Text>}
          {freeSlots.status === 'ok' && freeSlots.slots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {freeSlots.slots.map((slot) => (
                <Button
                  key={slot}
                  variant={time === slot ? 'primary' : 'outline'}
                  size="xs"
                  aria-pressed={time === slot}
                  disabled={busy}
                  onClick={() => setTime(slot)}
                  data-testid={`enquadre-create-slot-${slot}`}
                >
                  {slot}
                </Button>
              ))}
            </div>
          )}
        </div>
        <Text color="inherit" size="xs" className="text-slate-600" data-testid="enquadre-create-tz-note">
          {te('create.timezoneNote', { country: t('admin.patients.detail.country.AR', 'AR'), now: wallClockNow(timeZone, now()).slice(11) })}
        </Text>

        <div className="flex flex-col gap-2" data-testid="enquadre-create-workers">
          <div className="flex items-center justify-between gap-3">
            <Text as="span" size="2xs" color="primary" className="uppercase">{te('create.workers')}</Text>
            <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid="enquadre-create-selected-count" data-count={workerIds.length}>
              {te('create.selectedCount', { count: workerIds.length })}
            </Text>
          </div>
          {workersStatus === 'loading' && <Text size="sm" color="secondary" data-testid="enquadre-create-workers-loading">{te('create.workersLoading')}</Text>}
          {workersStatus === 'error' && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="enquadre-create-workers-error">{te('create.workersError')}</Text>}
          {workersStatus === 'ok' && workers.length === 0 && <Text size="sm" color="secondary" data-testid="enquadre-create-workers-empty">{te('convoked.noneAvailable')}</Text>}
          {workersStatus === 'ok' && workers.length > 0 && (
            <EnquadreWorkerPicker
              options={workers}
              selected={workerIds}
              onChange={setWorkerIds}
              noEmailReason={te('create.noEmail')}
              disabled={busy}
              testIdPrefix="enquadre-create-worker"
            />
          )}
        </div>

        {error && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="enquadre-create-error">{error}</Text>}
      </div>

      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-600 shrink-0">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy} data-testid="enquadre-create-cancel">{te('create.close')}</Button>
        <ActionButton resource="enquadre_event" action="create" variant="primary" size="sm" onClick={() => { void submit(); }} disabled={!canSubmit} data-testid="enquadre-create-submit">
          {busy ? te('create.submitting') : te('create.submit')}
        </ActionButton>
      </div>
    </SlideOverPanel>
  );
}
