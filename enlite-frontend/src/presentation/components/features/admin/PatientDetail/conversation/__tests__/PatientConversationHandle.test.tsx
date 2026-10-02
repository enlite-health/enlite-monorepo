/**
 * PatientConversationHandle — testes unitários (spec 022, Bloco 2, T208/T209).
 *
 * Cobre:
 *   - sem a célula `patient_conversation:read`, o handle NÃO existe no DOM (ausência, não
 *     desabilitado) — a régua é do `ContainerGate` (D286), aqui só provamos a composição;
 *   - com a célula, o handle aparece e o badge mostra o `unreadCount` que o SERVIDOR devolve
 *     (conserto do achado médio do gate do B2 — `evidencias/b2-gate-pr.md` — este componente
 *     nunca mais recalcula localmente);
 *   - conserto do achado médio "polling desperdiçado" (mesmo gate): o badge NUNCA chama
 *     `getConversationReplies` — antes eram `1 + N` chamadas por tick, uma por thread com
 *     atividade recente, pra sempre; agora é sempre 1 (só `getConversation`);
 *   - abrir o painel chama `markConversationRead` (persiste no servidor — sem isso o badge
 *     voltaria a contar o que a operadora já viu) e zera o badge na tela;
 *   - Esc/rascunho (T216/T220) continuam intactos.
 *
 * `AdminConversationApiService` é mockado — é o service de outro agente (T206/T207), aqui só
 * consumido pela interface pública dos 7 métodos do contrato.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { ContainerGate } from '@presentation/components/features/access';
import type { AuthzContract } from '@domain/entities/Authz';
import {
  AdminConversationApiService,
  type ConversationListResult,
  type ConversationMessage,
} from '@infrastructure/http/AdminConversationApiService';
import { PatientConversationHandle } from '../PatientConversationHandle';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    getConversation: vi.fn(),
    getConversationReplies: vi.fn(),
    // Este componente agora RENDERIZA `ConversationPanel` dentro do próprio `SlideOverPanel`
    // (decisão de integração T1) — `ConversationPanel` carrega `MessageComposer` (lazy) quando
    // o painel abre, que consome estes 2 métodos mesmo sem nenhum teste aqui digitar/enviar.
    searchStaffDirectory: vi.fn().mockResolvedValue([]),
    postConversationMessage: vi.fn().mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' }),
    // Conserto do achado médio (badge server-driven): `handleOpen` agora persiste a leitura.
    markConversationRead: vi.fn().mockResolvedValue(undefined),
  },
}));

const MY_UID = 'staff-eu';
const OTHER_UID = 'staff-outro';
const POLL_MS = 5000; // espelha o intervalo interno do componente (usePolling)

const contrato = (permissions: string[]): AuthzContract => ({
  uid: MY_UID,
  tenantId: 't1',
  status: 'ACTIVE',
  permissions,
  countries: ['AR'],
  groups: [],
  features: {},
  enforcement: 'on',
});

function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: 'm1',
    authorUid: OTHER_UID,
  authorDisplayName: null,
    body: 'msg-1',
    createdAt: '2026-09-21T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    mentions: [],
    mentionDisplayNames: {},
    replyCount: 0,
    lastReplyAt: null,
    attachments: [],
    ...overrides,
  };
}

/** Forma completa de `GET .../conversation` (Bloco 2 acrescentou `lastReadAt`/`unreadCount`,
 * contrato `openapi-conversation.md` linha 33/34) — default "zero não lidas". */
function conversationResult(overrides: Partial<ConversationListResult> = {}): ConversationListResult {
  return {
    conversationId: 'c1',
    messages: [],
    nextCursor: null,
    lastReadAt: null,
    unreadCount: 0,
    ...overrides,
  };
}

function renderHandle(): ReturnType<typeof render> {
  return render(
    <ContainerGate resource="patient_conversation">
      <PatientConversationHandle patientId="p1" />
    </ContainerGate>,
  );
}

