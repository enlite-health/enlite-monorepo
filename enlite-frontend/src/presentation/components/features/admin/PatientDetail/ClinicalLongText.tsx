import { useTranslation } from 'react-i18next';
import { resolveDateLocale, SHORT_DATE_OPTIONS } from '@presentation/utils/dateLocale';
import { Text } from '@presentation/components/atoms/Text';

interface ClinicalLongTextProps {
  /** Base dos `data-testid`: `<testId>`, `<testId>-text`, `<testId>-edited`, `<testId>-redacted`. */
  testId: string;
  label: string;
  text: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Quando presente, o backend (ponto único `patient_clinical:read`) redigiu: mostra a mensagem, sem texto nem autoria. */
  redactedMessage?: string | null;
}

/** "28/08/2026, 14:35" no fuso e na língua de quem olha (molde: WorkersTable.formatDate). */
function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(resolveDateLocale(locale), { ...SHORT_DATE_OPTIONS, hour: '2-digit', minute: '2-digit' });
}

/**
 * Texto clínico longo da ficha (REQ-01: observações gerais · D211.2: instruções de emergência):
 * quebras preservadas + "Última edição: data · nome" + estado REDIGIDO opcional.
 * `data-clarity-mask` — narrativa clínica não pode ir para a gravação de sessão (lex 29/08, C1.1).
 */
export function ClinicalLongText({ testId, label, text, updatedAt, updatedBy, redactedMessage }: ClinicalLongTextProps) {
  const { t, i18n } = useTranslation();
  const edited = updatedAt
    ? t('admin.patients.detail.diagnosisCard.lastEditedBy', { date: formatDateTime(updatedAt, i18n.language), name: updatedBy ?? '—' })
    : null;
  return (
    <div className="flex flex-col gap-1" data-clarity-mask="True" data-testid={testId}>
      <Text as="span" size="sm" weight="medium" color="secondary">{label}</Text>
      <div data-testid={`${testId}-text`} className="whitespace-pre-wrap">
        {redactedMessage ? (
          <span data-testid={`${testId}-redacted`}>
            <Text as="span" size="sm" color="muted">{redactedMessage}</Text>
          </span>
        ) : (
          <Text size="sm" color="muted" className="whitespace-pre-wrap leading-snug">{text ?? '—'}</Text>
        )}
      </div>
      {edited && !redactedMessage && (
        <span data-testid={`${testId}-edited`}>
          <Text as="span" size="xs" color="muted">{edited}</Text>
        </span>
      )}
    </div>
  );
}
