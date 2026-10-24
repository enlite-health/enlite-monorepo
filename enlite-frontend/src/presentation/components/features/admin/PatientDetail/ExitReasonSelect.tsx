import { useTranslation } from 'react-i18next';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { useServiceExitReasonOptions } from '@hooks/admin/useServiceExitReasonOptions';

interface ExitReasonSelectProps {
  value: string;
  onChange: (code: string) => void;
  'data-testid'?: string;
}

/**
 * Campo de motivo de uma troca do itinerário (change itinerario-trocas-motivos-e-figma, Fase 2): a
 * lista fechada é o catálogo de motivos de saída ATIVOS (`useServiceExitReasonOptions`, 1 GET por
 * montagem); o valor é o `code`. Componente único para toda troca que pede motivo (hoje a
 * substituição de um dia; a inteira e a saída o reusam nas Fases 4 e 6). Falha do GET mostra aviso e
 * deixa o campo vazio — quem usa mantém "Confirmar" desabilitado sem motivo.
 */
export function ExitReasonSelect({ value, onChange, 'data-testid': testId = 'exit-reason' }: ExitReasonSelectProps): JSX.Element {
  const { t } = useTranslation();
  const { options, status } = useServiceExitReasonOptions();
  return (
    <>
      <Select
        inputSize="compact"
        data-testid={testId}
        options={(options ?? []).map((o) => ({ value: o.code, label: o.label }))}
        value={value}
        onValueChange={onChange}
        placeholder={t('admin.patients.detail.serviceTeam.substitution.reasonPlaceholder')}
        aria-label={t('admin.patients.detail.serviceTeam.substitution.reason')}
      />
      {status === 'error' && (
        <Text as="p" size="xs" role="alert" color="inherit" className="text-red-600" data-testid={`${testId}-erro`}>
          {t('admin.patients.detail.serviceTeam.substitution.reasonLoadError')}
        </Text>
      )}
    </>
  );
}
