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
import { chooseCombo, comboLabels, selectCombo } from '@presentation/components/atoms/Combobox/testUtils';
import { overview, usarIdioma } from './custosTestUtils';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const getOverview = vi.fn();
vi.mock('@infrastructure/http/AdminCostsApiService', async (orig) => ({
  ...(await orig<typeof import('@infrastructure/http/AdminCostsApiService')>()),
  AdminCostsApiService: { getOverview: (...a: unknown[]) => getOverview(...a) },
}));

const AGORA = new Date('2026-10-18T12:00:00Z');

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
const sincronizado = async (ov: CostOverview = overview(), espera = 'custos-resultado') => {
  getOverview.mockResolvedValue(ov);
  render_();
  await clicar();
  await screen.findByTestId(espera);
};
const seletor = () => within(screen.getByTestId('custos-mes-select')).getByRole('combobox');

describe('CustosPage', () => {
  beforeEach(async () => {
    getOverview.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
    await usarIdioma('pt-BR');
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
    expect(screen.getByText('Carregando permissões…')).toBeInTheDocument();
    unmount();
    postura('error');
    render_();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar suas permissões');
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('ao abrir NÃO consulta (RF-2): estado "antes de sincronizar" e o botão Sincronizar', () => {
    render_();
    expect(screen.getByTestId('custos-idle')).toHaveTextContent('Ainda não há dados nesta tela');
    expect(screen.getByTestId('custos-sincronizar')).toBeEnabled();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('sincronizando: UMA chamada, botão desabilitado + "Sincronizando…"; depois mostra o resultado e não grava em localStorage', async () => {
    let resolver!: (v: CostOverview) => void;
    getOverview.mockReturnValue(new Promise<CostOverview>((r) => { resolver = r; }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render_();
    await clicar();
    expect(screen.getByTestId('custos-sincronizar')).toBeDisabled();
    expect(screen.getByTestId('custos-sincronizar')).toHaveTextContent('Sincronizando…');
    expect(screen.getByTestId('custos-sincronizando')).toHaveTextContent('Buscando os dados');
    await clicar(); // duplo clique não dispara 2ª chamada
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getOverview).toHaveBeenCalledWith(undefined);
    resolver(overview());
    expect(await screen.findByTestId('custos-resultado')).toBeInTheDocument();
    expect(screen.getByTestId('custos-sincronizar')).toBeEnabled();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('ordem dos blocos (RF-A1): veredito → 3 números → Quem gasta → 6 meses', async () => {
    await sincronizado();
    const ordem = ['custos-anomalias', 'custos-kpis', 'custos-quem-gasta', 'custos-meses'].map((id) => screen.getByTestId(id));
    ordem.slice(1).forEach((el, i) => {
      expect(ordem[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('cabeçalho "dados até" e SEM aviso com o export recente; COM aviso quando passa de 36 h', async () => {
    await sincronizado();
    expect(screen.getByTestId('custos-dados-ate')).toHaveTextContent('Dados do faturamento até');
    expect(screen.queryByTestId('custos-atrasado')).toBeNull();
  });

  it('export atrasado (> 36 h): aviso com texto próprio', async () => {
    await sincronizado(overview({ dataUntil: '2026-10-15T10:00:00Z' }));
    expect(screen.getByTestId('custos-atrasado')).toHaveTextContent('O export está atrasado');
  });

  it('"Ver detalhe" abre o A2 com ZERO chamadas novas; "Voltar ao painel" volta ao A1 e devolve o foco ao botão de origem', async () => {
    await sincronizado();
    expect(getOverview).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('custos-ver-detalhe'));
    expect(screen.getByTestId('custos-detalhe')).toBeInTheDocument();
    expect(screen.queryByTestId('custos-kpis')).toBeNull();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('custos-sincronizar')).toBeInTheDocument(); // cabeçalho permanece nos dois
    await userEvent.click(screen.getByTestId('custos-voltar'));
    expect(screen.getByTestId('custos-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('custos-ver-detalhe')).toHaveFocus();
    expect(getOverview).toHaveBeenCalledTimes(1);
  });

  it('nova sincronização que não traz mais o item: A2 volta ao A1', async () => {
    await sincronizado();
    await userEvent.click(screen.getByTestId('custos-ver-detalhe'));
    getOverview.mockResolvedValue(overview({ anomalies: { ...overview().anomalies, items: [] } }));
    await clicar();
    expect(await screen.findByTestId('custos-anomalias-vazio')).toBeInTheDocument();
    expect(screen.queryByTestId('custos-detalhe')).toBeNull();
  });

  it('seletor de mês: abre no mês corrente; opções = availableMonths + corrente; trocar = EXATAMENTE 1 chamada com `month`', async () => {
    await sincronizado();
    expect(seletor()).toHaveTextContent('outubro de 2026');
    expect(comboLabels(seletor())).toEqual(['outubro de 2026', 'setembro de 2026', 'agosto de 2026']);
    getOverview.mockClear();
    getOverview.mockResolvedValue(overview({ month: '2026-09' }));
    chooseCombo(seletor(), 'setembro de 2026'); // o gatilho já está aberto pelo comboLabels
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(1));
    expect(getOverview).toHaveBeenCalledWith('2026-09');
    expect(seletor()).toHaveTextContent('setembro de 2026');
  });

  it('antes de sincronizar o seletor só tem o mês corrente (availableMonths ainda não veio)', async () => {
    render_();
    expect(comboLabels(seletor())).toEqual(['outubro de 2026']);
  });

  it('mês sem linhas: "<Mês> ainda não tem dados no faturamento" + atalho "Ver <último mês com dados>" (1 chamada com availableMonths[0])', async () => {
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await sincronizado(overview({ month: '2026-11', dataUntil: null, currency: null, monthTotal: 0, months: [], byService: [], byResource: [], bySector: [], byAiCaller: [], byProject: [], availableMonths: ['2026-10', '2026-09'] }), 'custos-vazio');
    expect(screen.getByTestId('custos-vazio')).toHaveTextContent('Novembro de 2026 ainda não tem dados no faturamento');
    expect(screen.queryByTestId('custos-kpis')).toBeNull();
    const atalho = screen.getByTestId('custos-ver-ultimo');
    expect(atalho).toHaveTextContent('Ver outubro de 2026');
    getOverview.mockClear();
    getOverview.mockResolvedValue(overview());
    await userEvent.click(atalho);
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(1));
    expect(getOverview).toHaveBeenCalledWith('2026-10');
    expect(await screen.findByTestId('custos-kpis')).toBeInTheDocument();
  });

  it('mês sem linhas em es: a frase também abre com o mês em maiúscula', async () => {
    await usarIdioma('es');
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await sincronizado(overview({ month: '2026-11', dataUntil: null, currency: null, monthTotal: 0, months: [], byService: [], byResource: [], bySector: [], byAiCaller: [], byProject: [], availableMonths: [] }), 'custos-vazio');
    expect(screen.getByTestId('custos-vazio')).toHaveTextContent('Noviembre de 2026 todavía no tiene datos en la facturación');
  });

  it('mês sem linhas e availableMonths vazio: só o texto, SEM atalho', async () => {
    await sincronizado(overview({ dataUntil: null, currency: null, monthTotal: 0, months: [], byService: [], byProject: [], availableMonths: [] }), 'custos-vazio');
    expect(screen.getByTestId('custos-vazio')).toBeInTheDocument();
    expect(screen.queryByTestId('custos-ver-ultimo')).toBeNull();
  });

  it('UI-7: nenhum glifo de seta, símbolo, dingbat ou emoji no texto da página (ícones são lucide)', async () => {
    await sincronizado();
    await userEvent.click(screen.getByTestId('custos-aba-ai'));
    const proibido = /[←-⇿⌀-⏿■-◿☀-➿⬀-⯿\u{1F000}-\u{1FAFF}]/u;
    expect(screen.getByTestId('custos-page').textContent).not.toMatch(proibido);
    await userEvent.click(screen.getByTestId('custos-ver-detalhe'));
    expect(screen.getByTestId('custos-page').textContent).not.toMatch(proibido);
    // controle positivo: a regex acusa um glifo de seta e um emoji
    expect('Ver detalhe →').toMatch(proibido);
    expect('ok ✅').toMatch(proibido);
  });

  it('i18n: a mesma tela renderiza em espanhol e em pt-BR', async () => {
    await usarIdioma('es');
    await sincronizado();
    expect(screen.getByTestId('custos-veredito-titulo')).toHaveTextContent('2 cosas fuera de lo normal');
    expect(screen.getByRole('tab', { name: 'Servicio' })).toBeInTheDocument();
    expect(screen.getByTestId('custos-sincronizar')).toHaveTextContent('Sincronizar');
  });

  it('erros: bytes_limit e 429 (com segundos) têm texto próprio; o botão vira "tentar de novo"', async () => {
    getOverview.mockRejectedValueOnce(new CostsApiError('bytes_limit', 502));
    const { unmount } = render_();
    await clicar();
    expect(await screen.findByTestId('custos-erro')).toHaveAttribute('data-code', 'admin.custos.errors.bytesLimit');
    expect(screen.getByTestId('custos-sincronizar')).toHaveTextContent('Tentar novamente');
    unmount();
    getOverview.mockRejectedValueOnce(new CostsApiError('sync_rate_limited', 429, 7));
    render_();
    await clicar();
    expect(await screen.findByTestId('custos-erro')).toHaveTextContent('Aguarde 7 s');
  });

  it('D3: troca de mês que falha (429) mantém os dados e o seletor no mês anterior, e mostra o erro com os segundos', async () => {
    await sincronizado();
    getOverview.mockRejectedValueOnce(new CostsApiError('sync_rate_limited', 429, 7));
    await selectCombo(seletor(), 'setembro de 2026');
    expect(await screen.findByTestId('custos-erro')).toHaveTextContent('Aguarde 7 s');
    expect(screen.getByTestId('custos-resultado')).toBeInTheDocument();
    expect(seletor()).toHaveTextContent('outubro de 2026');
    expect(screen.getByTestId('custos-card-mes-valor')).toHaveTextContent(/US\$\s?1\.148,40/);
  });

  it('D3: troca de mês que falha (502) também mantém dados e seletor', async () => {
    await sincronizado();
    getOverview.mockRejectedValueOnce(new CostsApiError('billing_query_failed', 502));
    await selectCombo(seletor(), 'agosto de 2026');
    expect(await screen.findByTestId('custos-erro')).toHaveAttribute('data-code', 'admin.custos.errors.generic');
    expect(screen.getByTestId('custos-resultado')).toBeInTheDocument();
    expect(seletor()).toHaveTextContent('outubro de 2026');
  });

  it('429 no MESMO mês: a leitura fica na tela', async () => {
    await sincronizado();
    getOverview.mockRejectedValueOnce(new CostsApiError('sync_rate_limited', 429, 7));
    await clicar();
    expect(await screen.findByTestId('custos-erro')).toBeInTheDocument();
    expect(screen.getByTestId('custos-resultado')).toBeInTheDocument();
  });

  it('D2: mês fechado — sem aviso de export atrasado (mesmo com dataUntil velho) e com a linha "Mês fechado"', async () => {
    await sincronizado();
    getOverview.mockClear();
    getOverview.mockResolvedValue(overview({
      month: '2026-09', dataUntil: '2026-10-01T10:00:00Z', forecast: { value: null, basis: 'linear', daysCounted: 0 },
      anomalies: { status: 'not_applicable' as const, day: null, rule: { factor: 2, minDelta: 5, windowDays: 7 }, items: [] },
    }));
    await selectCombo(seletor(), 'setembro de 2026');
    await screen.findByTestId('custos-anomalias-mes-fechado');
    expect(screen.queryByTestId('custos-atrasado')).toBeNull();
    expect(screen.queryByTestId('custos-card-previsao')).toBeNull();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getOverview).toHaveBeenCalledWith('2026-09');
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
