/**
 * NewAdmissionModal — "Nueva agenda" (spec 049, F7): responsável (roster do país), data e hora de parede no fuso
 * do país do paciente, 60 min.
 *
 * A trava do vínculo do Tactiq é VISÍVEL aqui, mas quem a impõe é o servidor (409 `TACTIQ_LINK_REQUIRED`): o
 * responsável sem vínculo `linked` aparece DESABILITADO, com o motivo, e não é selecionável. O padrão é quem está
 * logado, se estiver no roster E vinculado.
 *
 * O que vai ao servidor é a hora de PAREDE digitada (`YYYY-MM-DDTHH:mm`, sem offset e sem `Date`): quem a interpreta
 * no fuso do país é o back — assim o navegador nunca decide o instante.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdmissionHosts } from '@hooks/admin/useAdmissionHosts';
import {
  AdminAdmissionApiService,
  type AdmissionCountry,
  type AdmissionHost,
} from '@infrastructure/http/AdminAdmissionApiService';
import { bookErrorKey } from './admissionErrors';
import {
  ADMISSION_FIRST_START,
  ADMISSION_LAST_START,
  slotProblem,
  timeZoneForCountry,
  toWallClock,
  wallClockNow,
} from './admissionTime';

interface Props {
  patientId: string;
  country: AdmissionCountry;
  onBooked: () => void;
  onClose: () => void;
  /** Relógio injetável (teste de "horário passado" sem depender da data real). */
  now?: () => Date;
}

export function NewAdmissionModal({ patientId, country, onBooked, onClose, now = () => new Date() }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (key: string, opts?: Record<string, string>): string => t(`admin.patients.detail.admissionTab.${key}`, opts);
  const timeZone = timeZoneForCountry(country);
  const myEmail = useAdminAuthStore((s) => s.adminProfile?.email)?.toLowerCase() ?? null;
  const { hosts, status: hostsStatus, retry } = useAdmissionHosts(country, true);

  const [picked, setPicked] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Padrão = quem está logado, se estiver no roster e vinculado. Só preenche UMA vez (não pisa na escolha da pessoa).
  useEffect(() => {
    if (hostsStatus !== 'ok' || picked !== null || !myEmail) return;
    const me = hosts.find((h) => h.email.toLowerCase() === myEmail && h.linked);
    if (me) setPicked(me.email);
  }, [hosts, hostsStatus, myEmail, picked]);

  const problem = useMemo(() => (date || time ? slotProblem(date, time, timeZone, now()) : 'incomplete'), [date, time, timeZone, now]);
  const wall = toWallClock(date, time);
  const canSubmit = !busy && picked !== null && problem === null && wall !== null;

  const submit = async (): Promise<void> => {
    if (!canSubmit || !wall || !picked) return;
    setBusy(true);
    setError(null);
    try {
      await AdminAdmissionApiService.bookAppointment(patientId, { hostEmail: picked, slotStartISO: wall });
      onBooked();
    } catch (err) {
      setError(t(bookErrorKey(err)));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  const reasonFor = (h: AdmissionHost): string => ta(`hostReason.${h.linkState}`);
  const problemText = problem && problem !== 'incomplete' && (date || time) ? ta(`slotProblem.${problem}`, { first: ADMISSION_FIRST_START, last: ADMISSION_LAST_START }) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="admission-new-modal"
    >
      <div className="bg-white rounded-card shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" role="dialog" aria-modal="true" aria-labelledby="admission-new-title">
        <div className="flex items-start justify-between gap-3 p-6 border-b border-gray-600 shrink-0">
          <Heading level={2} weight="semibold" color="primary" id="admission-new-title">{ta('newModal.title')}</Heading>
          <button type="button" onClick={onClose} disabled={busy} className="text-gray-800 hover:text-primary transition-colors shrink-0" aria-label={t('admin.patients.editDrawer.close')}>
            <X size={24} />
          </button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-5 overflow-y-auto">
          <fieldset className="flex flex-col gap-2" data-testid="admission-host-list" disabled={busy}>
            <legend className="mb-1"><Text as="span" size="2xs" color="primary" className="uppercase">{ta('newModal.host')}</Text></legend>
            {hostsStatus === 'loading' && <Text size="sm" color="secondary" data-testid="admission-hosts-loading">{ta('newModal.hostsLoading')}</Text>}
            {hostsStatus === 'error' && (
              <div className="flex items-center gap-3" role="alert">
                <Text color="inherit" size="sm" className="text-red-800" data-testid="admission-hosts-error">{ta('newModal.hostsError')}</Text>
                <Button variant="outline" size="xs" onClick={retry} data-testid="admission-hosts-retry">{ta('newModal.retry')}</Button>
              </div>
            )}
            {hostsStatus === 'ok' && hosts.length === 0 && <Text size="sm" color="secondary" data-testid="admission-hosts-empty">{ta('newModal.hostsEmpty')}</Text>}
            {hostsStatus === 'ok' && hosts.map((h) => {
              const disabled = !h.linked;
              const checked = picked === h.email;
              const slug = h.email.toLowerCase();
              return (
                <label
                  key={h.email}
                  data-testid={`admission-host-${slug}`}
                  data-disabled={disabled ? 'true' : 'false'}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${checked ? 'border-primary bg-gray-200' : 'border-gray-600 bg-white'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary'}`}
                >
                  <input
                    type="radio"
                    name="admission-host"
                    value={h.email}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => setPicked(h.email)}
                    className="mt-1"
                    data-testid={`admission-host-radio-${slug}`}
                  />
                  <span className="flex flex-col min-w-0">
                    <Text as="span" size="sm" weight="medium" color="inherit" className={`truncate ${disabled ? 'text-slate-600' : 'text-gray-900'}`} data-clarity-mask="True">
                      {h.displayName || h.email}
                    </Text>
                    {h.displayName && (
                      <Text color="inherit" as="span" size="xs" className="truncate text-slate-600" data-clarity-mask="True">{h.email}</Text>
                    )}
                    {disabled && (
                      <Text color="inherit" as="span" size="xs" weight="medium" className="text-amber-900" data-testid={`admission-host-reason-${slug}`}>{reasonFor(h)}</Text>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="admission-date" className="text-[11px] uppercase text-primary font-lexend">{ta('newModal.date')}</label>
              <Input id="admission-date" inputSize="compact" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} data-testid="admission-date-input" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="admission-time" className="text-[11px] uppercase text-primary font-lexend">{ta('newModal.time')}</label>
              <Input
                id="admission-time"
                inputSize="compact"
                type="time"
                value={time}
                min={ADMISSION_FIRST_START}
                max={ADMISSION_LAST_START}
                step={900}
                onChange={(e) => setTime(e.target.value)}
                disabled={busy}
                data-testid="admission-time-input"
              />
            </div>
          </div>
          <Text color="inherit" size="xs" className="text-slate-600" data-testid="admission-tz-note">
            {ta('newModal.timezoneNote', { country: t(`admin.patients.detail.country.${country}`, country), now: wallClockNow(timeZone, now()).slice(11) })}
          </Text>
          {problemText && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="admission-slot-problem">{problemText}</Text>}
          {error && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="admission-book-error">{error}</Text>}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-600 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy} data-testid="admission-new-cancel">{ta('dialog.back')}</Button>
          <Button variant="primary" size="sm" onClick={() => { void submit(); }} disabled={!canSubmit} data-testid="admission-new-submit">
            {busy ? ta('newModal.submitting') : ta('newModal.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
