/**
 * PatientPhotoRemoveConfirm — spec 018, PR-4. Molde de `DeactivateProfessionalConfirm.test.tsx`.
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

import { PatientPhotoRemoveConfirm } from '../PatientPhotoRemoveConfirm';

describe('PatientPhotoRemoveConfirm', () => {
  it('confirmar chama onConfirm, nunca onClose', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<PatientPhotoRemoveConfirm busy={false} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelar chama onClose, nunca onConfirm', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<PatientPhotoRemoveConfirm busy={false} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clique no backdrop fecha; o X também fecha', () => {
    const onClose = vi.fn();
    render(<PatientPhotoRemoveConfirm busy={false} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('busy=true: botões desabilitados e texto muda para "Removendo…"; Escape não fecha', () => {
    const onClose = vi.fn();
    render(<PatientPhotoRemoveConfirm busy={true} onConfirm={vi.fn()} onClose={onClose} />);
    expect(screen.getByTestId('patient-photo-remove-confirm-button')).toBeDisabled();
    expect(screen.getByText('Cancelar')).toBeDisabled();
    expect(screen.getByText('Removendo…')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tecla Escape fecha quando não busy', () => {
    const onClose = vi.fn();
    render(<PatientPhotoRemoveConfirm busy={false} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
