import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { Text } from '@presentation/components/atoms/Text';
import { applyTemplateToDays, type CopyShiftsResult, type ServiceShiftFormValue } from '@domain/scheduleHours';
import { useServiceShiftTemplateOptions } from '@hooks/admin/useServiceShiftTemplateOptions';

export const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const chip = (active: boolean): string =>
  `px-2 py-0.5 rounded-pill border text-xs transition-colors disabled:opacity-50 ${
    active ? 'bg-primary text-white border-primary' : 'border-gray-600 text-gray-800 hover:border-primary'
  }`;

/** Os botões de dia (Dom–Sáb) do "Copiar a…" e do "Guardia predefinida": o mesmo recorte, o mesmo estilo. `testId` monta o `data-testid` de cada um. */
export function DayChips({ exclude, selected, onToggle, testId }: { exclude?: number; selected: number[]; onToggle: (day: number) => void; testId: (day: number, key: string) => string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {DAY_KEYS.map((k, i) =>
        i === exclude ? null : (
          <button key={k} type="button" aria-pressed={selected.includes(i)} onClick={() => onToggle(i)} data-testid={testId(i, k)} className={chip(selected.includes(i))}>
            {t(`workerRegistration.availability.${k}Short`)}
          </button>
        ),
      )}
    </>
  );
}

interface Props {
  index: number;
  value: ServiceShiftFormValue[];
  /** O resultado do mesmo detector do "Copiar a…": `next` + os dias que não aceitaram algum turno. */
  onApply: (result: CopyShiftsResult) => void;
  disabled?: boolean;
}

/** Aplica uma guardia predefinida (074) aos dias escolhidos, ACRESCENTANDO — nunca substitui o que o dia já tem. */
export function ApplyShiftTemplate({ index, value, onApply, disabled = false }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const { options, status } = useServiceShiftTemplateOptions();
  const [templateId, setTemplateId] = useState('');
  const [days, setDays] = useState<number[]>([]);
  if (status === 'error' || (status === 'ok' && options.length === 0)) return null;

  const template = options.find((o) => o.id === templateId);
  const apply = (): void => {
    if (!template) return;
    onApply(applyTemplateToDays(value, template.items, days));
    setDays([]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2" data-testid={`svc-shift-template-${index}`}>
      <Text as="span" size="sm" weight="medium" color="secondary">{t('admin.patients.editDrawer.shift.template.label')}</Text>
      <div className="w-56">
        <Combobox
          inputSize="compact"
          options={options.map((o) => ({ value: o.id, label: o.label }))}
          placeholder={t('admin.patients.editDrawer.shift.template.placeholder')}
          value={templateId}
          onChange={setTemplateId}
          disabled={disabled}
          data-testid={`svc-shift-template-select-${index}`}
        />
      </div>
      <DayChips selected={days} onToggle={(d) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))} testId={(d) => `svc-shift-template-day-${index}-${d}`} />
      <button type="button" onClick={apply} disabled={disabled || !template || days.length === 0} data-testid={`svc-shift-template-apply-${index}`} className="px-3 py-0.5 rounded-pill bg-primary text-white text-xs disabled:opacity-50">
        {t('admin.patients.editDrawer.shift.template.apply')}
      </button>
    </div>
  );
}
