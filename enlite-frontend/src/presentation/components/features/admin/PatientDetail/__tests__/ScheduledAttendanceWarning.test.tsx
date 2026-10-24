/**
 * ScheduledAttendanceWarning — aviso antes de tirar quem tem atendimento agendado (058 P5c). i18n real (es).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { ScheduledAttendanceWarning } from '../ScheduledAttendanceWarning';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

describe('ScheduledAttendanceWarning', () => {
  it('lista as datas em dd/mm e a entrada futura; sem entrada, a linha da entrada não aparece', () => {
    const { rerender } = render(
      <ScheduledAttendanceWarning substitutionDates={['2026-10-26', '2026-11-02']} futureEntryFrom="2026-11-09" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('aviso-agendados-datas')).toHaveTextContent('26/10, 02/11');
    expect(screen.getByTestId('aviso-agendados-entrada')).toHaveTextContent('09/11');
    rerender(<ScheduledAttendanceWarning substitutionDates={['2026-10-26']} futureEntryFrom={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('aviso-agendados-entrada')).toBeNull();
  });

  it('Confirmar chama onConfirm; Volver chama onCancel; submitting desabilita os dois', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<ScheduledAttendanceWarning substitutionDates={['2026-10-26']} futureEntryFrom={null} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('aviso-agendados-confirmar'));
    fireEvent.click(screen.getByTestId('aviso-agendados-cancelar'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ScheduledAttendanceWarning substitutionDates={['2026-10-26']} futureEntryFrom={null} onConfirm={onConfirm} onCancel={onCancel} submitting />);
    expect(screen.getByTestId('aviso-agendados-confirmar')).toBeDisabled();
    expect(screen.getByTestId('aviso-agendados-cancelar')).toBeDisabled();
  });
});
