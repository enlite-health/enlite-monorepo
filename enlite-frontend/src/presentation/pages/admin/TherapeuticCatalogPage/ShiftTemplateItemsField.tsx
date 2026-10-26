import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { shiftEndTime, type ServiceShiftFormValue } from '@domain/scheduleHours';
import type { ShiftTemplateItem } from '@domain/entities/TherapeuticProject';
import { ShiftTimeRow, isEqualWithoutAllDay, minutesOf } from '@presentation/components/features/admin/PatientDetail/edit/ShiftTimeRow';

interface Props {
  value: ShiftTemplateItem[];
  onChange: (next: ShiftTemplateItem[]) => void;
  /** `false` enquanto algum turno tem Fin = Inicio sem "Todo el día" — esse turno NÃO vai em `onChange`. */
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

const NEW_ROW: ServiceShiftFormValue = { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', allDay: false };

const toRow = (item: ShiftTemplateItem): ServiceShiftFormValue => ({
  dayOfWeek: 0,
  startTime: item.startTime.slice(0, 5),
  endTime: shiftEndTime(item.startTime, item.durationMinutes),
  allDay: item.durationMinutes === 1440,
});

/** Turnos de UMA guardia (074): a mesma linha Início/Fin/"Todo el día" do editor do serviço; viaja `{ startTime, durationMinutes }`, nunca o Fin. */
export function ShiftTemplateItemsField({ value, onChange, onValidityChange, disabled = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const tt = (k: string): string => t(`admin.therapeuticCatalog.shiftTemplates.${k}`);
  const [rows, setRows] = useState<ServiceShiftFormValue[]>(() => value.map(toRow));

  const commit = (next: ServiceShiftFormValue[]): void => {
    setRows(next);
    onValidityChange?.(next.every((r) => minutesOf(r) !== null));
    onChange(next.flatMap((r) => { const m = minutesOf(r); return m === null ? [] : [{ startTime: r.startTime, durationMinutes: m }]; }));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="shift-template-items">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`shift-template-item-${i}`}>
          <ShiftTimeRow value={row} onChange={(change) => commit(rows.map((r, j) => (j === i ? { ...r, ...change } : r)))} disabled={disabled} testIdSuffix={String(i)} />
          <button type="button" onClick={() => commit(rows.filter((_, j) => j !== i))} disabled={disabled} aria-label={tt('removeItem')} data-testid={`shift-template-remove-${i}`} className="p-1 text-primary hover:text-red-500 transition-colors disabled:opacity-50">
            <X className="w-3.5 h-3.5" strokeWidth={2.5} />
          </button>
          {isEqualWithoutAllDay(row) && (
            <Text as="span" size="xs" className="text-red-600" data-testid={`shift-template-error-${i}`}>{t('admin.patients.editDrawer.shift.equalUseAllDay')}</Text>
          )}
        </div>
      ))}
      <button type="button" onClick={() => commit([...rows, NEW_ROW])} disabled={disabled} data-testid="shift-template-add" className="flex w-fit items-center gap-1 text-sm text-primary hover:underline disabled:opacity-50">
        <Plus className="w-4 h-4" aria-hidden="true" />
        {tt('addItem')}
      </button>
    </div>
  );
}
