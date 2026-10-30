import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PedidosIaPage } from '../PedidosIaPage';
import { pedidosIaErrorKey } from '../pedidosIaErrors';
import { ApiError } from '@infrastructure/http/ApiError';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { Pedido } from '@infrastructure/http/AdminPedidosIaApiService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k), i18n: { language: 'es' } }),
}));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { list: vi.fn(), get: vi.fn(), aceitar: vi.fn(), negar: vi.fn(), descrever: vi.fn() };
vi.mock('@infrastructure/http/AdminPedidosIaApiService', () => ({
  AdminPedidosIaApiService: {
    list: (...a: unknown[]) => api.list(...a),
    get: (...a: unknown[]) => api.get(...a),
    aceitar: (...a: unknown[]) => api.aceitar(...a),
    negar: (...a: unknown[]) => api.negar(...a),
    descrever: (...a: unknown[]) => api.descrever(...a),
  },
}));

const ATITUDE = { versao: 2, degrau: 1, conteudo: 'conteudo v2', caso_teste: 'caso', metrica_alvo: 'metrica', janela: '7d', gatilho_rollback: 'rollback' };
const pedido = (over: Partial<Pedido> = {}): Pedido => ({
  id: 'p1', assunto: 'Assunto sintetico', autor: 'sol', area: 'recrutamento', grave_gatilho: 'nenhum', status: 'novo',
  criado_em: '2026-10-29T10:00:00Z', idade_h: 5, atitude_atual: ATITUDE, eventos: [], ...over,
});

function postura(cells: string[] | 'loading' | 'error', enforcement: 'on' | 'off' = 'on'): void {
  if (cells === 'loading') { useAdminAuthStore.setState({ authz: null, authzStatus: 'loading' }); return; }
  if (cells === 'error') { useAdminAuthStore.setState({ authz: null, authzStatus: 'error' }); return; }
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: cells, countries: ['AR'], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const render_ = () => render(
  <MemoryRouter initialEntries={['/admin/pedidos-ia']}>
    <Routes>
      <Route path="/admin/pedidos-ia" element={<PedidosIaPage />} />
      <Route path="/admin" element={<div data-testid="admin-home" />} />
    </Routes>
  </MemoryRouter>,
);
const LEITOR = ['pedidos_ia:read'];
const DECISOR = ['pedidos_ia:read', 'pedidos_ia:decidir'];

describe('PedidosIaPage — gate por célula', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.list.mockResolvedValue([pedido()]);
  });

  it('sem pedidos_ia:read: redireciona para a home admin e NÃO chama a API', async () => {
    postura(['worker:read']);
    render_();
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('contrato carregando diz que carrega; em erro diz que falhou — sem API nos dois', () => {
    postura('loading');
    const { unmount } = render_();
    expect(screen.getByText('admin.pedidosIa.loading')).toBeInTheDocument();
    unmount();
    postura('error');
    render_();
    expect(screen.getByRole('alert')).toHaveTextContent('admin.pedidosIa.authzError');
    expect(api.list).not.toHaveBeenCalled();
  });

  it('🔴 com read SEM decidir: lista o pedido, avisa somente leitura e NÃO há botões Aceitar/Negar/Descrever', async () => {
    postura(LEITOR);
    render_();
    expect(await screen.findByText('Assunto sintetico')).toBeInTheDocument();
    expect(screen.getByTestId('pedidos-somente-leitura')).toBeInTheDocument();
    expect(screen.queryByTestId('pedido-aceitar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pedido-negar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pedido-descrever')).not.toBeInTheDocument();
  });

  it('com decidir: os 3 botões existem', async () => {
    postura(DECISOR);
    render_();
    await screen.findByText('Assunto sintetico');
    expect(screen.getByTestId('pedido-aceitar')).toBeInTheDocument();
    expect(screen.getByTestId('pedido-negar')).toBeInTheDocument();
    expect(screen.getByTestId('pedido-descrever')).toBeInTheDocument();
    expect(screen.queryByTestId('pedidos-somente-leitura')).not.toBeInTheDocument();
  });
});

