/**
 * AdmissionSeals — os quatro selos de saúde de uma reunião de admissão (spec 049 §4.5): Confirmación,
 * Recordatorio, Importación e Documento. A tela só TRADUZ o que o servidor derivou (`admissionSeals.ts`);
 * quem pode reenviar também vem da API (`canResend`), a tela nunca recalcula.
 *
 * Cores: texto 900 sobre fundo 100 (≥ 7:1, AAA — memória "contraste mira AAA"); `gray-*` NÃO é usado (a escala do
 * tema é redefinida e não é monotônica). Cor nunca é a única pista: todo selo diz o estado por escrito.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCw } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type {
  AdmissionAppointment,
  MessageSealView,
  ResendKind,
} from '@infrastructure/http/AdminAdmissionApiService';
import { IMPORT_SEAL_TONE, MESSAGE_SEAL_TONE, type SealTone } from './sealTones';

const TONE_CLASS: Record<SealTone, string> = {
  ok: 'bg-green-100 text-green-900',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-red-100 text-red-900',
  neutral: 'bg-slate-100 text-slate-800',
};

export function SealChip({ tone, children, testId }: { tone: SealTone; children: string; testId: string }): JSX.Element {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex items-center px-2 py-0.5 rounded-full ${TONE_CLASS[tone]}`}
    >
      <Text as="span" size="xs" weight="medium" color="inherit">{children}</Text>
    </span>
  );
}

interface SealSlotProps {
  label: string;
  testId: string;
  children: JSX.Element | null;
}

function SealSlot({ label, testId, children }: SealSlotProps): JSX.Element {
  return (
    <div className="flex items-center gap-1.5" data-testid={testId}>
      <Text as="span" size="2xs" color="primary" className="uppercase">{label}</Text>
      {children}
    </div>
  );
}

interface Props {
  appointment: AdmissionAppointment;
  /** `patient_admission:resend_message` — sem a célula o botão nem existe. */
  canResendCell: boolean;
  /** O resumo existe e a aba Documentos está visível: o selo vira atalho para ela. */
  onOpenDocuments?: () => void;
  onResend: (kind: ResendKind) => void;
  /** `patient_admission:retry_summary` — sem a célula o botão "Reintentar resumen" nem existe (e o aviso de teto também não). */
  canRetryCell?: boolean;
  onRetrySummary?: () => void;
}

export function AdmissionSeals({ appointment, canResendCell, onOpenDocuments, onResend, canRetryCell = false, onRetrySummary }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (key: string): string => t(`admin.patients.detail.admissionTab.${key}`);
  const id = appointment.id;
  const { confirmation, reminder, import: importStatus, document } = appointment.seals;
  // O servidor decide se há o que reprocessar (`summaryRetry`) e quantas autorizações restam; a tela só esconde o que a célula não dá.
  const retry = canRetryCell ? appointment.summaryRetry ?? null : null;
  const retryAtLimit = Boolean(retry && retry.exhausted && retry.authorizationsLeft === 0);

  const messageSeal = (kind: ResendKind, view: MessageSealView, label: string, testKey: string): JSX.Element => (
    <SealSlot label={label} testId={`admission-seal-${testKey}-${id}`}>
      <>
        <SealChip tone={MESSAGE_SEAL_TONE[view.seal]} testId={`admission-seal-${testKey}-chip-${id}`}>
          {ta(`seal.message.${view.seal}`)}
        </SealChip>
        {canResendCell && view.canResend && (
          <button
            type="button"
            onClick={() => onResend(kind)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-primary underline hover:bg-gray-200 transition-colors"
            data-testid={`admission-resend-${testKey}-${id}`}
          >
            <RotateCw size={12} aria-hidden="true" />
            <Text as="span" size="xs" weight="medium" color="inherit">{ta('resend.button')}</Text>
          </button>
        )}
      </>
    </SealSlot>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid={`admission-seals-${id}`}>
      {messageSeal('confirmation', confirmation, ta('seal.confirmation'), 'confirmation')}
      {messageSeal('reminder_30min', reminder, ta('seal.reminder'), 'reminder')}
      <SealSlot label={ta('seal.import')} testId={`admission-seal-import-${id}`}>
        <>
          {importStatus ? (
            <SealChip tone={IMPORT_SEAL_TONE[importStatus] ?? 'neutral'} testId={`admission-seal-import-chip-${id}`}>
              {ta(`seal.importStatus.${importStatus}`)}
            </SealChip>
          ) : (
            <SealChip tone="neutral" testId={`admission-seal-import-chip-${id}`}>{ta('seal.importStatus.none')}</SealChip>
          )}
          {retry && !retryAtLimit && onRetrySummary && (
            <button
              type="button"
              onClick={onRetrySummary}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-primary underline hover:bg-gray-200 transition-colors"
              data-testid={`admission-retry-summary-${id}`}
            >
              <RotateCw size={12} aria-hidden="true" />
              <Text as="span" size="xs" weight="medium" color="inherit">{ta('retry.button')}</Text>
            </button>
          )}
          {retryAtLimit && <SealChip tone="bad" testId={`admission-retry-limit-${id}`}>{ta('retry.limit')}</SealChip>}
        </>
      </SealSlot>
      <SealSlot label={ta('seal.document')} testId={`admission-seal-document-${id}`}>
        {document ? (
          onOpenDocuments ? (
            <button
              type="button"
              onClick={onOpenDocuments}
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-green-100 text-green-900 underline"
              data-testid={`admission-document-link-${id}`}
            >
              <Text as="span" size="xs" weight="medium" color="inherit">{ta('seal.documentReady')}</Text>
            </button>
          ) : (
            <SealChip tone="ok" testId={`admission-document-ready-${id}`}>{ta('seal.documentReady')}</SealChip>
          )
        ) : (
          <SealChip tone="neutral" testId={`admission-document-none-${id}`}>{ta('seal.documentNone')}</SealChip>
        )}
      </SealSlot>
    </div>
  );
}
