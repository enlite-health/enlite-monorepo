/**
 * PatientConversationHandle — testes unitários (spec 022, Bloco 2, T208/T209).
 *
 * Cobre:
 *   - sem a célula `patient_conversation:read`, o handle NÃO existe no DOM (ausência, não
 *     desabilitado) — a régua é do `ContainerGate` (D286), aqui só provamos a composição;
 *   - com a célula, o handle aparece e o badge mostra a contagem de não lidas (topo + replies);
 *   - mensagem cujo `authorUid` é o do próprio ator logado NUNCA entra na contagem;
 *   - clique no handle abre o `SlideOverPanel` (via `usePolling`, avançando fake timers para
 *     provar que o badge atualiza entre polls).
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
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
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
    body: 'msg-1',
    createdAt: '2026-09-21T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    mentions: [],
    replyCount: 0,
    lastReplyAt: null,
    attachments: [],
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
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue({
      conversationId: 'c1',
      messages: [],
      nextCursor: null,
    });
    vi.mocked(AdminConversationApiService.getConversationReplies).mockResolvedValue([]);
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

  it('badge mostra a contagem de mensagens de topo não lidas, de outro autor', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue({
      conversationId: 'c1',
      messages: [
        msg({ id: 'm1', authorUid: OTHER_UID, createdAt: '2026-09-21T10:00:00.000Z' }),
        msg({ id: 'm2', authorUid: OTHER_UID, createdAt: '2026-09-21T10:00:01.000Z' }),
      ],
      nextCursor: null,
    });
    renderHandle();

    expect(screen.queryByTestId('patient-conversation-handle-badge')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('2');
  });

  it('mensagem do PRÓPRIO ator logado nunca entra na contagem do badge', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue({
      conversationId: 'c1',
      messages: [
        msg({ id: 'm1', authorUid: MY_UID, createdAt: '2026-09-21T10:00:00.000Z' }), // minha — não conta
        msg({ id: 'm2', authorUid: OTHER_UID, createdAt: '2026-09-21T10:00:01.000Z' }), // conta
      ],
      nextCursor: null,
    });
    renderHandle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('1');
  });

  it('conta também replies não lidas de outro autor (topo + replies, D-10)', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue({
      conversationId: 'c1',
      messages: [
        msg({
          id: 'root1',
          authorUid: MY_UID,
          createdAt: '2026-09-21T09:00:00.000Z',
          replyCount: 2,
          lastReplyAt: '2026-09-21T10:05:00.000Z',
        }),
      ],
      nextCursor: null,
    });
    vi.mocked(AdminConversationApiService.getConversationReplies).mockResolvedValue([
      msg({ id: 'r1', authorUid: OTHER_UID, createdAt: '2026-09-21T10:05:00.000Z' }), // conta
      msg({ id: 'r2', authorUid: MY_UID, createdAt: '2026-09-21T10:04:00.000Z' }), // minha — não conta
    ]);
    renderHandle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByTestId('patient-conversation-handle-badge')).toHaveTextContent('1');
    expect(AdminConversationApiService.getConversationReplies).toHaveBeenCalledWith('p1', 'root1');
  });

  it('clique no handle abre o painel (SlideOverPanel translate-x-0) e zera o badge', async () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
    vi.mocked(AdminConversationApiService.getConversation).mockResolvedValue({
      conversationId: 'c1',
      messages: [msg({ id: 'm1', authorUid: OTHER_UID, createdAt: '2026-09-21T10:00:00.000Z' })],
      nextCursor: null,
    });
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

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel.className).toContain('translate-x-full');
  });

  it('T216/T220: composer com rascunho — Esc pede confirmação (não fecha direto); cancelar preserva painel e texto; confirmar fecha de verdade', async () => {
    // Timers reais nesta prova: `userEvent.type` no editor TipTap (contenteditable) não convive
    // bem com fake timers, e o polling do badge não é o que este teste mede.
    vi.useRealTimers();
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
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
    useAdminAuthStore.setState({ authz: contrato(['patient_conversation:read']), authzStatus: 'ready' });
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

  it('sem authz carregado, não quebra (uid cai no fallback vazio)', () => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    render(<PatientConversationHandle patientId="p1" />);
    expect(screen.getByTestId('patient-conversation-handle-btn')).toBeInTheDocument();
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
