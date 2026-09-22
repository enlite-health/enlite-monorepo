/**
 * ConversationPanel — testes unitários (spec 022, Bloco 2, T211/T212).
 *
 * Cobre:
 *   - lista as mensagens de TOPO (autor, hora, corpo) dentro do `SlideOverPanel` não-modal;
 *   - `<@uid>` no corpo renderiza como chip — o SERVIDOR já manda `mentions` resolvidas
 *     (`tasks.md:664`); o componente só EXIBE, nunca resolve nome;
 *   - mensagem apagada (`deletedAt` preenchido, `body: ''`) mostra o estado de apagada, nunca
 *     uma linha em branco;
 *   - 403 mostra `panel.noAccess` — NUNCA lista vazia (distinguir "sem mensagem" de "sem
 *     acesso" é o ponto: lista vazia num 403 faz a tela mentir);
 *   - lista vazia (200 sem mensagens) mostra `panel.empty`;
 *   - clique em "N respostas" abre a `ThreadView` da mensagem;
 *   - poll a cada 5s usa `after=<cursor>` (só busca o novo) — nível mais alto do painel, uma
 *     única chamada por tick, não uma por item da lista.
 *
 * `AdminConversationApiService` é mockado (T206, de outro agente) — molde idêntico ao usado em
 * `PatientConversationHandle.test.tsx` (mesma pasta).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { ApiError } from '@infrastructure/http/ApiError';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { ConversationPanel } from '../ConversationPanel';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    getConversation: vi.fn(),
    getConversationReplies: vi.fn(),
    // T3 (compositor plugado): `ConversationPanel` agora renderiza `MessageComposer` (lazy) —
    // precisa dos 2 métodos que ele consome, mesmo em testes que nunca digitam/enviam nada.
    searchStaffDirectory: vi.fn().mockResolvedValue([]),
    postConversationMessage: vi.fn().mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' }),
  },
}));

/** Espelha o `t` real contra o pt-BR.json de verdade — chave errada aparece como a própria chave
 * (mesmo padrão de `PatientChatIdsCard.test.tsx`), com suporte a `{{count}}`/plural `_one`/`_other`
 * porque este painel usa `t('...thread.replies', { count })`. */
const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
function t(key: string, opts?: Record<string, unknown> | string): string {
  if (opts && typeof opts === 'object' && typeof opts.count === 'number') {
    const suffix = opts.count === 1 ? '_one' : '_other';
    const raw = resolve(`${key}${suffix}`) ?? resolve(key);
    if (typeof raw === 'string') return raw.replace('{{count}}', String(opts.count));
    return key;
  }
  const raw = resolve(key);
  if (typeof raw === 'string') return raw;
  if (typeof opts === 'string') return opts;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const PT = ptBR.admin.patients.detail.conversation;

/** Mensagem sintética — nunca texto clínico real (regra dura do CLAUDE.md/brief). */
const msg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: '11111111-1111-1111-1111-111111111111',
  authorUid: 'staff-um',
  authorDisplayName: null,
  body: 'msg-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  mentions: [],
  mentionDisplayNames: {},
  replyCount: 0,
  lastReplyAt: null,
  attachments: [],
  ...overrides,
});

const getConversation = AdminConversationApiService.getConversation as unknown as ReturnType<typeof vi.fn>;
const getConversationReplies = AdminConversationApiService.getConversationReplies as unknown as ReturnType<typeof vi.fn>;
const postConversationMessage = AdminConversationApiService.postConversationMessage as unknown as ReturnType<typeof vi.fn>;

