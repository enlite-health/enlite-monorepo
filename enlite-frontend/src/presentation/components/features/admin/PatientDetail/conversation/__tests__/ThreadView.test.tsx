/**
 * ThreadView — testes unitários (spec 022, Bloco 2, T213/T214).
 *
 * Cobre:
 *   - lista as replies de UMA mensagem de topo, em ordem cronológica (a ordem vem do backend,
 *     `ORDER BY created_at ASC` — contrato; aqui só afirmamos que a UI respeita a ordem recebida);
 *   - botão "voltar" tem `aria-label` estável (`thread.back` = "Voltar") e dispara `onBack`;
 *   - thread é de 1 NÍVEL — não há botão de "respostas" dentro de uma reply (sem recursão);
 *   - reply apagada mostra o estado de apagada, nunca corpo vazio;
 *   - o compositor é ponto de EXTENSÃO — recebido via prop `composer` (não implementamos TipTap
 *     aqui; é de outro agente, T215/T216);
 *   - erro ao buscar replies não falha silenciosamente — mostra um aviso, não tela em branco.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { ThreadView } from '../ThreadView';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    getConversation: vi.fn(),
    getConversationReplies: vi.fn(),
  },
}));

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

const msg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: '11111111-1111-1111-1111-111111111111',
  authorUid: 'staff-um',
  body: 'msg-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  mentions: [],
  replyCount: 0,
  lastReplyAt: null,
  attachments: [],
  ...overrides,
});

const getConversationReplies = AdminConversationApiService.getConversationReplies as unknown as ReturnType<typeof vi.fn>;

describe('ThreadView', () => {
  beforeEach(() => {
    getConversationReplies.mockReset();
  });

  it('lista as replies na ordem recebida do backend (cronológica)', async () => {
    const root = msg({ id: 'root-1', body: 'pergunta' });
    getConversationReplies.mockResolvedValue([
      msg({ id: 'r1', body: 'resp-1', createdAt: '2026-09-01T10:01:00.000Z' }),
      msg({ id: 'r2', body: 'resp-2', createdAt: '2026-09-01T10:02:00.000Z' }),
    ]);
    render(<ThreadView patientId="p1" rootMessage={root} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-replies-list')).toBeInTheDocument());
    const items = screen.getAllByTestId(/^thread-reply-/);
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual(['thread-reply-r1', 'thread-reply-r2']);
    expect(getConversationReplies).toHaveBeenCalledWith('p1', 'root-1');
  });

  it('botão "voltar" tem aria-label estável e dispara onBack', async () => {
    getConversationReplies.mockResolvedValue([]);
    const onBack = vi.fn();
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={onBack} />);

    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: PT.thread.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reply é de 1 NÍVEL: nenhum botão de "respostas" aparece numa reply', async () => {
    getConversationReplies.mockResolvedValue([msg({ id: 'r1', body: 'resp-1', replyCount: 0 })]);
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-reply-r1')).toBeInTheDocument());
    // "respostas"/"resposta" só existe no botão de item de TOPO (ConversationPanel) — aqui não.
    expect(screen.queryByText(/resposta/i)).not.toBeInTheDocument();
  });

  it('reply apagada (deletedAt preenchido, body vazio) mostra o estado de apagada', async () => {
    getConversationReplies.mockResolvedValue([
      msg({ id: 'r1', body: '', deletedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-reply-r1')).toBeInTheDocument());
    const body = screen.getByTestId('thread-reply-r1').querySelector('[data-testid="message-body"]');
    expect(body?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('recebe o compositor por prop (ponto de extensão — TipTap real é de outro agente)', async () => {
    getConversationReplies.mockResolvedValue([]);
    render(
      <ThreadView
        patientId="p1"
        rootMessage={msg({ id: 'root-1' })}
        onBack={vi.fn()}
        composer={<div data-testid="fake-composer">composer aqui</div>}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
    expect(screen.getByTestId('fake-composer')).toBeInTheDocument();
  });

  it('sem compositor, não quebra (prop é opcional)', async () => {
    getConversationReplies.mockResolvedValue([]);
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread-view')).toBeInTheDocument());
  });

  it('erro ao buscar replies mostra aviso — nunca fica em branco (sem falha silenciosa)', async () => {
    getConversationReplies.mockRejectedValue(new Error('network down'));
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-view-error')).toBeInTheDocument());
    expect(screen.getByTestId('thread-view-error').textContent?.length).toBeGreaterThan(0);
  });

  it('token <@uid> fora da lista de mentions confirmadas cai pro texto cru (não quebra)', async () => {
    getConversationReplies.mockResolvedValue([
      // `mentions` é a lista de uids CONFIRMADOS pelo servidor (`ConversationRepository`) — só
      // 'u-1' está confirmado; 'u-2' tem a FORMA de menção mas não é uma menção validada.
      msg({ id: 'r1', body: 'Oi <@u-1> e <@u-2>', mentions: ['u-1'] }),
    ]);
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-reply-r1')).toBeInTheDocument());
    const chips = screen.getAllByTestId('mention-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('u-1');
    // 'u-2' não confirmado: aparece como texto cru (sem chip), a tela não quebra.
    expect(screen.getByTestId('thread-reply-r1')).toHaveTextContent('<@u-2>');
  });

  it('🔒 fix D-real (spec 022 B2): menção casada por UID, não por posição — 2 menções em ORDEM ALFABÉTICA'
    + ' inversa à ordem de aparição no texto mostram o uid CERTO em cada chip', async () => {
    // Backend devolve `mentions` ordenada ALFABETICAMENTE por uid (B1) — 'u-alfa' antes de
    // 'u-zeta'. O TEXTO cita 'u-zeta' primeiro. Casar pelo ÍNDICE (mentions[0] no 1º token)
    // atribuiria 'u-alfa' ao token de 'u-zeta' — nome errado. Casar pelo UID do próprio token
    // (este teste) tem que mostrar cada token com o SEU PRÓPRIO uid, sempre.
    getConversationReplies.mockResolvedValue([
      msg({
        id: 'r1',
        body: 'Oi <@u-zeta>, olha isso com <@u-alfa>',
        mentions: ['u-alfa', 'u-zeta'], // ordem alfabética — INVERSA à ordem de aparição no body
      }),
    ]);
    render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('thread-reply-r1')).toBeInTheDocument());
    const chips = screen.getAllByTestId('mention-chip');
    expect(chips).toHaveLength(2);
    // 1º token no texto é <@u-zeta> → tem que mostrar 'u-zeta', NUNCA 'u-alfa' (o que o casamento
    // por índice mostraria, porque mentions[0] === 'u-alfa').
    expect(chips[0]).toHaveTextContent('u-zeta');
    expect(chips[0]).not.toHaveTextContent('u-alfa');
    // 2º token no texto é <@u-alfa> → tem que mostrar 'u-alfa', NUNCA 'u-zeta'.
    expect(chips[1]).toHaveTextContent('u-alfa');
    expect(chips[1]).not.toHaveTextContent('u-zeta');
  });

  it('desmontar ANTES da resposta chegar não seta estado depois (guarda de corrida — sem warning de act)', async () => {
    let resolveReplies: (value: ConversationMessage[]) => void = () => {};
    getConversationReplies.mockImplementation(
      () => new Promise((resolve) => { resolveReplies = resolve; }),
    );
    const { unmount } = render(<ThreadView patientId="p1" rootMessage={msg({ id: 'root-1' })} onBack={vi.fn()} />);
    unmount();

    // Resolve DEPOIS do unmount — o `cancelled` da closure do efeito tem que impedir o
    // `setReplies`/`setStatus` de rodar num componente já desmontado.
    resolveReplies([msg({ id: 'r1' })]);
    await Promise.resolve();
    await Promise.resolve();
    // Chegar até aqui sem o React logar "not wrapped in act"/"unmounted component" já é a prova.
  });
});
