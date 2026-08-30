/**
 * FunnelStageMessagesPage.test.tsx — a página de "mensagens por etapa" (DEC-12).
 * O que se afirma: as 9 etapas, templates inelegíveis desabilitados com o motivo,
 * QUALIFIED built-in, recruiter só lê, admin salva (corpo do PUT), erro/salvo por linha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FunnelStageMessagesPage } from '../FunnelStageMessagesPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key) }),
}));
const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@infrastructure/http/AdminFunnelStageMessagesApiService', () => ({
  AdminFunnelStageMessagesApiService: { getFunnelStageMessages: (...a: unknown[]) => mockGet(...a), updateFunnelStageMessage: (...a: unknown[]) => mockPut(...a) },
}));
let role = 'admin';
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ adminProfile: { role }, isAuthenticated: true, isLoading: false }) }));

const STAGES = ['INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT', 'CONFIRMED', 'SELECTED', 'REJECTED'];
const config = () => ({
  country: 'AR',
  stages: STAGES.map((stage) => ({ stage, templateSlug: stage === 'COMPLETED' ? 'ok_tpl' : null, enabled: stage === 'COMPLETED', channel: 'whatsapp', builtin: stage === 'QUALIFIED' ? 'interview_invite' : null, updatedBy: stage === 'COMPLETED' ? 'Gabi' : null, updatedAt: stage === 'COMPLETED' ? '2026-08-29T12:00:00Z' : null })),
  templates: [
    { slug: 'ok_tpl', name: 'Ok', category: 'UTILITY', eligible: true, reason: null, placeholders: ['case_number'], unsupported: [] },
    { slug: 'mkt', name: 'Mkt', category: 'MARKETING', eligible: false, reason: 'CATEGORY', placeholders: [], unsupported: [] },
    { slug: 'pos', name: 'Pos', category: 'UTILITY', eligible: false, reason: null, placeholders: ['1'], unsupported: ['1'] },
  ],
});

describe('FunnelStageMessagesPage', () => {
  beforeEach(() => { vi.clearAllMocks(); role = 'admin'; mockGet.mockResolvedValue(config()); mockPut.mockResolvedValue({}); });

  it('lista as 9 etapas; QUALIFIED é built-in; templates inelegíveis vêm desabilitados com o motivo; última edição', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    for (const s of STAGES) expect(screen.getByTestId(`fsm-row-${s}`)).toBeInTheDocument();
    expect(screen.getByTestId('fsm-row-QUALIFIED')).toHaveTextContent('admin.funnelStageMessages.builtin');
    expect(screen.queryByTestId('fsm-template-QUALIFIED')).toBeNull();
    const sel = screen.getByTestId('fsm-template-COMPLETED') as HTMLSelectElement;
    expect(sel.value).toBe('ok_tpl');
    const opts = Array.from(sel.options);
    expect(opts.find((o) => o.value === 'mkt')?.disabled).toBe(true);
    expect(opts.find((o) => o.value === 'mkt')?.textContent).toContain('ineligible.CATEGORY');
    expect(opts.find((o) => o.value === 'pos')?.textContent).toContain('ineligible.PLACEHOLDERS');
    expect((screen.getByTestId('fsm-enabled-COMPLETED') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('fsm-row-COMPLETED')).toHaveTextContent('Gabi');
    expect(screen.getByTestId('fsm-row-INVITED')).toHaveTextContent('admin.funnelStageMessages.never');
    expect(screen.queryByTestId('fsm-admin-only')).toBeNull();
  });

  it('admin: escolher template, ligar e salvar → PUT com o corpo certo → "salvo" e recarrega', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    const enabled = screen.getByTestId('fsm-enabled-INVITED') as HTMLInputElement;
    expect(enabled.disabled).toBe(true); // sem template não liga
    fireEvent.change(screen.getByTestId('fsm-template-INVITED'), { target: { value: 'ok_tpl' } });
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    fireEvent.click(screen.getByTestId('fsm-save-INVITED'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('INVITED', { templateSlug: 'ok_tpl', enabled: true }));
    await waitFor(() => expect(screen.getByTestId('fsm-saved-INVITED')).toBeInTheDocument());
    expect(mockGet).toHaveBeenCalledTimes(2);
    // limpar o template desliga e manda null
    fireEvent.change(screen.getByTestId('fsm-template-INVITED'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('fsm-save-INVITED'));
    await waitFor(() => expect(mockPut).toHaveBeenLastCalledWith('INVITED', { templateSlug: null, enabled: false }));
  });

  it('erro do backend fica na linha (Error e não-Error)', async () => {
    mockPut.mockRejectedValueOnce(new Error('Template not eligible'));
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fsm-save-COMPLETED'));
    await waitFor(() => expect(screen.getByTestId('fsm-error-COMPLETED')).toHaveTextContent('Template not eligible'));
    mockPut.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('fsm-save-COMPLETED'));
    await waitFor(() => expect(screen.getByTestId('fsm-error-COMPLETED')).toHaveTextContent('admin.funnelStageMessages.error'));
  });

  it('recruiter: só lê — selects/checkbox desabilitados, sem botão salvar, aviso visível', async () => {
    role = 'recruiter';
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    expect(screen.getByTestId('fsm-admin-only')).toBeInTheDocument();
    expect((screen.getByTestId('fsm-template-INVITED') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByTestId('fsm-save-INVITED')).toBeNull();
  });

  it('falha ao carregar mostra o erro (Error e não-Error)', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-load-error')).toHaveTextContent('boom'));
    mockGet.mockRejectedValueOnce('x');
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getAllByTestId('fsm-load-error').length).toBeGreaterThan(0));
  });
});
