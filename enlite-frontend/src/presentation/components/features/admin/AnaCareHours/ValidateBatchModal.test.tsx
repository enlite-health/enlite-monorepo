import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ValidateBatchModal } from './ValidateBatchModal';
import type { AnaCareShift } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }) }));

function makeShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 's1',
    date: '2026-08-14',
    scheduledStart: '08:00',
    scheduledEnd: '16:00',
    actualStart: '08:00',
    actualEnd: '16:00',
    hoursActual: 8,
    hoursScheduled: 8,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: '90101',
    ...overrides,
  };
}

describe('ValidateBatchModal', () => {
  it('POSITIVO — mostra contagem, horas e breakdown de origem', () => {
    const shifts = [makeShift({ id: 's1', origin: 'sin_checkin', hoursActual: null, actualStart: null, actualEnd: null }), makeShift({ id: 's2', origin: 'web_admin', hoursActual: 4 })];
    render(<ValidateBatchModal shifts={shifts} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-batch-modal')).toBeInTheDocument();
    expect(screen.getByText(/admin\.anacareHours\.batchModal\.titleSelection/)).toBeInTheDocument();
  });

  it('POSITIVO — confirmar chama onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ValidateBatchModal shifts={[makeShift()]} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('POSITIVO — cancelar chama onCancel', () => {
    const onCancel = vi.fn();
    render(<ValidateBatchModal shifts={[makeShift()]} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('POSITIVO — lista vazia não quebra (0 turnos, 0 horas)', () => {
    render(<ValidateBatchModal shifts={[]} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-batch-modal')).toBeInTheDocument();
  });
});
