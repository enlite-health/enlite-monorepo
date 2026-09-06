/**
 * NumericField — o `type="number"` engole letra em silêncio; este campo AVISA (Gabriel, 06/09:
 * "os campos aceitam apenas números, precisamos mostrar isso pra eles caso tentem digitar letras").
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { NumericField, AVISO_MS } from '../NumericField';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false }, initImmediate: false });
});

describe('NumericField', () => {
  it('a dica "Solo números" fica sempre visível; sem aviso antes de qualquer tecla', () => {
    render(<NumericField id="n" label="Valor" testId="n" />);
    expect(screen.getByText('Solo números')).toBeTruthy();
    expect(screen.queryByText('Este campo acepta solo números.')).toBeNull();
    expect(screen.getByTestId('n')).toHaveAttribute('type', 'number');
    expect(screen.getByTestId('n')).toHaveAttribute('inputmode', 'decimal');
  });

  it('letra digitada → aviso vermelho + aria-invalid; some sozinho depois de AVISO_MS', () => {
    vi.useFakeTimers();
    render(<NumericField id="n" label="Valor" testId="n" />);
    fireEvent.keyDown(screen.getByTestId('n'), { key: 'a' });
    expect(screen.getByText('Este campo acepta solo números.')).toBeTruthy();
    expect(screen.getByTestId('n')).toHaveAttribute('aria-invalid', 'true');
    act(() => { vi.advanceTimersByTime(AVISO_MS); });
    expect(screen.queryByText('Este campo acepta solo números.')).toBeNull();
    expect(screen.getByTestId('n')).not.toHaveAttribute('aria-invalid');
    vi.useRealTimers();
  });

  it('segunda letra dentro da janela reinicia o relógio (o aviso não pisca)', () => {
    vi.useFakeTimers();
    render(<NumericField id="n" label="Valor" testId="n" />);
    fireEvent.keyDown(screen.getByTestId('n'), { key: 'x' });
    act(() => { vi.advanceTimersByTime(AVISO_MS - 100); });
    fireEvent.keyDown(screen.getByTestId('n'), { key: 'y' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('Este campo acepta solo números.')).toBeTruthy();
    vi.useRealTimers();
  });

  it('vírgula: preventDefault + aviso "usá punto" (medido 06/09: o Chromium descartava a vírgula e 1500,50 virava 150050)', () => {
    vi.useFakeTimers();
    render(<NumericField id="n" label="Valor" testId="n" />);
    const naoCancelado = fireEvent.keyDown(screen.getByTestId('n'), { key: ',' });
    expect(naoCancelado).toBe(false);
    expect(screen.getByText('Para decimales usá punto (.), no coma.')).toBeTruthy();
    expect(screen.queryByText('Este campo acepta solo números.')).toBeNull();
    act(() => { vi.advanceTimersByTime(AVISO_MS); });
    expect(screen.queryByText('Para decimales usá punto (.), no coma.')).toBeNull();
    vi.useRealTimers();
  });

  it('letra NÃO é cancelada (o navegador já recusa); só avisa', () => {
    render(<NumericField id="n" label="Valor" testId="n" />);
    expect(fireEvent.keyDown(screen.getByTestId('n'), { key: 'a' })).toBe(true);
  });

  it.each([['1'], ['.'], ['-'], ['+'], ['Backspace'], ['Tab'], ['ArrowLeft'], ['Enter']])('tecla %s NÃO acende o aviso', (key) => {
    render(<NumericField id="n" label="Valor" testId="n" />);
    fireEvent.keyDown(screen.getByTestId('n'), { key });
    expect(screen.queryByText('Este campo acepta solo números.')).toBeNull();
  });

  it('repassa o onKeyDown do chamador e desmonta sem timer órfão', () => {
    vi.useFakeTimers();
    const onKeyDown = vi.fn();
    const { unmount } = render(<NumericField id="n" label="Valor" testId="n" onKeyDown={onKeyDown} />);
    fireEvent.keyDown(screen.getByTestId('n'), { key: 'z' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(AVISO_MS * 2); })).not.toThrow();
    vi.useRealTimers();
  });
});
