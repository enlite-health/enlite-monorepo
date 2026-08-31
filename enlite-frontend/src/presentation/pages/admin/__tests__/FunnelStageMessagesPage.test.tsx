/**
 * FunnelStageMessagesPage.test.tsx — a página de "mensagens por etapa" (DEC-12).
 * O que se afirma: as 9 etapas, a célula de UMA LINHA com o texto da mensagem,
 * QUALIFIED built-in, a modal de escolha (admin salva, recruiter só lê), erro
 * que fica na modal, recarga depois do PUT.
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
  // COMPLETED: editado por Gabi; SELECTED: editado por usuário já removido (updatedBy null, updatedAt presente → "—")
  stages: STAGES.map((stage) => ({ stage, templateSlug: stage === 'COMPLETED' ? 'ok_tpl' : null, enabled: stage === 'COMPLETED', channel: 'whatsapp', builtin: stage === 'QUALIFIED' ? 'interview_invite' : null, updatedBy: stage === 'COMPLETED' ? 'Gabi' : null, updatedAt: stage === 'COMPLETED' || stage === 'SELECTED' ? '2026-08-29T12:00:00Z' : null })),
  templates: [
    { slug: 'ok_tpl', name: 'Ok', body: 'Caso {{case_number}} confirmado', bodyTwilio: 'Caso {{1}} confirmado', category: 'UTILITY', eligible: true, reason: null, placeholders: ['case_number'], unsupported: [] },
    { slug: 'sin_texto', name: 'Sin', body: '(ver Twilio Content Builder: HX54d6)', bodyTwilio: null, category: 'UTILITY', eligible: true, reason: null, placeholders: [], unsupported: [] },
    { slug: 'mkt', name: 'Mkt', body: 'x', bodyTwilio: null, category: 'MARKETING', eligible: false, reason: 'CATEGORY', placeholders: [], unsupported: [] },
    { slug: 'pos', name: 'Pos', body: 'Hola {{1}}', bodyTwilio: null, category: 'UTILITY', eligible: false, reason: 'PLACEHOLDERS', placeholders: ['1'], unsupported: ['1'] },
  ],
});

describe('FunnelStageMessagesPage', () => {
  beforeEach(() => { vi.clearAllMocks(); role = 'admin'; mockGet.mockResolvedValue(config()); mockPut.mockResolvedValue({}); });

  it('lista as 9 etapas; QUALIFIED é built-in; a célula mostra o TEXTO da mensagem (não o slug) e o estado; última edição', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    for (const s of STAGES) expect(screen.getByTestId(`fsm-row-${s}`)).toBeInTheDocument();
    expect(screen.getByTestId('fsm-row-QUALIFIED')).toHaveTextContent('admin.funnelStageMessages.builtin');
    expect(screen.queryByTestId('fsm-template-QUALIFIED')).toBeNull();

    // O que identifica a mensagem é o texto, com as variáveis já em valor de exemplo.
    expect(screen.getByTestId('fsm-template-COMPLETED')).toHaveTextContent('«Caso CASO 1042 confirmado»');
    expect(screen.getByTestId('fsm-template-INVITED')).toHaveTextContent('admin.funnelStageMessages.none');
    expect(screen.getByTestId('fsm-enabled-COMPLETED')).toHaveTextContent('admin.funnelStageMessages.stateOn');
    expect(screen.getByTestId('fsm-enabled-INVITED')).toHaveTextContent('admin.funnelStageMessages.stateOff');
    expect(screen.getByTestId('fsm-row-COMPLETED')).toHaveTextContent('Gabi');
    expect(screen.getByTestId('fsm-row-COMPLETED')).toHaveTextContent(/2026/);
    expect(screen.getByTestId('fsm-row-SELECTED')).toHaveTextContent('—');
    expect(screen.getByTestId('fsm-row-INVITED')).toHaveTextContent('admin.funnelStageMessages.never');
    expect(screen.queryByTestId('fsm-admin-only')).toBeNull();
    // Sem template escolhido não há o que espiar.
    expect(screen.queryByTestId('fsm-peek-INVITED')).toBeNull();
  });

  it('linha com template cujo texto não veio: mostra o aviso e o slug, nunca o corpo-ponteiro', async () => {
    mockGet.mockResolvedValue({ ...config(), stages: config().stages.map((s) => (s.stage === 'INVITED' ? { ...s, templateSlug: 'sin_texto' } : s)) });
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    const cell = screen.getByTestId('fsm-template-INVITED');
    expect(cell).toHaveTextContent('admin.funnelStageMessages.picker.noText');
    expect(cell).toHaveTextContent('sin_texto');
    expect(cell).not.toHaveTextContent('Content Builder');
  });

  it('admin: abre a modal, escolhe, liga e salva → PUT com o corpo certo, modal fecha, recarrega', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fsm-open-INVITED'));

    const activate = screen.getByTestId('fsm-modal-enabled') as HTMLInputElement;
    expect(activate.disabled).toBe(true); // sem mensagem escolhida não liga
    fireEvent.click(screen.getByTestId('fsm-option-ok_tpl'));
    expect(activate.disabled).toBe(false);
    fireEvent.click(activate);
    fireEvent.click(screen.getByTestId('fsm-modal-save'));

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('INVITED', { templateSlug: 'ok_tpl', enabled: true }));
    await waitFor(() => expect(screen.queryByTestId('fsm-modal')).toBeNull());
    expect(screen.getByTestId('fsm-saved-INVITED')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('admin: desmarcar a mensagem escolhida manda null e desliga', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fsm-open-COMPLETED'));
    fireEvent.click(screen.getByTestId('fsm-option-ok_tpl')); // já selecionado → desmarca
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('COMPLETED', { templateSlug: null, enabled: false }));
  });

  it('erro do backend fica NA MODAL, que não fecha (Error e não-Error)', async () => {
    mockPut.mockRejectedValueOnce(new Error('Template not eligible'));
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fsm-open-COMPLETED'));
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    await waitFor(() => expect(screen.getByTestId('fsm-modal-error')).toHaveTextContent('Template not eligible'));
    expect(screen.getByTestId('fsm-modal')).toBeInTheDocument();

    mockPut.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    await waitFor(() => expect(screen.getByTestId('fsm-modal-error')).toHaveTextContent('admin.funnelStageMessages.error'));
  });

  it('cancelar e Esc fecham sem gravar', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('fsm-open-INVITED'));
    fireEvent.click(screen.getByTestId('fsm-modal-cancel'));
    expect(screen.queryByTestId('fsm-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('fsm-open-INVITED'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('fsm-modal')).toBeNull());

    fireEvent.click(screen.getByTestId('fsm-open-INVITED'));
    fireEvent.click(screen.getByTestId('fsm-modal-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('fsm-modal')).toBeNull());
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('recruiter: lê a mensagem pelo "Ver", mas não escolhe nem grava', async () => {
    role = 'recruiter';
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());
    expect(screen.getByTestId('fsm-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('fsm-open-INVITED')).toBeNull();

    fireEvent.click(screen.getByTestId('fsm-peek-COMPLETED'));
    expect((screen.getByTestId('fsm-modal-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('fsm-option-ok_tpl') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('fsm-modal-enabled') as HTMLInputElement).disabled).toBe(true);
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
