/**
 * Modal do documento do paciente — aberto pelo clique em "Enviar" (`AxonicoSendControl`) quando
 * `axonicoDayEligibility` acusa `missingDocument` (decisão do Gabriel, 19/09: "se o paciente NÃO
 * TIVER DNI, ao clicar em Enviar, perguntar e registrar; depois disso não perguntar mais").
 *
 * Puramente apresentação, MESMO padrão de `ValidateBatchModal`/`ContestModal` (overlay fixo,
 * card branco, state local só do campo) — quem chama decide o que "confirmar" significa
 * (`AxonicoSendControl` liga a `useRegisterAnaCarePatientDocument` e depois ao envio encadeado).
 * Input SEM biblioteca de form nova: mesma classe usada em `TagFormModal.tsx:47-48`.
 *
 * `errorCode` vem do `code` do backend (`AnaCarePatientDocumentServiceError.code`) — a tela NUNCA
 * mostra o texto cru do backend, só traduz por código (409 = conflito de documento diferente;
 * qualquer outro código = documento inválido), mesmo padrão de `describeError` no container.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';

const DOCUMENT_CONFLICT_ERROR_CODE = 'DocumentoJaRegistradoDivergenteError';

interface AxonicoDocumentModalProps {
  isSubmitting: boolean;
  /** `null` = sem erro pendente. Qualquer código diferente de `DocumentoJaRegistradoDivergenteError` cai na mensagem genérica de documento inválido. */
  errorCode: string | null;
  onConfirm: (documentNumber: string) => void;
  onCancel: () => void;
}

export function AxonicoDocumentModal({ isSubmitting, errorCode, onConfirm, onCancel }: AxonicoDocumentModalProps): JSX.Element {
  const { t } = useTranslation();
  const [documentNumber, setDocumentNumber] = useState('');
  const trimmed = documentNumber.trim();
  const canConfirm = trimmed.length > 0 && !isSubmitting;
  const inputClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none';

  const errorMessage =
    errorCode === null
      ? null
      : errorCode === DOCUMENT_CONFLICT_ERROR_CODE
        ? t('admin.anacareHours.dayGroup.axonico.documentModal.errorConflict')
        : t('admin.anacareHours.dayGroup.axonico.documentModal.errorInvalid');

  function handleConfirm(): void {
    if (canConfirm) onConfirm(trimmed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="anacare-hours-axonico-document-modal">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 flex flex-col gap-4">
        <Heading level={3}>{t('admin.anacareHours.dayGroup.axonico.documentModal.title')}</Heading>
        <Text color="muted">{t('admin.anacareHours.dayGroup.axonico.documentModal.description')}</Text>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anacare-hours-axonico-document-modal-input" required>
            {t('admin.anacareHours.dayGroup.axonico.documentModal.inputLabel')}
          </Label>
          <input
            id="anacare-hours-axonico-document-modal-input"
            className={inputClass}
            value={documentNumber}
            onChange={(e) => setDocumentNumber(e.target.value)}
            placeholder={t('admin.anacareHours.dayGroup.axonico.documentModal.inputPlaceholder')}
            disabled={isSubmitting}
            data-testid="anacare-hours-axonico-document-modal-input"
          />
        </div>

        {errorMessage && (
          <Text size="xs" className="!text-red-600" data-testid="anacare-hours-axonico-document-modal-error">
            {errorMessage}
          </Text>
        )}

        <div className="flex justify-end gap-3 mt-2">
          <Button variant="outline" onClick={onCancel} disabled={isSubmitting} data-testid="anacare-hours-axonico-document-modal-cancel">
            {t('admin.anacareHours.dayGroup.axonico.documentModal.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} isLoading={isSubmitting} data-testid="anacare-hours-axonico-document-modal-confirm">
            {t('admin.anacareHours.dayGroup.axonico.documentModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
