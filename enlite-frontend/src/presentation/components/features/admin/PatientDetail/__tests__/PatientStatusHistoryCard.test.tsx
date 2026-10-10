/**
 * PatientStatusHistoryCard — a aba Historial (spec 012, US-B7): quando / de → para / origem /
 * motivo / autor, lendo GET /patients/:id/status-history. Motivo e autor entraram na migration
 * 486 (decisão do Gabriel 29/09/2026) — substitui o "sem quem" de C7.2. Nunca a nota (C7.3).
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

  it('lista quando / de→para / origem / motivo / autor, traduzindo estados, origem e motivo', async () => {
    getPatientStatusHistory.mockResolvedValue([
      { from: 'SUSPENDED', to: 'SEARCHING', source: 'admin_panel', at: '2026-09-03T14:00:00.000Z', reason: 'RESUMED_SERVICE', actorUid: 'uid-abc123' },
      { from: null, to: 'ACTIVE', source: 'insert', at: '2026-09-01T10:00:00.000Z', reason: null, actorUid: null },
    ]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    await waitFor(() => expect(screen.getByTestId('status-history-row-0')).toBeInTheDocument());
    expect(getPatientStatusHistory).toHaveBeenCalledWith('p1');
    const row0 = screen.getByTestId('status-history-row-0');
    expect(row0).toHaveTextContent('Suspenso');
    expect(row0).toHaveTextContent('Busca');
    expect(row0).toHaveTextContent('Painel');
    expect(row0).toHaveTextContent('Retomou o serviço (fim de férias/internação)');
    expect(row0).toHaveTextContent('uid-abc123');
    const row1 = screen.getByTestId('status-history-row-1');
    expect(row1).toHaveTextContent('—'); // from nulo
    expect(row1).toHaveTextContent('Criação');
    expect(screen.getByTestId('status-history-reason-1')).toHaveTextContent('—');
    expect(screen.getByTestId('status-history-actor-1')).toHaveTextContent('—');
    expect(screen.getByText('Quando')).toBeInTheDocument();
    expect(screen.getByText('Motivo')).toBeInTheDocument();
    expect(screen.getByText('Autor')).toBeInTheDocument();
  });

  // Spec 051 (§4): a troca fora do fluxo grava `*_override`; o Historial a mostra traduzida, deixando
  // claro que foi fora do fluxo — e NUNCA como o valor cru do banco.
  // Quem só enxerga a aba Historial (patient:read sem as outras) a tem aberta DESDE o carregamento: a troca de
  // estado sai com a aba já montada, e a lista tem de ser relida (achado do CI #672, e2e feliz).
  it('refreshKey novo (o estado mudou) relê a lista com a aba já aberta', async () => {
    getPatientStatusHistory.mockResolvedValueOnce([{ from: null, to: 'ACTIVE', source: 'insert', at: '2026-10-10T10:00:00.000Z', reason: null, actorUid: null }]);
    const { rerender } = render(<PatientStatusHistoryCard patientId="p1" refreshKey="ACTIVE" />);
    await screen.findByTestId('status-history-row-0');
    getPatientStatusHistory.mockResolvedValueOnce([
      { from: 'ACTIVE', to: 'SEARCHING', source: 'admin_panel_override', at: '2026-10-10T11:00:00.000Z', reason: null, actorUid: 'uid-a' },
      { from: null, to: 'ACTIVE', source: 'insert', at: '2026-10-10T10:00:00.000Z', reason: null, actorUid: null },
    ]);
    rerender(<PatientStatusHistoryCard patientId="p1" refreshKey="SEARCHING" />);
    await waitFor(() => expect(screen.getByTestId('status-history-row-1')).toBeInTheDocument());
    expect(getPatientStatusHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('status-history-row-0')).toHaveTextContent('Painel (fora do fluxo)');
  });

  it('origem *_override aparece traduzida como "fora do fluxo" (painel e Kanban), não como valor cru', async () => {
    getPatientStatusHistory.mockResolvedValue([
      { from: 'ACTIVE', to: 'SEARCHING', source: 'admin_panel_override', at: '2026-10-10T14:00:00.000Z', reason: null, actorUid: 'uid-a' },
      { from: 'ACTIVE', to: 'ALTA', source: 'kanban_override', at: '2026-10-10T15:00:00.000Z', reason: null, actorUid: 'uid-b' },
    ]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    const row0 = await screen.findByTestId('status-history-row-0');
    expect(row0).toHaveTextContent('Painel (fora do fluxo)');
    expect(row0).not.toHaveTextContent('admin_panel_override');
    const row1 = screen.getByTestId('status-history-row-1');
    expect(row1).toHaveTextContent('Kanban (fora do fluxo)');
    expect(row1).not.toHaveTextContent('kanban_override');
  });

  it('origem desconhecida cai no valor cru; estado e motivo desconhecidos idem', async () => {
    getPatientStatusHistory.mockResolvedValue([{ from: 'FOO', to: 'BAR', source: 'migration-314', at: '2026-09-03T14:00:00.000Z', reason: 'MOTIVO_CRU', actorUid: 'uid-xyz' }]);
    render(<PatientStatusHistoryCard patientId="p1" />);
    const row = await screen.findByTestId('status-history-row-0');
    expect(row).toHaveTextContent('FOO');
    expect(row).toHaveTextContent('BAR');
    expect(row).toHaveTextContent('migration-314');
    expect(row).toHaveTextContent('MOTIVO_CRU');
    expect(row).toHaveTextContent('uid-xyz');
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

  it('origem nula → —; data inválida cai no valor cru', async () => {
    getPatientStatusHistory.mockResolvedValue([{ from: null, to: 'ACTIVE', source: null, at: 'não-é-data' }]);
    render(<PatientStatusHistoryCard patientId="p9" />);
    const row = await screen.findByTestId('status-history-row-0');
    expect(row).toHaveTextContent('não-é-data');
    expect(row.textContent?.split('—').length).toBeGreaterThanOrEqual(3);
  });

  it('QUANDO sai em -03 e 24h, não no fuso do navegador (14:00Z = 11:00)', async () => {
    getPatientStatusHistory.mockResolvedValue([{ from: null, to: 'ACTIVE', source: null, at: '2026-09-03T22:00:00.000Z' }]);
    render(<PatientStatusHistoryCard patientId="p10" />);
    const row = await screen.findByTestId('status-history-row-0');
    expect(row.textContent).toContain('19:00');
    expect(row.textContent).not.toMatch(/[ap]\. ?m\./i);
  });
});
