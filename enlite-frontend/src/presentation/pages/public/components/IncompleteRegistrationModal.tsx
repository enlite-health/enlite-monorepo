import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  destinationFor,
  firstPendingTab,
  buildProfileUrl,
} from '@presentation/utils/incompleteFieldDestinations';

interface IncompleteRegistrationModalProps {
  missingFields: string[] | null;
  onClose: () => void;
}

export function IncompleteRegistrationModal({
  missingFields,
  onClose,
}: IncompleteRegistrationModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const allTokens = missingFields ?? [];
  // Bucket pelo DESTINO real (incompleteFieldDestinations), não por prefixo:
  // `worker_documents` — o token AGREGADO que o GET /workers/me devolve (não
  // expandido em doc_*, só o 403 de track-channel expande) — não começa com
  // "doc_", mas destinationFor(...).tab É 'documents'. Bucket por prefixo
  // jogava esse token pra seção errada e o título "Documentos" nunca
  // aparecia quando ele era o único pendente.
  const docTokens = allTokens.filter((f) => destinationFor(f).tab === 'documents');
  const registrationTokens = allTokens.filter((f) => destinationFor(f).tab !== 'documents');

  const isEmpty = !missingFields || missingFields.length === 0;

  const handleFieldClick = (token: string): void => {
    const dest = destinationFor(token);
    navigate(buildProfileUrl(dest));
    onClose();
  };

  const handleCompleteRegistration = (): void => {
    const tab = firstPendingTab(allTokens);
    navigate(buildProfileUrl({ tab }));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full m-4 p-6 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <Heading level={3} weight="semibold" color="primary" className="mb-2">
          {t('publicVacancy.incompleteModal.title')}
        </Heading>

        {isEmpty ? (
          <Text size="sm" weight="medium" color="muted" className="mb-4">
            {t('publicVacancy.incompleteModal.bodyGeneric')}
          </Text>
        ) : (
          <Text size="sm" weight="medium" color="muted" className="mb-4">
            {t('publicVacancy.incompleteModal.body')}
          </Text>
        )}

        {/* 🔒 O Clarity grava a home em produção com sessão identificada (worker
            logado). A lista de pendências nomeia o que falta no cadastro da
            pessoa — parecer do lex, condição C3: mascarar o contêiner inteiro,
            não campo por campo. */}
        <div data-clarity-mask="True" data-testid="incomplete-modal-pending-list">
        {registrationTokens.length > 0 && (
          <div className="mb-3">
            <Text size="sm" weight="semibold" color="primary" className="mb-1.5">
              {t('publicVacancy.incompleteModal.registrationTitle')}
            </Text>
            <div className="flex flex-col gap-1">
              {registrationTokens.map((token) => (
                <button
                  key={token}
                  type="button"
                  role="button"
                  onClick={() => handleFieldClick(token)}
                  aria-label={t('publicVacancy.incompleteModal.goToField', {
                    field: t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token }),
                  })}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-300 group"
                >
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                  <Text as="span" size="sm" weight="medium" color="inherit" className="text-red-600 group-hover:underline flex-1">
                    {t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token })}
                  </Text>
                  <ChevronRight className="w-3.5 h-3.5 text-red-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}

        {docTokens.length > 0 && (
          <div className="mb-3">
            <Text size="sm" weight="semibold" color="primary" className="mb-1.5">
              {t('publicVacancy.incompleteModal.documentsTitle')}
            </Text>
            <div className="flex flex-col gap-1">
              {docTokens.map((token) => (
                <button
                  key={token}
                  type="button"
                  role="button"
                  onClick={() => handleFieldClick(token)}
                  aria-label={t('publicVacancy.incompleteModal.goToField', {
                    field: t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token }),
                  })}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-300 group"
                >
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                  <Text as="span" size="sm" weight="medium" color="inherit" className="text-red-600 group-hover:underline flex-1">
                    {t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token })}
                  </Text>
                  <ChevronRight className="w-3.5 h-3.5 text-red-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}
        </div>

        {/* D4 (QA caça, rodada 4): redirectNotice só soma informação quando
            existe LISTA (diz o que vai acontecer depois de ver os itens
            específicos) — no estado genérico (isEmpty) o bodyGeneric já cobre
            a mesma ideia ("vamos te redirecionar pro perfil"), e mostrar os
            dois juntos repetia a mesma frase de dois jeitos. Comportamento
            COM lista (o que o /vacantes mostra hoje) não muda. */}
        {!isEmpty && (
          <Text size="sm" weight="medium" color="muted" className="mb-4 mt-4">
            {t('publicVacancy.incompleteModal.redirectNotice')}
          </Text>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('publicVacancy.incompleteModal.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCompleteRegistration}
          >
            {t('publicVacancy.incompleteModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
