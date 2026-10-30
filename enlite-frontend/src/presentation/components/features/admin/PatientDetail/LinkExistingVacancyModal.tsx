/**
 * LinkExistingVacancyModal — vincula uma vaga existente do paciente ao serviço contratado (spec 079, T031).
 * O front não filtra elegibilidade nem decide o portão: lista `candidates`, mostra `rows`/`warnings`/`blockers`
 * e habilita "Vincular" só com `preview.canConfirm`. Tudo que decide é do backend.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, type ComboboxOption } from '@presentation/components/atoms/Combobox/Combobox';
import { missingItemsLabel } from '@presentation/utils/patientStatusMessages';
import { AdminLinkExistingVacancyApiService } from '@infrastructure/http/AdminLinkExistingVacancyApiService';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import type { PatientCompletenessCode } from '@domain/entities/PatientCompleteness';
import type { LinkableVacancy, LinkPreview } from '@domain/entities/LinkExistingVacancy';

interface Props {
  open: boolean;
  patientId: string;
  serviceId: string;
  serviceLabel: string;
  onClose: () => void;
  onLinked: () => void;
}

const DASH = '—';

function formatValue(v: unknown): string {
  if (v == null) return DASH;
  if (Array.isArray(v)) return v.length ? (v.every((x) => typeof x !== 'object') ? v.join(', ') : String(v.length)) : DASH;
  if (typeof v === 'object') {
    const r = v as { min?: unknown; max?: unknown };
    if ('min' in r || 'max' in r) return `${r.min ?? DASH}–${r.max ?? DASH}`;
    return DASH;
  }
  return String(v);
}

export function LinkExistingVacancyModal({ open, patientId, serviceId, serviceLabel, onClose, onLinked }: Props) {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>): string =>
    String(t(`admin.patients.detail.contractedServicesCard.linkExistingVacancy.${key}`, opts ?? {}));
  const [candidates, setCandidates] = useState<LinkableVacancy[] | null>(null);
  const [vacancyId, setVacancyId] = useState('');
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; blockers?: string[] } | null>(null);

  // Sincroniza com o servidor ao abrir (sistema externo): reinicia o estado e lê as candidatas.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setCandidates(null); setVacancyId(''); setPreview(null); setError(null);
    AdminLinkExistingVacancyApiService.preview(patientId, serviceId)
      .then((r) => { if (alive) setCandidates(r.candidates); })
      .catch((e) => { if (alive) { setCandidates([]); setError(toError(e)); } });
    return () => { alive = false; };
  }, [open, patientId, serviceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function toError(e: unknown): { code?: string; blockers?: string[] } {
    return e instanceof ContractedServiceApiError ? { code: e.code, blockers: e.blockers } : {};
  }

  const statusLabel = (s: string | null): string => (s ? String(t(`admin.vacancyDetail.statusBadge.${s}`, { defaultValue: s })) : '');
  const options: ComboboxOption[] = (candidates ?? []).map((c) => ({
    value: c.id,
    label: [formatVacancyCase(c.caseNumber, c.caseOrdinal), c.title, statusLabel(c.status)].filter(Boolean).join(' · '),
  }));

  async function choose(id: string) {
    setVacancyId(id); setPreview(null); setError(null);
    if (!id) return;
    setBusy(true);
    try {
      const r = await AdminLinkExistingVacancyApiService.preview(patientId, serviceId, id);
      setPreview(r.preview);
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await AdminLinkExistingVacancyApiService.link(patientId, serviceId, vacancyId);
      onLinked();
      onClose();
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }

  const blockerText = (code: string): string =>
    code === 'ADDRESS_MISMATCH' ? k('blocker.ADDRESS_MISMATCH') : missingItemsLabel(t, [code as PatientCompletenessCode]);
  const origin: Record<string, string> = { SERVICE: k('originService'), VACANCY: k('originVacancy'), NONE: k('originNone') };
  const blockers = preview?.blockers.length ? preview.blockers : error?.code === 'LINK_BLOCKED' ? error.blockers ?? [] : [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="link-existing-vacancy-modal">
      <div className="bg-white rounded-card shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-4"
        role="dialog" aria-modal="true" aria-label={k('modalTitle')}>
        <h2 className="text-lg font-semibold">{k('modalTitle')}</h2>
        <p className="text-sm text-gray-600">{serviceLabel}</p>

        {candidates === null ? (
          <p>{k('loading')}</p>
        ) : candidates.length === 0 ? (
          <p>{k('noCandidates')}</p>
        ) : (
          <Combobox id="link-existing-vacancy" data-testid="link-existing-vacancy-combo" aria-label={k('selectLabel')}
            options={options} value={vacancyId} onChange={(v) => void choose(v)} placeholder={k('selectPlaceholder')} disabled={busy} />
        )}

        {preview && (
          <div data-testid="link-existing-vacancy-preview" className="flex flex-col gap-3">
            <h3 className="font-medium">{k('previewTitle')}</h3>
            {preview.rows.length === 0 ? (
              <p>{k('noChanges')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th>{k('colField')}</th><th>{k('colVacancyNow')}</th><th>{k('colWillBe')}</th><th>{k('colOrigin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.field}>
                      <td>{k(`field.${r.field}`)}</td><td>{formatValue(r.vacancyValue)}</td>
                      <td>{formatValue(r.effectiveValue)}</td><td>{origin[r.origin]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preview.warnings.length > 0 && (
              <ul data-testid="link-existing-vacancy-warnings" className="list-disc pl-5 text-sm text-amber-700">
                {preview.warnings.map((w) => (
                  <li key={`${w.field}-${w.code}`}>{k(`field.${w.field}`)}: {k(`warning.${w.code}`)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {blockers.length > 0 && (
          <div data-testid="link-existing-vacancy-blockers" className="text-sm text-red-700">
            <p className="font-medium">{k('blockedTitle')}</p>
            <ul className="list-disc pl-5">{blockers.map((b) => <li key={b}>{blockerText(b)}</li>)}</ul>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-red-700">{k(`error.${error.code ?? 'generic'}`, { defaultValue: k('error.generic') })}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="px-4 py-2" onClick={onClose}>{k('cancel')}</button>
          <button type="button" className="px-4 py-2 bg-primary text-white rounded disabled:opacity-50"
            data-testid="link-existing-vacancy-confirm" disabled={!preview?.canConfirm || busy} onClick={() => void confirm()}>
            {k('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