describe('ConversationPanel', () => {
  beforeEach(() => {
    getConversation.mockReset();
    getConversationReplies.mockReset();
    getConversationReplies.mockResolvedValue([]);
    postConversationMessage.mockClear();
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('lista mensagens de topo: autor, hora e corpo', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', authorUid: 'staff-um', body: 'msg-1' })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-list')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-message-m1')).toHaveTextContent('staff-um');
    expect(screen.getByTestId('conversation-message-m1')).toHaveTextContent('msg-1');
  });

  it('corpo com <@uid> renderiza como CHIP, casado pelo UID do próprio token (não resolve nome)', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      // `mentions` é a lista de uids CONFIRMADOS pelo servidor (ordem alfabética, B1) — o
      // componente NUNCA chama uma API de resolução de nome, só confirma o uid do token.
      messages: [msg({ id: 'm1', body: 'Oi <@u-1>, olha isso', mentions: ['u-1'] })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    const chip = screen.getByTestId('mention-chip');
    expect(chip).toHaveTextContent('u-1');
    expect(getConversation).toHaveBeenCalledTimes(1); // nenhuma chamada extra pra resolver nome
  });

  it('🔒 fix (spec 022 B2): 2 menções em ordem alfabética inversa à ordem de aparição mostram o uid'
    + ' certo em cada chip (casamento por UID, não por índice)', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({
        id: 'm1',
        body: 'Oi <@u-zeta>, olha isso com <@u-alfa>',
        mentions: ['u-alfa', 'u-zeta'],
      })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    const chips = screen.getAllByTestId('mention-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('u-zeta');
    expect(chips[1]).toHaveTextContent('u-alfa');
  });

  it('mensagem apagada (deletedAt preenchido, body vazio) mostra o estado de apagada — nunca linha em branco', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', body: '', deletedAt: '2026-09-02T00:00:00.000Z' })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    const body = screen.getByTestId('conversation-message-m1').querySelector('[data-testid="message-body"]');
    expect(body?.textContent).not.toBe('');
    expect(body?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('403 mostra panel.noAccess — NUNCA lista vazia', async () => {
    getConversation.mockRejectedValue(new ApiError({ success: false, error: 'Sem acesso a este paciente', code: 'FORBIDDEN' }, 403));
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-no-access')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-panel-no-access')).toHaveTextContent(PT.panel.noAccess);
    expect(screen.queryByTestId('conversation-panel-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-panel-list')).not.toBeInTheDocument();
  });

  it('depois de cair em forbidden, o TICK do poll não chama a API de novo (early return)', async () => {
    vi.useFakeTimers();
    getConversation.mockRejectedValue(new ApiError({ success: false, error: 'Sem acesso' }, 403));
    render(<ConversationPanel patientId="p1" isOpen />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getConversation).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    // status já é 'forbidden' — o callback do usePolling devolve antes de chamar a API outra vez.
    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it('lista vazia (200 sem mensagens) mostra panel.empty', async () => {
    getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-empty')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-panel-empty')).toHaveTextContent(PT.panel.empty);
  });

  it('clique em "N respostas" abre a ThreadView da mensagem', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', replyCount: 3 })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '3 respostas' }));

    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-panel-list')).not.toBeInTheDocument();
  });

  it('"voltar" na ThreadView embutida retorna à lista de topo', async () => {
    getConversationReplies.mockResolvedValue([]);
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', replyCount: 1 })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '1 resposta' }));
    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: PT.thread.back }));
    await waitFor(() => expect(screen.getByTestId('conversation-panel-list')).toBeInTheDocument());
    expect(screen.queryByTestId('thread-view')).not.toBeInTheDocument();
  });

  it('poll com cursor NULO (conversa sem próxima página) refaz sem after — não passa "undefined" literal', async () => {
    vi.useFakeTimers();
    getConversation.mockResolvedValueOnce({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getConversation).toHaveBeenCalledTimes(1);

    getConversation.mockResolvedValueOnce({ conversationId: 'conv-1', messages: [], nextCursor: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getConversation).toHaveBeenCalledTimes(2);
    expect(getConversation.mock.calls[1][1]).toBeUndefined();
  });

  it('poll a cada 5s busca com after=<cursor> — uma chamada por tick, não uma por item', async () => {
    // `waitFor` do testing-library poll via `setTimeout` real — com fake timers isso trava
    // (achado desta task). Em vez disso, flusha microtasks com `advanceTimersByTimeAsync(0)`
    // dentro de `act`, e só avança o relógio de verdade pro tick do `usePolling`.
    vi.useFakeTimers();
    getConversation.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1' }), msg({ id: 'm2' })],
      nextCursor: 'cursor-1',
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getConversation).toHaveBeenCalledTimes(1);
    expect(getConversation.mock.calls[0][1]).toBeUndefined(); // 1ª carga: sem `after`

    getConversation.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm3' })],
      nextCursor: 'cursor-2',
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getConversation).toHaveBeenCalledTimes(2);
    expect(getConversation.mock.calls[1][1]).toEqual({ after: 'cursor-1' });

    getConversation.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [],
      nextCursor: 'cursor-2',
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getConversation).toHaveBeenCalledTimes(3);
    expect(getConversation.mock.calls[2][1]).toEqual({ after: 'cursor-2' });
  });

  it('isOpen=false não busca nada (painel fechado não gasta chamada) — nem no tick do poll', async () => {
    vi.useFakeTimers();
    render(<ConversationPanel patientId="p1" isOpen={false} />);
    expect(getConversation).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    // o `usePolling` continua rodando por fora (não depende de isOpen), mas o callback devolve
    // antes de chamar a API — painel fechado nunca gasta uma chamada de rede.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('thread aberta e painel fecha (isOpen=false): compositor da reply deixa de ser montado', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', replyCount: 1 })],
      nextCursor: null,
    });
    getConversationReplies.mockResolvedValue([]);
    const { rerender } = render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '1 resposta' }));
    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    await screen.findByTestId('composer-editor'); // com isOpen=true, a reply tem compositor

    rerender(<ConversationPanel patientId="p1" isOpen={false} />);

    // painel fechado: o `openThreadId` continua em memória (Handle só translada, não desmonta),
    // mas o compositor (TipTap) para de ser montado enquanto ninguém pode escrever.
    await waitFor(() => expect(screen.queryByTestId('composer-editor')).not.toBeInTheDocument());
    expect(screen.getByTestId('thread-view')).toBeInTheDocument();
  });

  it('desmontar ANTES do GET responder (sucesso) não seta estado depois (guarda de corrida)', async () => {
    let resolveGet: (value: unknown) => void = () => {};
    getConversation.mockImplementation(() => new Promise((resolve) => { resolveGet = resolve; }));
    const { unmount } = render(<ConversationPanel patientId="p1" isOpen />);
    unmount();

    resolveGet({ conversationId: 'conv-1', messages: [msg({ id: 'm1' })], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    // chegar até aqui sem o React logar "not wrapped in act"/"unmounted component" já é a prova.
  });

  it('desmontar ANTES do GET responder (erro 403) não seta estado depois (guarda de corrida)', async () => {
    let rejectGet: (err: unknown) => void = () => {};
    getConversation.mockImplementation(() => new Promise((_resolve, reject) => { rejectGet = reject; }));
    const { unmount } = render(<ConversationPanel patientId="p1" isOpen />);
    unmount();

    rejectGet(new ApiError({ success: false, error: 'Sem acesso' }, 403));
    await Promise.resolve();
    await Promise.resolve();
  });

  // ---- T3: compositor plugado (topo e reply) ----------------------------------------------

  it('compositor de topo: enviar chama o service, limpa o editor e a lista busca de novo (sem esperar o poll)', async () => {
    getConversation.mockResolvedValueOnce({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-empty')).toBeInTheDocument());

    const editor = await screen.findByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    getConversation.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm-new', body: 'msg-1' })],
      nextCursor: null,
    });

    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledTimes(1));
    expect(postConversationMessage.mock.calls[0]).toEqual(['p1', { body: 'msg-1', rootMessageId: undefined }]);
    // busca de novo (mesmo `fetchPage` do poll) SEM esperar o tick de 5s — 1ª carga + esta.
    await waitFor(() => expect(getConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('conversation-message-m-new')).toBeInTheDocument());
    // editor voltou a ficar vazio (limpo pelo próprio `MessageComposer` após o envio).
    expect(screen.getByTestId('composer-send-btn')).toBeDisabled();
  });

  it('compositor da thread: enviar reply chama o service com rootMessageId e a thread recarrega sem fechar/reabrir', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', replyCount: 1 })],
      nextCursor: null,
    });
    getConversationReplies.mockResolvedValueOnce([]); // ao abrir a thread, ainda sem replies
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '1 resposta' }));
    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());

    const editor = await screen.findByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    getConversationReplies.mockResolvedValueOnce([msg({ id: 'r1', body: 'msg-1' })]);

    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledTimes(1));
    expect(postConversationMessage.mock.calls[0]).toEqual(['p1', { body: 'msg-1', rootMessageId: 'm1' }]);
    // a THREAD recarrega sozinha (refreshToken) — sem precisar voltar e reabrir.
    await waitFor(() => expect(screen.getByTestId('thread-reply-r1')).toBeInTheDocument());
    expect(screen.getByTestId('thread-view')).toBeInTheDocument(); // segue na mesma thread
  });

  // ---- DEFEITO 4 (conserto, gate b2-fix): erro não-403 na carga inicial nunca fica em branco ---

  it('DEFEITO 4 (conserto): erro NÃO-403 na carga inicial mostra panel.loadError — nunca fica em branco', async () => {
    getConversation.mockRejectedValue(new Error('network down'));
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-error')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-panel-error')).toHaveTextContent(PT.panel.loadError);
    expect(screen.queryByTestId('conversation-panel-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-panel-list')).not.toBeInTheDocument();
  });

  it('🔒 ajustes de UI B5 (item 6): carga INICIAL mostra spinner (role=status) ANTES da 1ª resposta — nunca painel branco', async () => {
    let resolveConversation: (v: { conversationId: string; messages: ConversationMessage[]; nextCursor: null }) => void = () => {};
    getConversation.mockImplementation(() => new Promise((resolve) => { resolveConversation = resolve; }));
    render(<ConversationPanel patientId="p1" isOpen />);

    const loading = await screen.findByTestId('conversation-panel-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent(PT.panel.loading);

    resolveConversation({ conversationId: 'conv-1', messages: [], nextCursor: null });
    await waitFor(() => expect(screen.getByTestId('conversation-panel-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-panel-loading')).not.toBeInTheDocument();
  });

  it('🔒 ajustes de UI B5 (item 6): erro na carga inicial mostra botão "Reintentar" que rebusca', async () => {
    getConversation.mockRejectedValueOnce(new Error('network down'));
    getConversation.mockResolvedValueOnce({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    const retryBtn = await screen.findByTestId('conversation-panel-retry');
    expect(retryBtn).toHaveTextContent(PT.panel.retry);
    fireEvent.click(retryBtn);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-panel-error')).not.toBeInTheDocument();
  });

  it('DEFEITO 4: erro NÃO-403 num POLL depois de já ter carregado (status \'ready\') NÃO troca de estado'
    + ' — mantém a última lista boa (comportamento antigo preservado)', async () => {
    vi.useFakeTimers();
    getConversation.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1' })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument();

    getConversation.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // continua mostrando a última lista boa — nunca vira 'error' depois de já ter carregado.
    expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-panel-error')).not.toBeInTheDocument();
  });

  // ---- DEFEITO 1 (conserto, gate b2-fix): sem `patient_conversation:create`, compositor vira aviso ---

  it('DEFEITO 1 (conserto): sem a célula de create, o compositor de TOPO vira aviso — nunca o campo', async () => {
    useAdminAuthStore.setState({
      authz: {
        uid: 'u1', tenantId: 't1', status: 'ACTIVE', permissions: ['patient_conversation:read'],
        countries: ['AR'], groups: [], features: {}, enforcement: 'on',
      } satisfies AuthzContract,
      authzStatus: 'ready',
    });
    getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-read-only')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-panel-read-only')).toHaveTextContent(PT.panel.readOnly);
    expect(screen.queryByTestId('composer-editor')).not.toBeInTheDocument();
  });

  it('DEFEITO 1 (conserto): sem a célula de create, o compositor de REPLY também vira aviso', async () => {
    useAdminAuthStore.setState({
      authz: {
        uid: 'u1', tenantId: 't1', status: 'ACTIVE', permissions: ['patient_conversation:read'],
        countries: ['AR'], groups: [], features: {}, enforcement: 'on',
      } satisfies AuthzContract,
      authzStatus: 'ready',
    });
    getConversation.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [msg({ id: 'm1', replyCount: 1 })],
      nextCursor: null,
    });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '1 resposta' }));

    await waitFor(() => expect(screen.getByTestId('conversation-panel-read-only')).toBeInTheDocument());
    expect(screen.queryByTestId('composer-editor')).not.toBeInTheDocument();
  });

  it('com a célula de create (default sem authz mockado — enforcement off), o compositor aparece normalmente', async () => {
    getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [], nextCursor: null });
    render(<ConversationPanel patientId="p1" isOpen />);

    await waitFor(() => expect(screen.getByTestId('conversation-panel-empty')).toBeInTheDocument());
    expect(await screen.findByTestId('composer-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-panel-read-only')).not.toBeInTheDocument();
  });

  // ---- rodapé do card: "Responder" sempre, "N respuestas" só quando N >= 1 (ajustes de UI B5) --

  describe('rodapé do card (achado "0 respuestas")', () => {
    it('replyCount 0: NÃO mostra "0 respostas" nenhuma — só o botão "Responder"', async () => {
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'm1', replyCount: 0 })],
        nextCursor: null,
      });
      render(<ConversationPanel patientId="p1" isOpen />);

      await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
      expect(screen.queryByTestId('conversation-message-replies')).not.toBeInTheDocument();
      expect(screen.queryByText(/0 resposta/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('conversation-message-reply-btn')).toBeInTheDocument();
    });

    it('replyCount >= 1: mostra o SELO (contagem + aria-label) E "Responder" — os dois abrem a MESMA thread', async () => {
      getConversationReplies.mockResolvedValue([]);
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'm1', replyCount: 2 })],
        nextCursor: null,
      });
      render(<ConversationPanel patientId="p1" isOpen />);

      await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
      const badge = screen.getByTestId('conversation-message-replies');
      expect(badge).toHaveTextContent('2');
      expect(badge).toHaveAttribute('aria-label', '2 respostas');

      fireEvent.click(screen.getByTestId('conversation-message-reply-btn'));
      await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    });

    it('o SELO também abre a thread (não é só decorativo)', async () => {
      getConversationReplies.mockResolvedValue([]);
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'm1', replyCount: 1 })],
        nextCursor: null,
      });
      render(<ConversationPanel patientId="p1" isOpen />);

      await waitFor(() => expect(screen.getByTestId('conversation-message-m1')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('conversation-message-replies'));
      await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    });
  });

  describe('item 3 (change 022-ux-mencao-e-notificacao) — deep-link: rola/destaca a mensagem-alvo da notificação', () => {
    it('feliz: mensagem-alvo já está na 1ª página — destaque aplicado direto, sem página extra', async () => {
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'm1' }), msg({ id: 'm2' })],
        nextCursor: null,
      });
      render(<ConversationPanel patientId="p1" isOpen focusTarget={{ messageId: 'm2', rootMessageId: null }} />);

      await waitFor(() => expect(screen.getByTestId('message-card-m2')).toHaveAttribute('data-highlighted', 'true'));
      expect(screen.getByTestId('message-card-m1')).not.toHaveAttribute('data-highlighted');
      expect(getConversation).toHaveBeenCalledTimes(1); // já estava carregada — nenhum loop de página
    });

    it('alt: mensagem-alvo fora da 1ª página — carrega páginas em loop até achar, sem travar a UI', async () => {
      getConversation
        .mockResolvedValueOnce({ conversationId: 'conv-1', messages: [msg({ id: 'm1' })], nextCursor: 'cursor-1' })
        .mockResolvedValueOnce({ conversationId: 'conv-1', messages: [msg({ id: 'm2' })], nextCursor: null });
      render(<ConversationPanel patientId="p1" isOpen focusTarget={{ messageId: 'm2', rootMessageId: null }} />);

      await waitFor(() => expect(screen.getByTestId('message-card-m2')).toBeInTheDocument());
      expect(screen.getByTestId('message-card-m2')).toHaveAttribute('data-highlighted', 'true');
      expect(getConversation).toHaveBeenCalledTimes(2);
      expect(getConversation).toHaveBeenNthCalledWith(2, 'p1', { after: 'cursor-1' });
    });

    it('alt: mensagem-alvo é REPLY (rootMessageId presente) — abre a thread certa e destaca a reply dentro dela', async () => {
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'root-1', replyCount: 1 })],
        nextCursor: null,
      });
      getConversationReplies.mockResolvedValue([msg({ id: 'reply-1', body: 'resposta' })]);
      render(<ConversationPanel patientId="p1" isOpen focusTarget={{ messageId: 'reply-1', rootMessageId: 'root-1' }} />);

      await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('message-card-reply-1')).toHaveAttribute('data-highlighted', 'true'));
    });

    it('alt: esgota as páginas sem achar — mostra estado "não encontrada", não trava a UI', async () => {
      getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [msg({ id: 'm1' })], nextCursor: null });
      render(<ConversationPanel patientId="p1" isOpen focusTarget={{ messageId: 'nunca-existiu', rootMessageId: null }} />);

      await waitFor(() => expect(screen.getByTestId('conversation-message-not-found')).toBeInTheDocument());
      expect(screen.getByTestId('conversation-panel-list')).toBeInTheDocument(); // painel continua usável
    });

    it('onFocusHandled é chamado depois de processar o alvo (achado)', async () => {
      const onFocusHandled = vi.fn();
      getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [msg({ id: 'm1' })], nextCursor: null });
      render(<ConversationPanel patientId="p1" isOpen focusTarget={{ messageId: 'm1', rootMessageId: null }} onFocusHandled={onFocusHandled} />);

      await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    });

    it('sem focusTarget: nenhum destaque, comportamento normal preservado', async () => {
      getConversation.mockResolvedValue({ conversationId: 'conv-1', messages: [msg({ id: 'm1' })], nextCursor: null });
      render(<ConversationPanel patientId="p1" isOpen />);

      await waitFor(() => expect(screen.getByTestId('message-card-m1')).toBeInTheDocument());
      expect(screen.getByTestId('message-card-m1')).not.toHaveAttribute('data-highlighted');
      expect(screen.queryByTestId('conversation-message-not-found')).not.toBeInTheDocument();
    });

    // G7 (achado do gate desta change): clicar de novo na MESMA notificação (2º clique, `token`
    // novo) com o painel já aberto tem de reprocessar — antes, `processedFocusIdRef` só zerava ao
    // abrir o painel/trocar de paciente, então o 2º clique caía numa guarda presa para sempre
    // (nem destacava, nem chamava `onFocusHandled` — o `focusTarget` ficava preso no pai).
    it('G7: 2º clique na MESMA notificação (token novo) com o painel já aberto — reprocessa (onFocusHandled de novo)', async () => {
      const onFocusHandled = vi.fn();
      getConversation.mockResolvedValue({
        conversationId: 'conv-1',
        messages: [msg({ id: 'm1' }), msg({ id: 'm2' })],
        nextCursor: null,
      });
      const { rerender } = render(
        <ConversationPanel
          patientId="p1"
          isOpen
          focusTarget={{ messageId: 'm1', rootMessageId: null, token: 1 }}
          onFocusHandled={onFocusHandled}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('message-card-m1')).toHaveAttribute('data-highlighted', 'true'));
      expect(onFocusHandled).toHaveBeenCalledTimes(1);

      // O pai real zera `focusTarget` depois de `onFocusHandled` (mesmo protocolo do
      // `PatientConversationHandle`) — simula aqui.
      rerender(
        <ConversationPanel patientId="p1" isOpen focusTarget={null} onFocusHandled={onFocusHandled} />,
      );

      // 2º clique NA MESMA notificação: mesmo `messageId`, `token` NOVO.
      rerender(
        <ConversationPanel
          patientId="p1"
          isOpen
          focusTarget={{ messageId: 'm1', rootMessageId: null, token: 2 }}
          onFocusHandled={onFocusHandled}
        />,
      );

      await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(2));
    });
  });
});
