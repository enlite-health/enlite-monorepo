/**
 * ServiceShiftEditor — Inicio/Fin/Todo el día por turno (spec 056, P§7).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ServiceShiftEditor, type ServiceShiftFormValue } from '../ServiceShiftEditor';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false }, initImmediate: false,
  });
});

function Harness({ initial, onValidityChange }: { initial: ServiceShiftFormValue[]; onValidityChange: (v: boolean) => void }) {
  const [value, setValue] = useState(initial);
  return <ServiceShiftEditor index={1} value={value} onChange={setValue} onValidityChange={onValidityChange} />;
}

const pick = (testId: string, time: string) => {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByTestId(`${testId}-option-${time}`));
};

const TURNO: ServiceShiftFormValue = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', allDay: false };

describe('ServiceShiftEditor', () => {
  it('digitar 20:00 e 08:00 mostra 12 h e (+1)', () => {
    render(<Harness initial={[TURNO]} onValidityChange={vi.fn()} />);
    pick('svc-shift-start-1-1-0', '20:00');
    pick('svc-shift-end-1-1-0', '08:00');
    const dur = screen.getByTestId('svc-shift-duration-1-1-0').textContent;
    expect(dur).toContain('12 h');
    expect(dur).toContain('(+1)');
  });

  it('Todo el día desabilita Fin e mostra 24 h', () => {
    render(<Harness initial={[TURNO]} onValidityChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('svc-shift-allday-1-1-0'));
    expect(screen.getByTestId('svc-shift-end-1-1-0')).toBeDisabled();
    expect(screen.getByTestId('svc-shift-duration-1-1-0').textContent).toContain('24 h');
  });

  it('Fin = Inicio mostra o erro e onValidityChange(false)', () => {
    const onValidityChange = vi.fn();
    render(<Harness initial={[TURNO]} onValidityChange={onValidityChange} />);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    pick('svc-shift-end-1-1-0', '09:00');
    expect(screen.getByTestId('svc-shift-error-1-1-0').textContent).toContain("Para 24 h use 'Todo el día'");
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it('+ turno e remover turno', () => {
    render(<Harness initial={[]} onValidityChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('svc-shift-add-1-3'));
    expect(screen.getByTestId('svc-shift-start-1-3-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('svc-shift-remove-1-3-0'));
    expect(screen.queryByTestId('svc-shift-start-1-3-0')).toBeNull();
  });
});
