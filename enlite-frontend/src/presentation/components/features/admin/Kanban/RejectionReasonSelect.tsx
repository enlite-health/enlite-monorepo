import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { REJECTION_REASON_OPTIONS } from '@domain/entities/MoveReason';

interface RejectionReasonSelectProps {
  onSubmit: (category: string) => void;
  onCancel: () => void;
  /** Fase 4 (DX-4.10): generalizado para o motivo de salto/saída de Rejeitados — mesmo diálogo,
   * lista e i18n diferentes. Padrão = as opções de rejeição de hoje. */
  options?: readonly string[];
  titleKey?: string;
  optionKeyPrefix?: string;
  confirmKey?: string;
  cancelKey?: string;
  /** Padrão 'rejection': gera rejection-modal, rejection-option-*, rejection-confirm, rejection-cancel
   * (os mesmos testids de hoje, que funil-vacante e encuadre-rejection leem). */
  testIdPrefix?: string;
  /** Fase 2 (D2): opções JÁ rotuladas (o catálogo de motivos de saída). Quando presente, substitui `options` e o rótulo não passa pelo i18n. */
  labeledOptions?: readonly { value: string; label: string }[];
}

export function RejectionReasonSelect({
  onSubmit,
  onCancel,
  options = REJECTION_REASON_OPTIONS,
  titleKey = 'admin.kanban.rejectionModal.title',
  optionKeyPrefix = 'admin.kanban.rejectionOptions',
  confirmKey = 'admin.kanban.rejectionModal.confirm',
  cancelKey = 'admin.kanban.rejectionModal.cancel',
  testIdPrefix = 'rejection',
  labeledOptions,
}: RejectionReasonSelectProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');
  const items: readonly { value: string; label: string }[] = labeledOptions ?? options.map((value) => ({ value, label: t(`${optionKeyPrefix}.${value}`) }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid={`${testIdPrefix}-modal`}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <Heading level={3} className="text-primary mb-4">
          {t(titleKey)}
        </Heading>

        <div className="flex flex-col gap-2 mb-6">
          {items.map(({ value, label }) => (
            <label
              key={value}
              data-testid={`${testIdPrefix}-option-${value.toLowerCase().replace(/_/g, '-')}`}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                selected === value
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="rejection"
                value={value}
                checked={selected === value}
                onChange={(e) => setSelected(e.target.value)}
                className="accent-purple-600"
              />
              <Text as="span" size="sm" weight="medium" className="text-primary">
                {label}
              </Text>
            </label>
          ))}
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="flex-1"
            data-testid={`${testIdPrefix}-cancel`}
          >
            {t(cancelKey)}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => selected && onSubmit(selected)}
            disabled={!selected}
            className="flex-1"
            data-testid={`${testIdPrefix}-confirm`}
          >
            {t(confirmKey)}
          </Button>
        </div>
      </div>
    </div>
  );
}
