/**
 * LinkExistingVacancyModal — vincula uma vaga existente do paciente ao serviço contratado (spec 079, T031).
 * O front não filtra elegibilidade nem decide o portão: lista `candidates`, mostra `rows`/`warnings`/`blockers`
 * e habilita "Vincular" só com `preview.canConfirm`. Tudo que decide é do backend.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import { Text } from '@presentation/components/atoms/Text';
import { Combobox, type ComboboxOption } from '@presentation/components/atoms/Combobox/Combobox';
import { missingItemsLabel } from '@presentation/utils/patientStatusMessages';
import { AdminLinkExistingVacancyApiService } from '@infrastructure/http/AdminLinkExistingVacancyApiService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import type { PatientCompletenessCode } from '@domain/entities/PatientCompleteness';
import { openLinkCandidates, type LinkableVacancy, type LinkPreview } from '@domain/entities/LinkExistingVacancy';

interface Props {
  open: boolean;
  patientId: string;
  serviceId: string;
  serviceLabel: string;
  /** Texto curto no topo (ex.: o foguete achou vaga vinculável e mandou para cá). */
  notice?: string;
  /**
   * Modo FOGUETE: só candidatas ABERTAS, botão "Criar vaga nova" ao lado de "Vincular", e — se havia mais de uma
   * aberta — depois do vínculo pergunta se exclui as outras (pelo DELETE de vaga que já existe). Ausente = vínculo manual (079).
   */
  rocket?: { onCreateNew: () => void };
  onClose: () => void;
  onLinked: () => void;
}

const DASH = '—';
const VACANCY_FORM = 'admin.vacancyDetail.vacancyForm';
/** Campo da prévia -> chave i18n do enum (a mesma do formulário da vaga / edição do serviço). */
const ENUM_KEY: Record<string, string> = {
  required_sex: 'sexOptions',
  work_schedule: 'workScheduleOptions',
  required_professions: 'professionOptions',
};

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

