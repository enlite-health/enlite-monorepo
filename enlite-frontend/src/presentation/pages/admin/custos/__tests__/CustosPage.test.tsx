import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CustosPage } from '../CustosPage';
import { custosErrorKey } from '../custosErrors';
import { formatVariation, isExportStale } from '../custosFormat';
import { CostsApiError, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.seconds !== undefined ? `${k}:${o.seconds}` : o?.pct !== undefined ? `${k}:${o.pct}` : k), i18n: { language: 'es' } }),
}));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const getOverview = vi.fn();
vi.mock('@infrastructure/http/AdminCostsApiService', async (orig) => ({
  ...(await orig<typeof import('@infrastructure/http/AdminCostsApiService')>()),
  AdminCostsApiService: { getOverview: (...a: unknown[]) => getOverview(...a) },
}));

const AGORA = new Date('2026-11-02T12:00:00Z');
const overview = (over: Partial<CostOverview> = {}): CostOverview => ({
  month: '2026-11', currency: 'USD', dataUntil: '2026-11-02T10:00:00Z', monthTotal: 120, prevMonthToDate: 100, prevMonthTotal: 900,
  forecast: { value: 1800, basis: 'linear', daysCounted: 2 },
  months: [{ month: '2026-10', total: 900 }, { month: '2026-11', total: 120 }],
  byService: [{ service: 'Cloud Run', total: 70 }],
  byResource: [{ service: 'Cloud Run', resource: 'svc-a', total: 70 }],
  bySector: [{ sector: 'recrutamento', total: 50 }, { sector: '__none__', total: 20 }],
  byAiCaller: [
    { caller: 'triage', funcao: 'f1', total: 10, source: 'billing' },
    { caller: 'maria', funcao: 'f2', total: 5, source: 'estimated' },
    { caller: '__none__', funcao: '__none__', total: 1, source: 'unattributed' },
  ],
  anomalies: { status: 'ok', items: [
    { kind: 'service', name: 'Cloud Run', dayValue: 40, median7: 10, factor: 4, isNew: false },
    { kind: 'resource', name: 'svc-novo', dayValue: 5, median7: 0, factor: null, isNew: true },
  ] },
  ...over,
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
  <MemoryRouter initialEntries={['/admin/custos']}>
    <Routes>
      <Route path="/admin/custos" element={<CustosPage />} />
      <Route path="/admin" element={<div data-testid="admin-home" />} />
    </Routes>
  </MemoryRouter>,
);
const clicar = () => userEvent.click(screen.getByTestId('custos-sincronizar'));

describe('CustosPage', () => {
  beforeEach(() => {
    getOverview.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
    postura(['platform_costs:read']);
  });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it('sem a célula: redireciona para a home admin e NÃO chama a API', async () => {
    postura(['worker:read']);
    render_();
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('contrato carregando / em erro: avisa e não chama a API', () => {
    postura('loading');
    const { unmount } = render_();
    expect(screen.getByText('admin.custos.authzLoading')).toBeInTheDocument();
    unmount();
    postura('error');
    render_();
    expect(screen.getByRole('alert')).toHaveTextContent('admin.custos.authzError');
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('ao abrir NÃO consulta (RF-2): mostra "sem dados" e o botão Sincronizar', () => {
    render_();
    expect(screen.getByTestId('custos-idle')).toBeInTheDocument();
    expect(screen.getByTestId('custos-sincronizar')).toBeEnabled();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('sincronizando: UMA chamada, botão desabilitado + indicador; depois mostra o resultado e não grava em localStorage', async () => {
    let resolver!: (v: CostOverview) => void;
    getOverview.mockReturnValue(new Promise<CostOverview>((r) => { resolver = r; }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render_();
    await clicar();
    expect(screen.getByTestId('custos-sincronizar')).toBeDisabled();
    expect(screen.getByTestId('custos-sincronizando')).toBeInTheDocument();
    await clicar(); // duplo clique não dispara 2ª chamada
    expect(getOverview).toHaveBeenCalledTimes(1);
    resolver(overview());
    expect(await screen.findByTestId('custos-resultado')).toBeInTheDocument();
    expect(screen.getByTestId('custos-sincronizar')).toBeEnabled();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('cabeçalho "dados até" e SEM aviso quando o export tem menos de 36 h; COM aviso acima disso', async () => {
    getOverview.mockResolvedValue(overview());
    const { unmount } = render_();
    await clicar();
    expect(await screen.findByTestId('custos-dados-ate')).toHaveTextContent('admin.custos.dataUntil');
    expect(screen.queryByTestId('custos-atrasado')).toBeNull();
    unmount();
    getOverview.mockResolvedValue(overview({ dataUntil: '2026-10-30T10:00:00Z' }));
    render_();
    await clicar();
    expect(await screen.findByTestId('custos-atrasado')).toBeInTheDocument();
  });

  it('cartões: valor do mês e da previsão, com mês anterior (até o dia e fechado) e variação %', async () => {
    getOverview.mockResolvedValue(overview());
    render_();
    await clicar();
    const mes = await screen.findByTestId('custos-card-mes');
    expect(within(mes).getByTestId('custos-card-mes-valor')).toHaveTextContent('120');
    expect(within(mes).getByTestId('custos-card-mes-ref-ate-dia-variacao')).toHaveTextContent('20%');
    expect(within(mes).getByTestId('custos-card-mes-ref-fechado-variacao')).toHaveTextContent('86,7%');
    const prev = screen.getByTestId('custos-card-previsao');
    expect(within(prev).getByTestId('custos-card-previsao-valor')).toHaveTextContent('1.800,00');
    expect(within(prev).getByTestId('custos-card-previsao-ref-fechado-variacao')).toHaveTextContent('100%');
  });

  it('prevMonthToDate/previsão nulos: mostra "—" e não inventa variação', async () => {
    getOverview.mockResolvedValue(overview({ prevMonthToDate: null, prevMonthTotal: null, forecast: { value: null, basis: 'linear', daysCounted: 0 } }));
    render_();
    await clicar();
    const mes = await screen.findByTestId('custos-card-mes');
    expect(within(mes).queryByTestId('custos-card-mes-ref-ate-dia-variacao')).toBeNull();
    expect(within(screen.getByTestId('custos-card-previsao')).getByTestId('custos-card-previsao-valor')).toHaveTextContent('admin.custos.cards.noValue');
  });

  it('6 meses em barras, tabelas, "sem setor" e selos estimado / não atribuído', async () => {
    getOverview.mockResolvedValue(overview());
    render_();
    await clicar();
    await screen.findByTestId('custos-resultado');
    expect(screen.getByTestId('custos-mes-barra-2026-10')).toBeInTheDocument();
    expect(screen.getByTestId('custos-mes-barra-2026-11')).toBeInTheDocument();
    expect(within(screen.getByTestId('custos-por-servico')).getByText('Cloud Run')).toBeInTheDocument();
    expect(within(screen.getByTestId('custos-por-recurso')).getByText('svc-a')).toBeInTheDocument();
    const setor = screen.getByTestId('custos-por-setor');
    expect(within(setor).getByText('recrutamento')).toBeInTheDocument();
    expect(within(setor).getByText('admin.custos.tables.noSector')).toBeInTheDocument();
    expect(within(setor).queryByText('__none__')).toBeNull();
    expect(screen.getAllByTestId('custos-selo-estimado')).toHaveLength(1);
    expect(screen.getAllByTestId('custos-selo-nao-atribuido')).toHaveLength(1);
  });

  it('anomalias: lista com selo "novo" e fator nulo; histórico insuficiente tem texto próprio', async () => {
    getOverview.mockResolvedValue(overview());
    const { unmount } = render_();
    await clicar();
    await screen.findByTestId('custos-anomalias');
    expect(screen.getAllByTestId('custos-anomalia')).toHaveLength(2);
    expect(screen.getAllByTestId('custos-selo-novo')).toHaveLength(1);
    unmount();
    getOverview.mockResolvedValue(overview({ anomalies: { status: 'insufficient_history', items: [] } }));
    render_();
    await clicar();
    expect(await screen.findByTestId('custos-anomalias-insuficiente')).toBeInTheDocument();
  });

  it('estado vazio (export sem linhas): mensagem própria, sem cartões', async () => {
    getOverview.mockResolvedValue(overview({ dataUntil: null, currency: null, monthTotal: 0, months: [] }));
    render_();
    await clicar();
    expect(await screen.findByTestId('custos-vazio')).toBeInTheDocument();
    expect(screen.queryByTestId('custos-resultado')).toBeNull();
  });

  it('erros: bytes_limit e 429 (com segundos) têm texto próprio; o botão vira "tentar de novo"', async () => {
    getOverview.mockRejectedValueOnce(new CostsApiError('bytes_limit', 502));
    const { unmount } = render_();
    await clicar();
    expect(await screen.findByTestId('custos-erro')).toHaveAttribute('data-code', 'admin.custos.errors.bytesLimit');
    expect(screen.getByTestId('custos-sincronizar')).toHaveTextContent('admin.custos.retry');
    unmount();
    getOverview.mockRejectedValueOnce(new CostsApiError('sync_rate_limited', 429, 7));
    render_();
    await clicar();
    expect(await screen.findByTestId('custos-erro')).toHaveTextContent('admin.custos.errors.rateLimited:7');
  });

  it('403 da API: mensagem de acesso negado e sem botão de sincronizar', async () => {
    getOverview.mockRejectedValueOnce(new CostsApiError(undefined, 403));
    render_();
    await clicar();
    await waitFor(() => expect(screen.getByTestId('custos-erro')).toHaveAttribute('data-code', 'admin.custos.errors.forbidden'));
    expect(screen.queryByTestId('custos-sincronizar')).toBeNull();
  });
});

describe('helpers', () => {
  it('custosErrorKey cai em genérico para erro desconhecido', () => {
    expect(custosErrorKey(new Error('x')).key).toBe('admin.custos.errors.generic');
    expect(custosErrorKey(new CostsApiError('billing_query_failed', 502)).key).toBe('admin.custos.errors.generic');
  });
  it('formatVariation: base nula ou zero → null; isExportStale respeita 36 h', () => {
    expect(formatVariation(10, null, 'es')).toBeNull();
    expect(formatVariation(10, 0, 'es')).toBeNull();
    expect(formatVariation(150, 100, 'pt-BR')).toBe('+50%');
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(isExportStale('2026-11-01T00:30:00Z', now)).toBe(false);
    expect(isExportStale('2026-10-31T11:00:00Z', now)).toBe(true);
    expect(isExportStale(null, now)).toBe(false);
  });
});
