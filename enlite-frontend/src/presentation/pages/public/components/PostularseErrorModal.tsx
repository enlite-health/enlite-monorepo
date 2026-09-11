import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface PostularseErrorModalProps {
  onClose: () => void;
  /**
   * Omitidos na home (JobsEmbeddedSection, completude "não apurada" — D1,
   * incidente 08/09): ali não há tentativa de postulação pra reintentar, e
   * mandar "completar registro" seria afirmar que falta algo que talvez já
   * esteja completo. Em /vacantes/:id (fluxo original) os dois continuam
   * obrigatórios em uso — só ficam opcionais no TIPO.
   */
  onRetry?: () => void;
  onCompleteRegistration?: () => void;
}

/**
 * Shown when the eligibility check could NOT confirm the worker is allowed to
 * apply (any backend outcome other than a successful track or the 403
 * WORKER_NOT_ELIGIBLE gate — e.g. 404 not found, 401, 500, network).
 *
 * Fail-closed by design (ClickUp 86ajfkwf7): the pre-screening WhatsApp is never
 * opened in this state; the worker must complete registration or retry.
 */
export function PostularseErrorModal({
  onClose,
  onRetry,
  onCompleteRegistration,
}: PostularseErrorModalProps) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full m-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
          <Heading level={3} weight="semibold" color="primary">
            {t('publicVacancy.errorModal.title')}
          </Heading>
        </div>

        <Text size="sm" weight="medium" color="muted" className="mb-6">
          {t('publicVacancy.errorModal.body')}
        </Text>

        <div className="flex flex-col sm:flex-row justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('publicVacancy.errorModal.cancel')}
          </Button>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('publicVacancy.errorModal.retry')}
            </Button>
          )}
          {onCompleteRegistration && (
            <Button variant="primary" size="sm" onClick={onCompleteRegistration}>
              {t('publicVacancy.errorModal.complete')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
