import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface VacancyBajaConfirmDialogProps {
  /** `list` = lote da lista (mostra a contagem e os casos); `detail` = uma vaga, na ficha. */
  variant: 'list' | 'detail';
  count: number;
  /** Números de caso das vagas do lote (só `list`). */
  cases?: number[];
  isWorking: boolean;
  /** Mensagem de erro já localizada (recusa do lote inteiro ou falha de rede). */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Spec 084 F1/P5: o lote pede confirmação mostrando QUANTAS vagas e QUAIS casos. Sem rota inversa (R17): o texto diz que a
 * baixa não se reativa — só volta pela reativação do serviço. Todo texto passa por i18n (es + pt-BR).
 */
export function VacancyBajaConfirmDialog({
  variant,
  count,
  cases = [],
  isWorking,
  error,
  onConfirm,
  onCancel,
}: VacancyBajaConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  const ns = variant === 'list' ? 'admin.vacancies.baja' : 'admin.vacancyDetail.baja';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      data-testid="vacancy-baja-confirm"
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 flex flex-col gap-5">
        <Heading level={3} weight="semibold" color="secondary" data-testid="vacancy-baja-confirm-title">
          {t(`${ns}.confirmTitle`, { count })}
        </Heading>
        <Text size="sm" color="secondary">
          {t(`${ns}.confirmBody`, { count })}
        </Text>
        {variant === 'list' && cases.length > 0 && (
          <Text size="sm" weight="medium" color="primary" data-testid="vacancy-baja-confirm-cases">
            {t('admin.vacancies.baja.confirmCases', { cases: cases.join(', ') })}
          </Text>
        )}
        {error && (
          <div role="alert" data-testid="vacancy-baja-confirm-error" className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            <Text size="sm" color="inherit" className="text-red-700">{error}</Text>
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="outline" size="md" onClick={onCancel} disabled={isWorking} data-testid="vacancy-baja-confirm-cancel">
            {t(`${ns}.cancel`)}
          </Button>
          <Button variant="primary" size="md" onClick={onConfirm} disabled={isWorking} data-testid="vacancy-baja-confirm-ok">
            {isWorking ? t(`${ns}.working`) : t(`${ns}.confirm`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