describe('PedidosIaPage — post, etiquetas e detalhe', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    postura(DECISOR);
  });

  it('GRAVE só quando grave_gatilho ≠ nenhum; NOVO só no status novo; decidido não tem botões', async () => {
    api.list.mockResolvedValue([
      pedido({ id: 'a', assunto: 'grave novo', grave_gatilho: 'dado' }),
      pedido({ id: 'b', assunto: 'leve aceito', status: 'aceito', idade_h: 100 }),
    ]);
    render_();
    await screen.findByText('grave novo');
    const a = screen.getByTestId('pedido-post-a');
    const b = screen.getByTestId('pedido-post-b');
    expect(a.querySelector('[data-testid="pedido-grave"]')).not.toBeNull();
    expect(a.querySelector('[data-testid="pedido-novo"]')).not.toBeNull();
    expect(b.querySelector('[data-testid="pedido-grave"]')).toBeNull();
    expect(b.querySelector('[data-testid="pedido-novo"]')).toBeNull();
    expect(b.querySelector('[data-testid="pedido-aceitar"]')).toBeNull();
    expect(b).toHaveTextContent('admin.pedidosIa.age.days:4');
    expect(a).toHaveTextContent('admin.pedidosIa.age.hours:5');
  });

  it('detalhe expande: atitude (degrau, conteúdo, caso de teste, medição) e histórico de eventos', async () => {
    api.list.mockResolvedValue([pedido({ eventos: [{ acao: 'descrever', actor_uid: 'uid-x', actor_kind: 'humano', ts: '2026-10-29T11:00:00Z', comentario: 'faça assim' }] })]);
    render_();
    await screen.findByText('Assunto sintetico');
    expect(screen.queryByTestId('pedido-detalhe')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('pedido-toggle'));
    const det = screen.getByTestId('pedido-detalhe');
    expect(det).toHaveTextContent('conteudo v2');
    expect(det).toHaveTextContent('caso');
    expect(det).toHaveTextContent('metrica');
    expect(screen.getByTestId('pedido-eventos')).toHaveTextContent('faça assim');
  });

  it('ordena por idade: mais novos primeiro por padrão, mais antigos ao trocar', async () => {
    api.list.mockResolvedValue([pedido({ id: 'velho', assunto: 'velho', idade_h: 90 }), pedido({ id: 'novo', assunto: 'novo', idade_h: 2 })]);
    render_();
    await screen.findByText('velho');
    const ordem = () => screen.getAllByRole('article').map((el) => el.getAttribute('data-testid'));
    expect(ordem()).toEqual(['pedido-post-novo', 'pedido-post-velho']);
    await userEvent.selectOptions(screen.getByTestId('pedidos-ordem'), 'antigos');
    expect(ordem()).toEqual(['pedido-post-velho', 'pedido-post-novo']);
  });

  it('filtro por área e status vai ao servidor', async () => {
    api.list.mockResolvedValue([pedido()]);
    render_();
    await screen.findByText('Assunto sintetico');
    await userEvent.selectOptions(screen.getByTestId('pedidos-filtro-area'), 'recrutamento');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ area: 'recrutamento', status: undefined }));
    await userEvent.selectOptions(screen.getByTestId('pedidos-filtro-status'), 'aceito');
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ area: 'recrutamento', status: 'aceito' }));
  });
});

