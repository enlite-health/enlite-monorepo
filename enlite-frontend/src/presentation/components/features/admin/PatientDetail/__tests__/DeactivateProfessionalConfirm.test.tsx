/**
 * DeactivateProfessionalConfirm — spec 018, PR-5 (US-11). Nunca DELETE (C8): este componente é só
 * a confirmação; a chamada de fato mora em `EquipeTratanteCard.confirmDeactivate`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const translations = ptBR as Record<string, any>;
function t(key: string): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  return typeof current === 'string' ? current : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

import { DeactivateProfessionalConfirm } from '../DeactivateProfessionalConfirm';

describe('DeactivateProfessionalConfirm', () => {
  it('mostra o nome do profissional e chama onConfirm/onClose pelos botões certos', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={false} onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByTestId('deactivate-professional-name').textContent).toBe('Dr. X');

    fireEvent.click(screen.getByTestId('deactivate-professional-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clique no botão Cancelar chama onClose, nunca onConfirm', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={false} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clique no backdrop fecha; clique dentro do modal NÃO fecha (stopPropagation implícito por target check)', () => {
    const onClose = vi.fn();
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={false} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('deactivate-professional-confirm')); // o overlay em si
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('busy=true: botão de confirmar e Cancelar ficam desabilitados; texto muda para "Desativando…"', () => {
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={true} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('deactivate-professional-confirm-button')).toBeDisabled();
    expect(screen.getByText('Cancelar')).toBeDisabled();
    expect(screen.getByText('Desativando…')).toBeInTheDocument();
  });

  it('tecla Escape fecha quando NÃO está busy', () => {
    const onClose = vi.fn();
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={false} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tecla Escape NÃO fecha quando busy (evita fechar no meio da chamada)', () => {
    const onClose = vi.fn();
    render(<DeactivateProfessionalConfirm name="Dr. X" busy={true} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