export function LinkExistingVacancyModal({ open, patientId, serviceId, serviceLabel, notice, rocket, onClose, onLinked }: Props) {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>): string =>
    String(t(`admin.patients.detail.contractedServicesCard.linkExistingVacancy.${key}`, opts ?? {}));
  const [candidates, setCandidates] = useState<LinkableVacancy[] | null>(null);
  const [vacancyId, setVacancyId] = useState('');
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; blockers?: string[] } | null>(null);
  // Passo 2 do foguete: candidatas abertas que sobraram depois do vínculo (null = ainda não chegou lá).
  const [leftovers, setLeftovers] = useState<LinkableVacancy[] | null>(null);
  const [deleteFailed, setDeleteFailed] = useState(0);
  const canDelete = useActionGate('vacancy', 'delete').allowed;

  // Sincroniza com o servidor ao abrir (sistema externo): reinicia o estado e lê as candidatas.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setCandidates(null); setVacancyId(''); setPreview(null); setError(null); setLeftovers(null); setDeleteFailed(0);
    AdminLinkExistingVacancyApiService.preview(patientId, serviceId)
      .then((r) => { if (alive) setCandidates(rocket ? openLinkCandidates(r.candidates) : r.candidates); })
      .catch((e) => { if (alive) { setCandidates([]); setError(toError(e)); } });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `rocket` é um objeto novo a cada render; só o modo (boolean) importa
  }, [open, patientId, serviceId, !!rocket]);

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
      const others = rocket && canDelete ? (candidates ?? []).filter((c) => c.id !== vacancyId) : [];
      if (others.length > 0) {
        setLeftovers(others); // vínculo JÁ confirmado; a pergunta é só sobre as outras
        return;
      }
      onLinked();
      onClose();
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }

  const finish = (): void => { onLinked(); onClose(); };

  async function deleteLeftovers() {
    setBusy(true);
    let failed = 0;
    for (const v of leftovers ?? []) {
      try { await AdminApiService.deleteVacancy(v.id); } catch { failed += 1; }
    }
    setBusy(false);
    if (failed > 0) { setDeleteFailed(failed); return; }
    finish();
  }

  const blockerText = (code: string): string =>
    code === 'ADDRESS_MISMATCH' ? k('blocker.ADDRESS_MISMATCH') : missingItemsLabel(t, [code as PatientCompletenessCode]);
  const enumLabel = (field: string, value: unknown): string =>
    String(t(`${VACANCY_FORM}.${ENUM_KEY[field]}.${String(value)}`, { defaultValue: String(value) }));
  const display = (field: string, v: unknown): string => {
    if (!ENUM_KEY[field] || v == null) return formatValue(v);
    if (Array.isArray(v)) return v.length ? v.map((x) => enumLabel(field, x)).join(', ') : DASH;
    return enumLabel(field, v);
  };
  const origin: Record<string, string> = { SERVICE: k('originService'), NONE: k('originNone') };
  const blockers = preview?.blockers.length ? preview.blockers : error?.code === 'LINK_BLOCKED' ? error.blockers ?? [] : [];

  if (leftovers) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="link-existing-vacancy-modal">
        <div className="bg-white rounded-card shadow-xl w-full max-w-xl text-left p-6 flex flex-col gap-4"
          role="dialog" aria-modal="true" aria-label={k('leftovers.title')} data-testid="link-leftovers-step">
          <h2 className="text-lg font-semibold">{k('leftovers.title')}</h2>
          <p className="text-sm">{k('leftovers.question', { count: leftovers.length })}</p>
          <ul className="list-disc pl-5 text-sm" data-testid="link-leftovers-list">
            {leftovers.map((v) => <li key={v.id}>{formatVacancyCase(v.caseNumber, v.caseOrdinal)} · {statusLabel(v.status)}</li>)}
          </ul>
          {deleteFailed > 0 && <p role="alert" className="text-sm text-red-700">{k('leftovers.deleteFailed', { count: deleteFailed })}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="px-4 py-2" data-testid="link-leftovers-no" disabled={busy} onClick={finish}>
              {deleteFailed > 0 ? k('leftovers.close') : k('leftovers.no')}
            </button>
            {deleteFailed === 0 && (
              <button type="button" className="px-4 py-2 bg-primary text-white rounded disabled:opacity-50"
                data-testid="link-leftovers-yes" disabled={busy} onClick={() => void deleteLeftovers()}>
                {k('leftovers.yes')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="link-existing-vacancy-modal">
      <div className="bg-white rounded-card shadow-xl w-full max-w-3xl max-h-[90vh] text-left overflow-y-auto p-6 flex flex-col gap-4"
        role="dialog" aria-modal="true" aria-label={k('modalTitle')}>
        <h2 className="text-lg font-semibold">{k('modalTitle')}</h2>
        <Text size="sm" color="tertiary">{serviceLabel}</Text>
        {notice && <p data-testid="link-existing-vacancy-notice" className="text-sm text-amber-700">{notice}</p>}

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
              <Table className="min-w-[36rem]">
                <TableHeader>
                  <TableHead className="whitespace-nowrap">{k('colField')}</TableHead><TableHead>{k('colVacancyNow')}</TableHead>
                  <TableHead>{k('colWillBe')}</TableHead><TableHead className="whitespace-nowrap">{k('colOrigin')}</TableHead>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.field}>
                      <TableCell className="whitespace-nowrap" data-testid="link-preview-cell-field">{k(`field.${r.field}`)}</TableCell>
                      <TableCell className="break-words">{display(r.field, r.vacancyValue)}</TableCell>
                      <TableCell className="break-words">{display(r.field, r.effectiveValue)}</TableCell>
                      <TableCell className="whitespace-nowrap" data-testid="link-preview-cell-origin">{origin[r.origin]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
          {rocket && (
            <button type="button" className="px-4 py-2 border border-primary text-primary rounded disabled:opacity-50"
              data-testid="link-existing-vacancy-create-new" disabled={busy} onClick={rocket.onCreateNew}>
              {k('createNew')}
            </button>
          )}
          <button type="button" className="px-4 py-2 bg-primary text-white rounded disabled:opacity-50"
            data-testid="link-existing-vacancy-confirm" disabled={!preview?.canConfirm || busy} onClick={() => void confirm()}>
            {rocket ? k('confirmRocket') : k('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
