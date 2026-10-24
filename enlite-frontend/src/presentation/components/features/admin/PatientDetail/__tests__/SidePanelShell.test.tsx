/**
 * SidePanelShell.test.tsx — casca do painel lateral do itinerário (Figma 11340:76377): à direita,
 * altura cheia, cantos arredondados só à esquerda, sem X, fecha por overlay/Esc.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { SidePanelShell } from '../SidePanelShell';
import { DdMmDateInput } from '../DdMmDateInput';
import { formatDdMmYyyy } from '../ddMmDate';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

describe('SidePanelShell', () => {
  it('ancora à direita, altura cheia, cantos arredondados só à esquerda', () => {
    render(
      <SidePanelShell ariaLabel="x" onClose={() => {}} testId="painel">
        <p>conteúdo</p>
      </SidePanelShell>,
    );
    const panel = screen.getByTestId('painel');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel.className).toContain('right-0');
    expect(panel.className).toContain('h-screen');
    expect(panel.className).toContain('rounded-tl-[32px]');
    expect(panel.className).toContain('rounded-bl-[32px]');
    expect(panel.className).not.toMatch(/rounded-tr|rounded-br/);
  });

  it('Esc e overlay chamam onClose (após a animação de 300 ms); não há botão X', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(
        <SidePanelShell ariaLabel="x" onClose={onClose} testId="painel">
          <p>conteúdo</p>
        </SidePanelShell>,
      );
      expect(screen.queryByRole('button')).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('painel-backdrop'));
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DdMmDateInput', () => {
  it('mostra dd/mm/aaaa (es-AR) e UM só ícone de calendário; o <input type=date> nativo fica transparente', () => {
    const onChange = vi.fn();
    const { container } = render(<DdMmDateInput value="2026-09-29" onChange={onChange} ariaLabel="Inicio" data-testid="campo" />);
    expect(screen.getByText('29/09/2026')).toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    const native = screen.getByTestId('campo');
    expect(native.className).toContain('opacity-0');
    fireEvent.change(native, { target: { value: '2026-10-05' } });
    expect(onChange).toHaveBeenCalledWith('2026-10-05');
  });

  it('formata pela STRING (sem Date): 2026-01-01 → 01/01/2026', () => {
    expect(formatDdMmYyyy('2026-01-01')).toBe('01/01/2026');
    expect(formatDdMmYyyy('')).toBe('');
  });
});
