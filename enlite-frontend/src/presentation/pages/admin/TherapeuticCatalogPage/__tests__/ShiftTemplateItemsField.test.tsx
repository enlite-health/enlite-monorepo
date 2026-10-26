/**
 * ShiftTemplateItemsField — turnos de uma guardia (spec 074): linhas Início/Fin/"Todo el día", envia `{ startTime, durationMinutes }`.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { ShiftTemplateItemsField } from '../ShiftTemplateItemsField';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false }, initImmediate: false,
  });
});

const pick = (testId: string, time: string) => {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByTestId(`${testId}-option-${time}`));
};

describe('ShiftTemplateItemsField', () => {
  it('F1 dois turnos 06:00-14:00 e Todo el día enviam 480 e 1440', () => {
    const onChange = vi.fn();
    render(<ShiftTemplateItemsField value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('shift-template-add'));
    pick('svc-shift-start-0', '06:00');
    pick('svc-shift-end-0', '14:00');
    fireEvent.click(screen.getByTestId('shift-template-add'));
    fireEvent.click(screen.getByTestId('svc-shift-allday-1'));
    expect(onChange).toHaveBeenLastCalledWith([
      { startTime: '06:00', durationMinutes: 480 },
      { startTime: '09:00', durationMinutes: 1440 },
    ]);
  });

  it('F2 remover o único turno deixa a lista vazia', () => {
    const onChange = vi.fn();
    render(<ShiftTemplateItemsField value={[{ startTime: '08:00', durationMinutes: 360 }]} onChange={onChange} />);
    expect(screen.getByTestId('svc-shift-end-0')).toHaveTextContent('14:00');
    fireEvent.click(screen.getByTestId('shift-template-remove-0'));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByTestId('shift-template-item-0')).toBeNull();
  });
});
