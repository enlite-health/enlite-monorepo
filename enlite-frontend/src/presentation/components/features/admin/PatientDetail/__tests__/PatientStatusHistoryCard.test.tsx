/**
 * PatientStatusHistoryCard — a aba Historial (spec 012, US-B7): quando / de → para / origem,
 * lendo GET /patients/:id/status-history. Sem "quem" (lex C7.2) e nunca a nota (C7.3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const getPatientStatusHistory = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getPatientStatusHistory: (...a: unknown[]) => getPatientStatusHistory(...a) },
}));

import { PatientStatusHistoryCard } from '../PatientStatusHistoryCard';

describe('PatientStatusHistoryCard', () => {
  beforeEach(() => getPatientStatusHistory.mockReset());

  it('lista quando / de→para / origem, traduzindo estados e origem; sem coluna de ator', async () => {
    getPatientStatusHistory.mockResolvedValue([
      { from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel', at: '2026-09-03T14:00:00.000Z' },
      { from: null, to: 'ACTIVE', source: 'insert', at: '2026-09-01T10:00:00.000Z' },
    ]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    await waitFor(() => expect(screen.getByTestId('status-history-row-0')).toBeInTheDocument());
    expect(getPatientStatusHistory).toHaveBeenCalledWith('p1');
    const row0 = screen.getByTestId('status-history-row-0');
    expect(row0).toHaveTextContent('Ativo');
    expect(row0).toHaveTextContent('Em espera');
    expect(row0).toHaveTextContent('Painel');
    const row1 = screen.getByTestId('status-history-row-1');
    expect(row1).toHaveTextContent('—');
    expect(row1).toHaveTextContent('Criação');
    expect(screen.queryByText(/quem|ator|uid/i)).not.toBeInTheDocument();
    expect(screen.getByText('Quando')).toBeInTheDocument();
  });

  it('origem desconhecida cai no valor cru; estado desconhecido idem', async () => {
    getPatientStatusHistory.mockResolvedValue([{ from: 'FOO', to: 'BAR', source: 'migration-314', at: '2026-09-03T14:00:00.000Z' }]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    const row = await screen.findByTestId('status-history-row-0');
    expect(row).toHaveTextContent('FOO');
    expect(row).toHaveTextContent('BAR');
    expect(row).toHaveTextContent('migration-314');
  });

  it('vazio → "sem dados"; erro → mensagem', async () => {
    getPatientStatusHistory.mockResolvedValueOnce([]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    expect(await screen.findByTestId('status-history-empty')).toBeInTheDocument();
    getPatientStatusHistory.mockRejectedValueOnce(new Error('boom'));
    render(<PatientStatusHistoryCard patientId="p2" />);
    expect(await screen.findByTestId('status-history-error')).toHaveTextContent('boom');
    getPatientStatusHistory.mockRejectedValueOnce('x');
    render(<PatientStatusHistoryCard patientId="p3" />);
    await waitFor(() => expect(screen.getAllByTestId('status-history-error')).toHaveLength(2));
  });

  it('origem nula → —; formatação de data que lança cai no ISO', async () => {
    getPatientStatusHistory.mockResolvedValue([{ from: null, to: 'ACTIVE', source: null, at: '2026-09-03T14:00:00.000Z' }]);
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => { throw new RangeError('locale'); });
    try {
      render(<PatientStatusHistoryCard patientId="p9" />);
      const row = await screen.findByTestId('status-history-row-0');
      expect(row).toHaveTextContent('2026-09-03T14:00:00.000Z');
      expect(row.textContent?.split('—').length).toBeGreaterThanOrEqual(3);
    } finally { spy.mockRestore(); }
  });
});
