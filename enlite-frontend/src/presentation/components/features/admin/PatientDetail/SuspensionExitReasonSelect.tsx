import { useTranslation } from 'react-i18next';
import { SUSPENSION_EXIT_REASONS } from '@domain/entities/patientEnums';
import { FormField } from '@presentation/components/molecules/FormField';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';

interface Props {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  'data-testid'?: string;
}

/**
 * Motivo de SAÍDA de SUSPENDED (decisão do Gabriel 29/09/2026, migration 486) — ZERO duplicação
 * (pedido do Gabriel, 2ª rodada): extraído daqui para que a ficha (`PatientStatusControl`) e o
 * diálogo de arrasto do Kanban (`SuspensionExitReasonDialog`) usem o MESMO select — mesmas 5
 * opções, mesma tradução, sem risco de uma das duas telas ficar desatualizada quando o enum
 * mudar (mesmo raciocínio do irmão `ON_HOLD_REASONS`, ainda inline nos dois lugares — LISTA).
 */
export function SuspensionExitReasonSelect({ value, onChange, id = 'suspension-exit-reason', ...rest }: Props): JSX.Element {
  const { t } = useTranslation();
  const options: SelectOption[] = SUSPENSION_EXIT_REASONS.map((r) => ({
    value: r,
    label: t(`admin.patients.suspensionExitReasonOptions.${r}`, r),
  }));

  return (
    <FormField label={t('admin.patients.status.suspensionExitReason')} htmlFor={id} required>
      <SelectField
        id={id}
        inputSize="compact"
        options={options}
        placeholder={t('admin.patients.editDrawer.unset')}
        value={value}
        onChange={onChange}
        data-testid={rest['data-testid'] ?? 'patient-status-exit-reason'}
      />
    </FormField>
  );
}
