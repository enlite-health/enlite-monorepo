/**
 * NotificationPanel — TDD (spec 022, Bloco 4, T412/T413).
 *
 * Cobre: lista notificações (texto montado no CLIENTE, FR-015), clique marca lida E navega para
 * `patients/:patientId` com `DrawerFocusRequest { code: 'conversation' }` (deep-link, T413),
 * botão "marcar todas como lidas".
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminNotificationApiService, type AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { NotificationPanel } from '../NotificationPanel';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

// Molde: `sex-both-i18n.test.tsx` — re-inicializa com os recursos REAIS (o setup global usa
// `resources: {}`) para provar que `admin.notifications.mentioned/replied` interpolam a frase
// EXATA do contrato (`contracts/openapi-notifications.md` §Texto da notificação, FR-015),
// nunca a chave crua.
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

vi.mock('@infrastructure/http/AdminNotificationApiService', () => ({
  AdminNotificationApiService: {
    listNotifications: vi.fn(),
    getUnreadCount: vi.fn().mockResolvedValue(0),
    markNotificationRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(0),
  },
}));

function notif(overrides: Partial<AdminNotification> = {}): AdminNotification {
  return {
    id: 'n1',
    typeCode: 'CONVERSATION_MENTIONED',
    actorUid: 'staff-a',
    actorDisplayName: 'Ana Staff',
    patientId: 'p1',
    patientDisplayName: 'Fulano Paciente',
    conversationId: 'c1',
    messageId: 'm1',
    rootMessageId: null,
    messageExcerpt: null,
    createdAt: '2026-09-21T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('NotificationPanel (spec 022, T412/T413)', () => {
  beforeEach(() => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([]);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('painel aberto: busca e lista as notificações — autor na linha 1, aria-label com a frase completa montada no CLIENTE (FR-015)', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif()]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    expect(within(item).getByText('Ana Staff')).toBeInTheDocument();
    expect(item).toHaveAttribute('aria-label', 'Ana Staff mencionó a vos en Fulano Paciente');
  });

  it('patientDisplayName null (D-13, ator perdeu a célula): cai no fallback "un paciente" (linha do paciente E aria-label)', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
      notif({ patientDisplayName: null, typeCode: 'CONVERSATION_REPLIED' }),
    ]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    expect(within(item).getByTestId('notification-patient-n1')).toHaveTextContent('un paciente');
    expect(item).toHaveAttribute('aria-label', 'Ana Staff respondió en la conversación de un paciente');
  });

  it('clique numa notificação: marca lida E navega para patients/:patientId com DrawerFocusRequest code=conversation', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1', patientId: 'p42' })]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    fireEvent.click(item);

    await waitFor(() => {
      expect(AdminNotificationApiService.markNotificationRead).toHaveBeenCalledWith('n1');
    });
    expect(navigate).toHaveBeenCalledWith(
      '/admin/patients/p42',
      expect.objectContaining({
        state: { focusRequest: expect.objectContaining({ code: 'conversation' }) },
      }),
    );
  });

  it('item 3 (deep-link): clique propaga messageId/rootMessageId reais no focusRequest', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
      notif({ id: 'n1', patientId: 'p42', messageId: 'msg-1', rootMessageId: 'root-1' }),
    ]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('notification-item-n1'));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      '/admin/patients/p42',
      expect.objectContaining({
        state: {
          focusRequest: expect.objectContaining({
            code: 'conversation',
            messageId: 'msg-1',
            rootMessageId: 'root-1',
          }),
        },
      }),
    ));
  });

  it('notificação sem patientId (edge case): clique marca lida mas NÃO navega', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1', patientId: null })]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    fireEvent.click(item);

    await waitFor(() => {
      expect(AdminNotificationApiService.markNotificationRead).toHaveBeenCalledWith('n1');
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('botão "marcar todas como lidas" chama a API e re-busca a lista', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications)
      .mockResolvedValueOnce([notif({ id: 'n1' }), notif({ id: 'n2' })])
      .mockResolvedValueOnce([]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await screen.findByTestId('notification-item-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    await waitFor(() => {
      expect(AdminNotificationApiService.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('notification-item-n1')).not.toBeInTheDocument();
    });
  });

  it('lista vazia: mostra o estado vazio, sem quebrar', async () => {
    render(<NotificationPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-empty')).toBeInTheDocument();
    });
  });

  it('fechado (isOpen=false): não busca a lista', () => {
    render(<NotificationPanel isOpen={false} onClose={vi.fn()} />);
    expect(AdminNotificationApiService.listNotifications).not.toHaveBeenCalled();
  });

  it('🔒 achado do gate revisao-pr (B4): erro ao buscar a lista (403/500) mostra estado de erro VISÍVEL — nunca vira "sem notificações" (nem o testid nem o texto de vazio aparecem)', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockRejectedValue(new Error('forbidden'));
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const error = await screen.findByTestId('notification-load-error');
    expect(error).toHaveTextContent('No pudimos cargar tus notificaciones. Probá de nuevo.');
    expect(screen.getByRole('alert')).toBe(error.querySelector('[role="alert"]'));
    expect(screen.queryByTestId('notification-empty')).not.toBeInTheDocument();
    expect(screen.queryByText('No tenés notificaciones')).not.toBeInTheDocument();
  });

  it('🔒 achado do gate revisao-pr (B4): "marcar todas como lidas" que falha (403/500) mostra erro VISÍVEL, nunca silêncio', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1' })]);
    vi.mocked(AdminNotificationApiService.markAllNotificationsRead).mockRejectedValue(new Error('forbidden'));
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await screen.findByTestId('notification-item-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    const error = await screen.findByTestId('notification-mark-all-error');
    expect(error).toHaveTextContent('No pudimos marcar todas como leídas. Probá de nuevo.');
    // a lista NÃO some por causa do erro — só o marcar-lida falhou, a leitura continua válida.
    expect(screen.getByTestId('notification-item-n1')).toBeInTheDocument();
  });

  it('🔒 ajustes de UI B5 (item 6): carga INICIAL mostra spinner (role=status) ANTES da resposta chegar — nunca painel branco', async () => {
    let resolveList: (v: AdminNotification[]) => void = () => {};
    vi.mocked(AdminNotificationApiService.listNotifications).mockImplementation(
      () => new Promise((resolve) => { resolveList = resolve; }),
    );
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const loading = await screen.findByTestId('notification-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Cargando notificaciones…');

    resolveList([notif({ id: 'n1' })]);
    await screen.findByTestId('notification-item-n1');
    expect(screen.queryByTestId('notification-loading')).not.toBeInTheDocument();
  });

  it('🔒 ajustes de UI B5 (item 6): refetch depois de "marcar todas como lidas" NÃO mostra spinner de novo (sem piscar — a lista já está boa na tela)', async () => {
    // Não depender do estado deste mock deixado por outro teste do arquivo (ex.: o teste de
    // "marcar todas que falha" muda a implementação BASE, não só uma vez — `afterEach` só limpa
    // `mock.calls`, nunca a implementação) — reafirma o caminho feliz explicitamente aqui.
    vi.mocked(AdminNotificationApiService.markAllNotificationsRead).mockResolvedValue(0);
    vi.mocked(AdminNotificationApiService.listNotifications)
      .mockResolvedValueOnce([notif({ id: 'n1' })])
      .mockResolvedValueOnce([]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await screen.findByTestId('notification-item-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    await waitFor(() => expect(screen.queryByTestId('notification-item-n1')).not.toBeInTheDocument());
    // a régua é o CÓDIGO (`hasLoadedOnceRef` já true na 2ª chamada nunca liga `isLoading`) — o
    // spinner nunca aparece nesta janela, mesmo checando depois do refetch resolver.
    expect(screen.queryByTestId('notification-loading')).not.toBeInTheDocument();
  });

  it('🔒 ajustes de UI B5 (item 6): erro de carga mostra botão "Reintentar" que rebusca a lista', async () => {
    // `mockReset` explícito (não só `clearAllMocks` do `afterEach`) — elimina qualquer fila de
    // `Once` que sobrou de um teste anterior antes de montar os 2 valores exatos que ESTE teste
    // precisa (1 rejeição + 1 sucesso), sem depender de quantas chamadas os testes vizinhos fizeram.
    vi.mocked(AdminNotificationApiService.listNotifications).mockReset();
    vi.mocked(AdminNotificationApiService.listNotifications)
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce([notif({ id: 'n1' })]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const retryBtn = await screen.findByTestId('notification-retry');
    expect(retryBtn).toHaveTextContent('Reintentar');
    fireEvent.click(retryBtn);

    await screen.findByTestId('notification-item-n1');
    expect(screen.queryByTestId('notification-load-error')).not.toBeInTheDocument();
  });

  it('🔒 achado do gate (A9): notificação NÃO LIDA tem marcador visível — ponto de destaque com aria-label "No leída" + peso de fonte maior; lida não tem nem um nem outro', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
      notif({ id: 'n1', readAt: null }),
      notif({ id: 'n2', readAt: '2026-09-21T11:00:00.000Z' }),
    ]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const unreadItem = await screen.findByTestId('notification-item-n1');
    const readItem = await screen.findByTestId('notification-item-n2');

    const unreadDot = screen.getByTestId('notification-unread-dot-n1');
    expect(unreadDot).toHaveAttribute('aria-label', 'No leída');
    const unreadAuthor = within(unreadItem).getByText('Ana Staff');
    expect(unreadAuthor.className).toMatch(/font-semibold/);

    expect(screen.queryByTestId('notification-unread-dot-n2')).not.toBeInTheDocument();
    const readAuthor = within(readItem).getByText('Ana Staff');
    expect(readAuthor.className).not.toMatch(/font-semibold/);
  });

  describe('item 2 (change 022-ux-mencao-e-notificacao) — card com avatar, paciente, data e trecho', () => {
    it('card completo: avatar (iniciais), nome do autor, paciente, data e trecho aparecem', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
        notif({ id: 'n1', messageExcerpt: 'trecho da mensagem original' }),
      ]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);

      const item = await screen.findByTestId('notification-item-n1');
      expect(within(item).getByTestId('message-avatar')).toHaveTextContent('AS'); // getInitials('Ana Staff')
      expect(within(item).getByText('Ana Staff')).toBeInTheDocument();
      expect(within(item).getByTestId('notification-patient-n1')).toHaveTextContent('Fulano Paciente');
      expect(within(item).getByTestId('notification-excerpt-n1')).toHaveTextContent('trecho da mensagem original');
    });

    it('messageExcerpt null (sem célula ou falha de decifra): card sem a linha de trecho, sem quebrar o layout', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
        notif({ id: 'n1', messageExcerpt: null }),
      ]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);

      const item = await screen.findByTestId('notification-item-n1');
      expect(within(item).getByText('Ana Staff')).toBeInTheDocument();
      expect(within(item).getByTestId('notification-patient-n1')).toHaveTextContent('Fulano Paciente');
      expect(within(item).queryByTestId('notification-excerpt-n1')).not.toBeInTheDocument();
    });
  });

  describe('🔒 Defeito 2 (decisão do orquestrador, Rodada 2): card em 3 linhas — autor+data (linha 1), paciente (linha 2), trecho (linha 3)', () => {
    it('linha 1: autor E data no MESMO elemento pai, a data nunca encolhe (flex-shrink-0)', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1' })]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);

      const item = await screen.findByTestId('notification-item-n1');
      const author = within(item).getByText('Ana Staff');
      const authorRow = author.parentElement;
      expect(authorRow).not.toBeNull();
      const dateEl = within(authorRow as HTMLElement).getByText(/sep/i);
      expect(dateEl.className).toMatch(/flex-shrink-0/);
      // Autor trunca (nome comprido não estica a linha) — o teste de largura REAL é o e2e.
      expect(author.className).toMatch(/truncate/);
    });

    it('linha 2: SEMPRE um elemento PRÓPRIO (não compartilha nó com a linha 1) — nunca cortada pela data', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
        notif({ id: 'n1', patientDisplayName: 'Paciente Com Nome Bem Comprido Para Testar Truncamento' }),
      ]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);

      const item = await screen.findByTestId('notification-item-n1');
      const patientLine = within(item).getByTestId('notification-patient-n1');
      expect(patientLine).toHaveTextContent('Paciente Com Nome Bem Comprido Para Testar Truncamento');
      // Elemento PRÓPRIO — não é o mesmo nó que mostra o autor.
      expect(patientLine).not.toBe(within(item).getByText('Ana Staff'));
      expect(patientLine.className).toMatch(/truncate/);
    });

    it('linha 3 (trecho): line-clamp-2, não trunca em 1 linha só', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
        notif({ id: 'n1', messageExcerpt: 'Um trecho relativamente longo que poderia ocupar mais de uma linha no card' }),
      ]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);

      const excerpt = await screen.findByTestId('notification-excerpt-n1');
      expect(excerpt.className).toMatch(/line-clamp-2/);
    });

    it('ponto de não lida (A9) continua presente e com o MESMO aria-label — o redesenho não regride o achado do gate', async () => {
      vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1', readAt: null })]);
      render(<NotificationPanel isOpen onClose={vi.fn()} />);
      await screen.findByTestId('notification-item-n1');
      expect(screen.getByTestId('notification-unread-dot-n1')).toHaveAttribute('aria-label', 'No leída');
    });
  });

  it('erro de carga some numa busca seguinte bem-sucedida (reabrir o painel, por exemplo)', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications)
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce([notif({ id: 'n1' })]);
    const { rerender } = render(<NotificationPanel isOpen={false} onClose={vi.fn()} />);
    rerender(<NotificationPanel isOpen onClose={vi.fn()} />);
    await screen.findByTestId('notification-load-error');

    rerender(<NotificationPanel isOpen={false} onClose={vi.fn()} />);
    rerender(<NotificationPanel isOpen onClose={vi.fn()} />);

    await screen.findByTestId('notification-item-n1');
    expect(screen.queryByTestId('notification-load-error')).not.toBeInTheDocument();
  });

  it('🔒 Defeito 3 (Rodada 2, medido em prd 21-22/09): o header reserva espaço à direita para o ✕ do SlideOverPanel — "Marcar todas" não encosta nele', async () => {
    // O ✕ é do `SlideOverPanel` (pai), `absolute top-3 right-3` — este painel nunca o renderiza
    // sozinho. O conserto é LOCAL: o header do `NotificationPanel` reserva a faixa direita (padding
    // maior que o `px-4` simétrico de antes) para o botão "Marcar todas" nunca invadir a área do X,
    // mesmo sem o `SlideOverPanel` montado neste teste (prova geométrica real — rects não se
    // intersectam — é o e2e `notification-bell-sidebar-collapsed`/tela real, jsdom não faz layout).
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);
    await screen.findByTestId('notification-empty');

    const header = screen.getByTestId('notification-mark-all-read').closest('div');
    expect(header?.className).toMatch(/\bpr-14\b/);
  });
});