describe('PatientConversationHandle (spec 022, T208/T209)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue(conversationResult());
    vi.mocked(AdminConversationApiService.getConversationReplies).mockResolvedValue([]);
    vi.mocked(AdminConversationApiService.markConversationRead).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('🔴 sem a célula: o handle NÃO existe no DOM', () => {
    useAdminAuthStore.setState({ authz: contrato([]), authzStatus: 'ready' });
    renderHandle();
    expect(screen.queryByTestId('patient-conversation-handle-btn')).not.toBeInTheDocument();
  });

  it('com a célula: o handle aparece', () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    renderHandle();
    expect(screen.getByTestId('patient-conversation-handle-btn')).toBeInTheDocument();
  });

  it('badge mostra o unreadCount devolvido pelo servidor — nunca recalcula (conserto DEFEITO 2)', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue(
      conversationResult({ unreadCount: 2, messages: [msg({ id: 'm1' }), msg({ id: 'm2' })] }),
    );
    renderHandle();

    expect(screen.queryByTestId('patient-conversation-handle-badge')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    // O valor vem PRONTO do servidor (`unreadCount`, `getReadState` — já exclui a própria
    // mensagem do ator e já soma topo+replies numa query só, D-10/D-11): o componente só exibe.
    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('2');
  });

  it('DEFEITO 3 (conserto): o badge NUNCA busca replies — 1 chamada por tick, mesmo com N threads'
    + ' com atividade recente (antes: 1+N por tick, pra sempre; agora: sempre 1)', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    // 3 threads de TOPO, todas com reply recentíssima — no código ANTIGO (baseline local
    // `new Date(0)`), cada uma satisfazia `lastReplyAt > baseline` e disparava 1 GET de replies
    // PRÓPRIO a cada tick, pra sempre (1 + 3 = 4 chamadas de rede por tick).
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue(
      conversationResult({
        unreadCount: 5,
        messages: [
          msg({ id: 'root1', replyCount: 2, lastReplyAt: '2026-09-21T10:05:00.000Z' }),
          msg({ id: 'root2', replyCount: 1, lastReplyAt: '2026-09-21T10:06:00.000Z' }),
          msg({ id: 'root3', replyCount: 3, lastReplyAt: '2026-09-21T10:07:00.000Z' }),
        ],
      }),
    );
    renderHandle();

    // 3 ticks de poll — ANTES: 3 * (1 + 3) = 12 chamadas de rede no total (4 por tick). DEPOIS:
    // 3 * 1 = 3 (só `getConversation`, nunca `getConversationReplies`).
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    expect(AdminConversationApiService.getConversationReplies).not.toHaveBeenCalled();
    expect(AdminConversationApiService.getConversation).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('5');
  });

  it('clique no handle abre o painel (SlideOverPanel translate-x-0), zera o badge e persiste a leitura', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue(
      conversationResult({ unreadCount: 1, messages: [msg({ id: 'm1', authorUid: OTHER_UID })] }),
    );
    renderHandle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('1');

    const panel = screen.getByTestId('patient-conversation-panel');
    expect(panel.className).toContain('translate-x-full');

    fireEvent.click(screen.getByTestId('patient-conversation-handle-btn'));

    expect(panel.className).toContain('translate-x-0');
    expect(screen.queryByTestId('patient-conversation-handle-badge')).not.toBeInTheDocument();
    // Conserto: sem isto, o próximo GET devolveria o MESMO unreadCount de antes de abrir.
    expect(AdminConversationApiService.markConversationRead).toHaveBeenCalledWith('p1');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel.className).toContain('translate-x-full');
  });

  it('T216/T220: composer com rascunho — Esc pede confirmação (não fecha direto); cancelar preserva painel e texto; confirmar fecha de verdade', async () => {
    // Timers reais nesta prova: `userEvent.type` no editor TipTap (contenteditable) não convive
    // bem com fake timers, e o polling do badge não é o que este teste mede.
    vi.useRealTimers();
    // `:create` além de `:read` — este teste escreve no compositor (conserto DEFEITO 1 gateia
    // por `useActionGate('patient_conversation', 'create')`; só `:read` esconderia o campo).
    useAdminAuthStore.setState({
      authz: contrato(['patient_conversation:read', 'patient_conversation:create']),
      authzStatus: 'ready',
    });
    renderHandle();

    fireEvent.click(screen.getByTestId('patient-conversation-handle-btn'));

    const editor = await screen.findByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'rascunho de teste');
    expect(editor).toHaveTextContent('rascunho de teste');

    const panel = screen.getByTestId('patient-conversation-panel');

    // Esc — pede confirmação em vez de fechar direto (achado T216/T220, `evidencias/achados.md`).
    fireEvent.keyDown(document, { key: 'Escape' });
    const confirmDialog = await screen.findByTestId('composer-discard-confirm');
    expect(confirmDialog).toBeInTheDocument();
    expect(panel.className).toContain('translate-x-0'); // painel continua aberto
    expect(editor).toHaveTextContent('rascunho de teste'); // texto intacto

    // "Cancelar" — mantém o painel aberto, texto intacto, sem descartar nada.
    fireEvent.click(screen.getByTestId('composer-discard-cancel'));
    expect(screen.queryByTestId('composer-discard-confirm')).not.toBeInTheDocument();
    expect(panel.className).toContain('translate-x-0');
    expect(editor).toHaveTextContent('rascunho de teste');

    // Pede de novo e confirma o descarte — SÓ agora fecha de verdade.
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByTestId('composer-discard-confirm');
    fireEvent.click(screen.getByTestId('composer-discard-confirm-btn'));
    expect(panel.className).toContain('translate-x-full');
  });

  it('T220: botão X do painel passa pelo MESMO gate de descarte que o Esc', async () => {
    vi.useRealTimers();
    useAdminAuthStore.setState({
      authz: contrato(['patient_conversation:read', 'patient_conversation:create']),
      authzStatus: 'ready',
    });
    renderHandle();

    fireEvent.click(screen.getByTestId('patient-conversation-handle-btn'));

    const editor = await screen.findByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'rascunho via X');
    expect(editor).toHaveTextContent('rascunho via X');

    fireEvent.click(screen.getByTestId('patient-conversation-panel-close-btn'));
    const confirmDialog = await screen.findByTestId('composer-discard-confirm');
    expect(confirmDialog).toBeInTheDocument();

    const panel = screen.getByTestId('patient-conversation-panel');
    expect(panel.className).toContain('translate-x-0');
    expect(editor).toHaveTextContent('rascunho via X');
  });

  it('sem authz carregado, não quebra (componente não depende de authz — só o badge do servidor)', () => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    render(<PatientConversationHandle patientId="p1" />);
    expect(screen.getByTestId('patient-conversation-handle-btn')).toBeInTheDocument();
  });

  it('T413 (deep-link do sino): focusRequest com code="conversation" abre o painel sozinho, sem clique', () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    const { rerender } = render(
      <PatientConversationHandle patientId="p1" focusRequest={null} />,
    );

    const panel = screen.getByTestId('patient-conversation-panel');
    expect(panel.className).toContain('translate-x-full');

    rerender(<PatientConversationHandle patientId="p1" focusRequest={{ code: 'conversation', token: 1 }} />);

    expect(panel.className).toContain('translate-x-0');
    expect(AdminConversationApiService.markConversationRead).toHaveBeenCalledWith('p1');
  });

  it('T413: focusRequest de OUTRO code (ex.: checklist) nunca abre o painel de conversa', () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    render(<PatientConversationHandle patientId="p1" focusRequest={{ code: 'coberturaMedica', token: 1 }} />);

    const panel = screen.getByTestId('patient-conversation-panel');
    expect(panel.className).toContain('translate-x-full');
  });

  it('falha silenciosa no poll: badge não quebra, mantém o valor anterior', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockRejectedValue(new Error('network'));
    renderHandle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    // não quebrou o componente, e sem contagem prévia o badge continua ausente (não é canal de alerta).
    expect(screen.getByTestId('patient-conversation-handle-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-conversation-handle-badge')).not.toBeInTheDocument();
  });
});
