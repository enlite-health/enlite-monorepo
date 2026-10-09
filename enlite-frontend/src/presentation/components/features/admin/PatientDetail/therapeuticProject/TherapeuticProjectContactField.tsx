/**
 * TherapeuticProjectContactField — UM dos 4 campos de contato do PT (Responsables, Contactos externos, Contactos de
 * la cobertura, Equipo tratante) com o estado explícito da spec 048:
 *   · "Todavía no hay registro" (PENDING) — marcar LIMPA e desabilita o `MultiSelect`; escolher um contato desmarca;
 *     aviso sob o campo com o prazo (15 dias, ou "vence el DD/MM" quando o campo já estava pendente);
 *   · "No necesita" (NOT_NEEDED) — só renderiza a opção para quem tem `patient_therapeutic_project:waive_contact`
 *     (esconder não basta: o servidor recusa com 403). Quem não tem a célula e recebe um NOT_NEEDED HERDADO vê o texto
 *     "No necesita" e pode trocá-lo escolhendo contatos (qualquer um, P4).
 * Exclusão mútua: contatos × PENDING × NOT_NEEDED nunca coexistem (o servidor recusa ids + status no mesmo campo).
 */
import { useTranslation } from 'react-i18next';
import type { ContactStatusValue } from '@domain/entities/TherapeuticProject';
import { useHasCell } from '@presentation/hooks/useCellAccess';
import { FormField } from '@presentation/components/molecules/FormField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Text } from '@presentation/components/atoms/Text';
import { dayMonth } from './contactStatusDates';

interface Props {
  /** Chave estável do campo (`responsibles`, `externalContacts`, ...) — vira o testid e o id do select. */
  fieldKey: string;
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  status: ContactStatusValue | null;
  onStatusChange: (status: ContactStatusValue | null) => void;
  /** `YYYY-MM-DD` quando o campo JÁ estava pendente na versão de origem (prazo próprio); `null` = pendente novo (15 dias). */
  inheritedDeadline: string | null;
  placeholder: string;
}

export function TherapeuticProjectContactField({
  fieldKey, label, options, value, onChange, status, onStatusChange, inheritedDeadline, placeholder,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const tf = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.${k}`, o ?? {});
  const canWaive = useHasCell('patient_therapeutic_project', 'waive_contact');
  const locked = status !== null && (status === 'PENDING' || canWaive);

  return (
    <FormField label={label} htmlFor={`tp-${fieldKey}`} labelSize="compact">
      <div className="flex flex-col gap-2" data-testid={`tp-field-${fieldKey}`}>
        <MultiSelect
          id={`tp-${fieldKey}`}
          options={options}
          value={value}
          disabled={locked}
          onChange={(ids) => {
            // Escolher um contato desmarca o estado: o campo passa a ter contatos.
            if (ids.length > 0 && status !== null) onStatusChange(null);
            onChange(ids);
          }}
          placeholder={placeholder}
        />
        <Checkbox
          id={`tp-${fieldKey}-pending`}
          label={tf('contactPending')}
          checked={status === 'PENDING'}
          onChange={(e) => {
            if (e.target.checked) { onChange([]); onStatusChange('PENDING'); } else onStatusChange(null);
          }}
          data-testid={`tp-${fieldKey}-pending`}
        />
        {status === 'PENDING' && (
          <Text size="xs" className="text-amber-700" data-testid={`tp-${fieldKey}-deadline`}>
            {inheritedDeadline ? tf('contactPendingUntil', { date: dayMonth(inheritedDeadline) }) : tf('contactPendingDeadline')}
          </Text>
        )}
        {canWaive && (
          <Checkbox
            id={`tp-${fieldKey}-waived`}
            label={tf('contactNotNeeded')}
            checked={status === 'NOT_NEEDED'}
            onChange={(e) => {
              if (e.target.checked) { onChange([]); onStatusChange('NOT_NEEDED'); } else onStatusChange(null);
            }}
            data-testid={`tp-${fieldKey}-waived`}
          />
        )}
        {!canWaive && status === 'NOT_NEEDED' && (
          <Text size="xs" color="muted" data-testid={`tp-${fieldKey}-waived-text`}>{tf('contactNotNeeded')}</Text>
        )}
      </div>
    </FormField>
  );
}