describe('PedidosIaPage — decisões', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    postura(DECISOR);
    api.list.mockResolvedValue([pedido()]);
  });

  it('Aceitar chama a API e o status passa a aceito (evento aparece no histórico)', async () => {
    api.aceitar.mockResolvedValue({ evento_id: 'e1', status: 'aceito' });
    api.get.mockResolvedValue(pedido({ status: 'aceito', eventos: [{ acao: 'aceitar', actor_uid: 'u', actor_kind: 'humano', ts: '2026-10-29T12:00:00Z' }] }));
    render_();
    await screen.findByText('Assunto sintetico');
    await userEvent.click(screen.getByTestId('pedido-aceitar'));
    await waitFor(() => expect(screen.getByTestId('pedido-status')).toHaveTextContent('admin.pedidosIa.status.aceito'));
    expect(api.aceitar).toHaveBeenCalledWith('p1');
    expect(screen.queryByTestId('pedido-aceitar')).not.toBeInTheDocument();
  });

  it('🔴 Negar sem motivo: botão do modal desabilitado e a API NÃO é chamada; com motivo (só espaços não vale) envia', async () => {
    api.negar.mockResolvedValue({ evento_id: 'e2', status: 'negado' });
    api.get.mockResolvedValue(pedido({ status: 'negado' }));
    render_();
    await screen.findByText('Assunto sintetico');
    await userEvent.click(screen.getByTestId('pedido-negar'));
    const confirmar = screen.getByTestId('decisao-confirmar');
    expect(confirmar).toBeDisabled();
    await userEvent.type(screen.getByTestId('decisao-texto'), '   ');
    expect(confirmar).toBeDisabled();
    await userEvent.click(confirmar);
    expect(api.negar).not.toHaveBeenCalled();
    await userEvent.type(screen.getByTestId('decisao-texto'), 'fora do escopo');
    expect(confirmar).toBeEnabled();
    await userEvent.click(confirmar);
    await waitFor(() => expect(api.negar).toHaveBeenCalledWith('p1', 'fora do escopo'));
    await waitFor(() => expect(screen.queryByTestId('decisao-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('pedido-status')).toHaveTextContent('admin.pedidosIa.status.negado');
  });

  it('Descrever exige comentário e o status vira redirecionado (botões continuam: o Sol redige a próxima versão)', async () => {
    api.descrever.mockResolvedValue({ evento_id: 'e3', status: 'redirecionado' });
    api.get.mockResolvedValue(pedido({ status: 'redirecionado' }));
    render_();
    await screen.findByText('Assunto sintetico');
    await userEvent.click(screen.getByTestId('pedido-descrever'));
    expect(screen.getByTestId('decisao-confirmar')).toBeDisabled();
    await userEvent.type(screen.getByTestId('decisao-texto'), 'tente degrau 2');
    await userEvent.click(screen.getByTestId('decisao-confirmar'));
    await waitFor(() => expect(api.descrever).toHaveBeenCalledWith('p1', 'tente degrau 2'));
    await waitFor(() => expect(screen.getByTestId('pedido-status')).toHaveTextContent('admin.pedidosIa.status.redirecionado'));
  });

  it('🔴 403 na decisão vira mensagem traduzida (aceitar) e o modal fica aberto com o erro (negar)', async () => {
    api.aceitar.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'FORBIDDEN' }, 403));
    api.negar.mockRejectedValue(new ApiError({ success: false, error: 'x' }, 403));
    render_();
    await screen.findByText('Assunto sintetico');
    await userEvent.click(screen.getByTestId('pedido-aceitar'));
    expect(await screen.findByTestId('pedido-erro')).toHaveTextContent('admin.pedidosIa.errors.forbidden');
    await userEvent.click(screen.getByTestId('pedido-negar'));
    await userEvent.type(screen.getByTestId('decisao-texto'), 'motivo');
    await userEvent.click(screen.getByTestId('decisao-confirmar'));
    expect(await screen.findByTestId('decisao-erro')).toHaveTextContent('admin.pedidosIa.errors.forbidden');
    expect(screen.getByTestId('decisao-modal')).toBeInTheDocument();
  });
});

describe('pedidosIaErrorKey', () => {
  const e = (status: number, code?: string) => new ApiError({ success: false, error: 'x', code }, status);
  it('mapeia 403 / 404 / 409 / 400 obrigatório / resto', () => {
    expect(pedidosIaErrorKey(e(403))).toBe('admin.pedidosIa.errors.forbidden');
    expect(pedidosIaErrorKey(e(404, 'NOT_FOUND'))).toBe('admin.pedidosIa.errors.notFound');
    expect(pedidosIaErrorKey(e(409, 'DECISAO_JA_REGISTRADA'))).toBe('admin.pedidosIa.errors.alreadyDecided');
    expect(pedidosIaErrorKey(e(400, 'MOTIVO_OBRIGATORIO'))).toBe('admin.pedidosIa.errors.required');
    expect(pedidosIaErrorKey(e(400, 'COMENTARIO_OBRIGATORIO'))).toBe('admin.pedidosIa.errors.required');
    expect(pedidosIaErrorKey(e(500, 'INTERNAL_ERROR'))).toBe('admin.pedidosIa.errors.generic');
    expect(pedidosIaErrorKey(new Error('boom'))).toBe('admin.pedidosIa.errors.generic');
  });
});
