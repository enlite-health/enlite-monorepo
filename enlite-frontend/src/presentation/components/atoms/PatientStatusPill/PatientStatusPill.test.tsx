import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PatientStatusPill } from './PatientStatusPill';

const tMock = vi.fn((key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

describe('PatientStatusPill — o estado do paciente vem pronto da resposta e o rótulo é o da coluna do Kanban', () => {
  it('com estado → pede a chave i18n da coluna do Kanban de pacientes (um vocabulário só)', () => {
    render(<PatientStatusPill status="SEARCHING" />);
    expect(tMock).toHaveBeenCalledWith('admin.patients.kanban.columns.SEARCHING', { defaultValue: 'SEARCHING' });
    expect(screen.getByTestId('patient-status-pill')).toHaveAttribute('data-patient-status', 'SEARCHING');
  });

  it('sem estado (null = sem célula, ou sem paciente) → "—"', () => {
    render(<PatientStatusPill status={null} />);
    expect(screen.getByTestId('patient-status-pill')).toHaveTextContent('—');
    expect(screen.getByTestId('patient-status-pill')).toHaveAttribute('data-patient-status', '');
  });

  it('chave sem tradução cai no próprio código (nunca some)', () => {
    render(<PatientStatusPill status="ALGO_NOVO" />);
    expect(screen.getByTestId('patient-status-pill')).toHaveTextContent('ALGO_NOVO');
  });
});
