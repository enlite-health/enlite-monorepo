/**
 * TherapeuticCatalogPage — a tela de administração de UM catálogo do projeto terapêutico
 * (spec 017, D299). O mesmo componente serve os 3 catálogos, parametrizado por `kind`.
 *
 * Mock só na fronteira: o cliente HTTP, o `useNavigate` e o i18n (resolvido contra o pt-BR.json
 * REAL — chave errada vira a própria chave e o teste quebra). O gate de célula (D286/D269) roda o
 * hook e a store de VERDADE: quem decide é `useAdminAuthStore.setState`, como no
 * `PatientDetailCards.gate.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { selectCombo } from '@presentation/components/atoms/Combobox/testUtils';
import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { TherapeuticCatalogItem, TherapeuticCatalogKind } from '@domain/entities/TherapeuticProject';

// Mesmo conjunto da tela: objetivos e atividades (091 tirou `segments`) + motivos de saída + guardias.
type ManagedCatalogKind = TherapeuticCatalogKind | 'service-exit-reasons' | 'service-shift-templates';

const translations = ptBR as Record<string, any>;

function t(key: string, opts?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current !== 'string') return typeof opts === 'string' ? opts : key;
  return current.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts?.[k] ?? ''));
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const listCatalog = vi.fn();
const createCatalogItem = vi.fn();
const updateCatalogItem = vi.fn();
const listObjectiveCategories = vi.fn();
const removeObjectiveCategory = vi.fn();
const listActivityCategories = vi.fn();
// Guardia predefinida (spec 074): 3 turnos, o último atravessa a meia-noite.
const TEMPLATE = {
  id: 'ativa', code: 'G6_6_12', label: 'Guardia 6 + 6 + 12', active: true,
  items: [{ startTime: '08:00', durationMinutes: 360 }, { startTime: '14:00', durationMinutes: 360 }, { startTime: '20:00', durationMinutes: 720 }],
};
const listShiftTemplates = vi.fn().mockResolvedValue([TEMPLATE]);
vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => ({
  AdminTherapeuticProjectsApiService: {
    listCatalog: (...a: unknown[]) => listCatalog(...a),
    createCatalogItem: (...a: unknown[]) => createCatalogItem(...a),
    updateCatalogItem: (...a: unknown[]) => updateCatalogItem(...a),
    listShiftTemplates: (...a: unknown[]) => listShiftTemplates(...a),
    // 091: o painel de CIDs (aberto pelo chip) fala com a porta pelo mesmo serviço.
    listObjectiveCategories: (...a: unknown[]) => listObjectiveCategories(...a),
    removeObjectiveCategory: (...a: unknown[]) => removeObjectiveCategory(...a),
    listActivityCategories: (...a: unknown[]) => listActivityCategories(...a),
    searchIcdCategories: vi.fn().mockResolvedValue([]),
  },
}));

const { TherapeuticCatalogPage } = await import('../TherapeuticCatalogPage');
const TherapeuticCatalogPageDefault = (await import('../TherapeuticCatalogPage')).default;

const COPY = ptBR.admin.therapeuticCatalog;

/** Chamadas de `listCatalog` ao catálogo da própria tela (a carga dos objetivos que a atividade usa, 091, não conta). */
const itemListCalls = (kind: string = 'specific-objectives') => listCatalog.mock.calls.filter(([k]) => k === kind);

function item(over: Partial<TherapeuticCatalogItem> = {}): TherapeuticCatalogItem {
  return {
    id: 'i1',
    label: 'Mejorar autonomía',
    sortOrder: 1,
    active: true,
    deactivatedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

// 091: item com dono (serviço/objetivo) e vínculo; na tela de atividades a mesma lista serve de lista de objetivos (id 'ativa').
const ATIVA = item({
  id: 'ativa', label: 'Mejorar autonomía', sortOrder: 1,
  serviceCode: 'AT', categoryCount: 3, objectiveId: 'ativa', objectiveLabel: 'Mejorar autonomía', objectiveActive: true, suggestedFrequency: '3 veces por semana',
});
const INATIVA = item({ id: 'inativa', label: 'Opción vieja', sortOrder: 9, active: false, deactivatedAt: '2026-08-01T00:00:00Z' });

/** Liga o contrato ABAC na store (as células e a régua) — como em PatientDetailCards.gate.test.tsx. */
function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

async function renderPage(kind: ManagedCatalogKind = 'specific-objectives') {
  const utils = render(<TherapeuticCatalogPage kind={kind} />);
  await screen.findByTestId('therapeutic-catalog-table');
  return utils;
}

describe('TherapeuticCatalogPage — os 3 catálogos, uma tela cada (D299, decisão do Gabriel 08/09)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sem contrato = engine desligado: a tela abre como sempre abriu (D268).
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
    createCatalogItem.mockResolvedValue(ATIVA);
    updateCatalogItem.mockResolvedValue(ATIVA);
  });

  it.each([
    ['specific-objectives', COPY.kinds.specificObjectives],
    ['activities', COPY.kinds.activities],
    ['service-exit-reasons', COPY.kinds.serviceExitReasons],
    ['service-shift-templates', COPY.kinds.serviceShiftTemplates],
  ] as const)('kind %s: título e subtítulo próprios', async (kind, copy) => {
    await renderPage(kind);
    // ⚠️ `getByRole` e não o `data-testid` do código: o atom `Heading` NÃO repassa `data-*`
    // (medido em 08/09) — o `data-testid="therapeutic-catalog-title"` da página é inerte.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.title);
    expect(screen.getByText(copy.subtitle)).toBeInTheDocument();
  });

  it('motivos de saída: mostra a orientação "sem dado de saúde" (catalog-guidance); os outros kinds não', async () => {
    const { unmount } = await renderPage('service-exit-reasons');
    expect(screen.getByTestId('catalog-guidance')).toHaveTextContent('Categorias genéricas, sem dado de saúde.');
    expect(listCatalog).toHaveBeenCalledWith('service-exit-reasons', { includeInactive: true });
    unmount();
    await renderPage('activities');
    expect(screen.queryByTestId('catalog-guidance')).toBeNull();
  });

  it('pede o catálogo COM inativos — quem administra precisa ver o desligado para reativar', async () => {
    await renderPage('activities');
    expect(listCatalog).toHaveBeenCalledWith('activities', { includeInactive: true });
  });

  it('a tabela mostra texto e estado (sem ordem, spec 061) de cada opção — e nada de enum cru', async () => {
    const { container } = await renderPage();

    expect(screen.getByTestId('therapeutic-catalog-row-ativa')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: COPY.table.order })).toBeNull();
    expect(screen.getByTestId('therapeutic-catalog-label-ativa')).toHaveTextContent('Mejorar autonomía');
    expect(screen.getByTestId('therapeutic-catalog-status-ativa')).toHaveTextContent(COPY.active);
    expect(screen.getByTestId('therapeutic-catalog-status-inativa')).toHaveTextContent(COPY.inactive);
    // A ação da linha inativa é REATIVAR — desativar não apaga (lex C19).
    expect(screen.getByTestId('therapeutic-catalog-toggle-inativa')).toHaveTextContent(COPY.activate);
    expect(screen.getByTestId('therapeutic-catalog-toggle-ativa')).toHaveTextContent(COPY.deactivate);
    expectNoRawEnumLeaks(container);
  });

  it('o default export é o mesmo componente (é como a rota o carrega)', async () => {
    render(<TherapeuticCatalogPageDefault kind="activities" />);
    expect(await screen.findByTestId('therapeutic-catalog-table')).toBeInTheDocument();
  });

  it('nada renderiza chave de i18n crua', async () => {
    await renderPage();
    expect(screen.queryByText(/admin\.therapeuticCatalog/)).toBeNull();
  });
});

describe('TherapeuticCatalogPage — carregando, erro e vazio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('enquanto carrega mostra o esqueleto, não uma tabela vazia', async () => {
    // Uma promessa por chamada (a da lista e a dos segmentos): `libera` resolve todas.
    const pendentes: Array<(v: TherapeuticCatalogItem[]) => void> = [];
    const libera = (v: TherapeuticCatalogItem[]) => pendentes.forEach((r) => r(v));
    listCatalog.mockImplementation(() => new Promise((r) => { pendentes.push(r); }));
    render(<TherapeuticCatalogPage kind="activities" />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-table')).toBeNull();

    libera([ATIVA]);
    await screen.findByTestId('therapeutic-catalog-table');
  });

  it('catálogo vazio mostra o estado vazio, não uma tabela em branco', async () => {
    listCatalog.mockResolvedValue([]);
    render(<TherapeuticCatalogPage kind="activities" />);

    expect(await screen.findByTestId('therapeutic-catalog-empty')).toHaveTextContent(COPY.noItems);
    expect(screen.queryByTestId('therapeutic-catalog-table')).toBeNull();
  });

  it('falha ao carregar aparece na tela (e a tabela não aparece)', async () => {
    listCatalog.mockRejectedValue(new Error('connection refused'));
    render(<TherapeuticCatalogPage kind="activities" />);

    expect(await screen.findByTestId('therapeutic-catalog-load-error')).toHaveTextContent('connection refused');
    expect(screen.queryByTestId('therapeutic-catalog-table')).toBeNull();
  });

  it('falha ao carregar SEM Error (rejeição crua) ainda vira texto na tela', async () => {
    listCatalog.mockRejectedValue('sem message');
    render(<TherapeuticCatalogPage kind="activities" />);

    expect(await screen.findByTestId('therapeutic-catalog-load-error')).toHaveTextContent('sem message');
  });
});

describe('TherapeuticCatalogPage — título, descrição e ordem alfabética (spec 061)', () => {
  const ZETA = item({ id: 'zeta', label: 'Zeta TITULO-SINTETICO', sortOrder: 1, description: 'DESCRIPCION-SINTETICA-Z' });
  const ALFA = item({ id: 'alfa', label: 'Alfa TITULO-SINTETICO', sortOrder: 99 });

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ZETA, ALFA]);
  });

  it.each(['activities', 'specific-objectives'] as const)('%s: sem coluna "Ordem", linhas A–Z apesar do sortOrder, e a descrição aparece', async (kind) => {
    await renderPage(kind);
    expect(screen.queryByRole('columnheader', { name: COPY.table.order })).toBeNull();
    expect(screen.getByRole('columnheader', { name: COPY.table.title })).toBeInTheDocument();
    const linhas = screen.getAllByTestId(/^therapeutic-catalog-row-/).map((r) => r.getAttribute('data-testid'));
    expect(linhas).toEqual(['therapeutic-catalog-row-alfa', 'therapeutic-catalog-row-zeta']);
    expect(screen.getByTestId('therapeutic-catalog-description-zeta')).toHaveTextContent('DESCRIPCION-SINTETICA-Z');
    expect(screen.queryByTestId('therapeutic-catalog-description-alfa')).toBeNull();
  });

  it('a descrição usa o token de texto com contraste AAA (#374151 = 10,3:1 sobre branco), não o muted translúcido', async () => {
    await renderPage('activities');
    const d = screen.getByTestId('therapeutic-catalog-description-zeta');
    expect(d).toHaveClass('text-[#374151]');
    expect(d).not.toHaveClass('text-gray-700');
  });

  it('motivos de saída: a coluna Ordem continua e a ordem é a do servidor', async () => {
    await renderPage('service-exit-reasons');
    expect(screen.getByRole('columnheader', { name: COPY.table.order })).toBeInTheDocument();
    const linhas = screen.getAllByTestId(/^therapeutic-catalog-row-/).map((r) => r.getAttribute('data-testid'));
    expect(linhas).toEqual(['therapeutic-catalog-row-zeta', 'therapeutic-catalog-row-alfa']);
    expect(screen.queryByTestId('therapeutic-catalog-description-zeta')).toBeNull();
  });
});

describe('TherapeuticCatalogPage — criar e renomear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
    createCatalogItem.mockResolvedValue(ATIVA);
    updateCatalogItem.mockResolvedValue(ATIVA);
  });

  it('criar: abre a modal vazia, POSTa e recarrega a lista', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));

    const modal = screen.getByTestId('therapeutic-catalog-form-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-label-input')).toHaveValue('');

    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Nueva opción' } });
    await selectCombo(screen.getByTestId('therapeutic-catalog-objective-select'), 'Mejorar autonomía');
    // Spec 061: atividade não tem input de ordem.
    expect(screen.queryByTestId('therapeutic-catalog-order-input')).toBeNull();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('activities', { label: 'Nueva opción', objectiveId: 'ativa' }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(itemListCalls('activities')).toHaveLength(2);
    expect(updateCatalogItem).not.toHaveBeenCalled();
  });

  it('editar: a modal abre com o texto atual e o salvar vira PATCH naquele id (D299 — sem DELETE)', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-ativa'));

    expect(screen.getByTestId('therapeutic-catalog-label-input')).toHaveValue('Mejorar autonomía');
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Autonomía en el hogar' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    // Merge Patch (spec 061): só o título mudou, só ele viaja — a ordem não é mais da tela.
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('activities', 'ativa', { label: 'Autonomía en el hogar' }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(itemListCalls('activities')).toHaveLength(2);
    expect(createCatalogItem).not.toHaveBeenCalled();
  });

  it('fechar a modal pelo X não grava nada nem recarrega', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-close'));

    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(createCatalogItem).not.toHaveBeenCalled();
    expect(itemListCalls()).toHaveLength(1);
  });

  it('a recusa do servidor ao salvar fica DENTRO da modal — a lista não recarrega', async () => {
    createCatalogItem.mockRejectedValue(Object.assign(new Error('Label already exists'), { status: 409 }));
    await renderPage();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Repetida' } });
    await selectCombo(screen.getByTestId('therapeutic-catalog-service-select'), COPY.serviceAT);
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    expect(await screen.findByTestId('therapeutic-catalog-form-error')).toHaveTextContent(COPY.errors.duplicate);
    expect(screen.getByTestId('therapeutic-catalog-form-modal')).toBeInTheDocument();
    expect(itemListCalls()).toHaveLength(1);
  });
});

describe('TherapeuticCatalogPage — (des)ativar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
    updateCatalogItem.mockResolvedValue(ATIVA);
  });

  it('desativar manda active:false; reativar manda active:true — e recarrega', async () => {
    await renderPage('specific-objectives');

    fireEvent.click(screen.getByTestId('therapeutic-catalog-toggle-ativa'));
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('specific-objectives', 'ativa', { active: false }));

    fireEvent.click(screen.getByTestId('therapeutic-catalog-toggle-inativa'));
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('specific-objectives', 'inativa', { active: true }));
    await waitFor(() => expect(itemListCalls()).toHaveLength(3));
    expect(screen.queryByTestId('therapeutic-catalog-action-error')).toBeNull();
  });

  it('recusa ao (des)ativar aparece no banner da tela, traduzida (lex C18/C19)', async () => {
    updateCatalogItem.mockRejectedValue(Object.assign(new Error('label contains personal data'), { status: 400 }));
    await renderPage();

    fireEvent.click(screen.getByTestId('therapeutic-catalog-toggle-ativa'));

    const banner = await screen.findByTestId('therapeutic-catalog-action-error');
    expect(banner).toHaveTextContent(COPY.errors.invalidLabel);
    expect(banner).toHaveAttribute('role', 'alert');
    // A linha continua na tela: a recusa não some com o dado.
    expect(screen.getByTestId('therapeutic-catalog-row-ativa')).toBeInTheDocument();
    // E não recarregou (o `fetchItems` do sucesso não roda).
    expect(itemListCalls()).toHaveLength(1);
  });

  it('o banner de erro some quando a operação seguinte dá certo', async () => {
    updateCatalogItem.mockRejectedValueOnce(new Error('boom'));
    await renderPage();

    fireEvent.click(screen.getByTestId('therapeutic-catalog-toggle-ativa'));
    expect(await screen.findByTestId('therapeutic-catalog-action-error')).toHaveTextContent('boom');

    updateCatalogItem.mockResolvedValue(ATIVA);
    fireEvent.click(screen.getByTestId('therapeutic-catalog-toggle-ativa'));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-action-error')).toBeNull());
  });
});

// ── D286 / D269 — a trava de rota (célula de LEITURA) e as ações (célula de ESCRITA) ──
// Um recurso por catálogo: `catalog_therapeutic_objectives`, `catalog_therapeutic_activities`,
// `catalog_pathology_types`. Célula de outro catálogo NÃO abre esta tela.

describe('TherapeuticCatalogPage — trava de rota pela célula de leitura (D286)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA]);
  });

  it('🔴 engine ON sem a célula de leitura: manda embora para /admin', async () => {
    comEnforcement([], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
  });

  it('🔴 engine ON com a célula de OUTRO catálogo não abre esta tela', async () => {
    comEnforcement(['catalog_therapeutic_activities:read'], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
  });

  it.each([
    ['specific-objectives', 'catalog_therapeutic_objectives'],
    ['activities', 'catalog_therapeutic_activities'],
    ['service-exit-reasons', 'catalog_service_exit_reasons'],
    ['service-shift-templates', 'catalog_service_shift_templates'],
  ] as const)('engine ON com %s:read não redireciona', async (kind, resource) => {
    comEnforcement([`${resource}:read`], 'on');
    render(<TherapeuticCatalogPage kind={kind} />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('engine OFF sem célula nenhuma: a rota não redireciona (freio de rollout, D268)', async () => {
    comEnforcement([], 'off');
    render(<TherapeuticCatalogPage kind="activities" />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('TherapeuticCatalogPage — write-gate das ações (D269)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
  });

  it('🔴 engine ON com só :read — o botão "Nova opção" e as ações de linha SOMEM', async () => {
    comEnforcement(['catalog_therapeutic_objectives:read'], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await screen.findByTestId('therapeutic-catalog-table');

    expect(screen.queryByTestId('therapeutic-catalog-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-edit-ativa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-toggle-ativa')).not.toBeInTheDocument();
    // A linha e o dado continuam lá — quem só lê, lê.
    expect(screen.getByTestId('therapeutic-catalog-label-ativa')).toBeInTheDocument();
  });

  it.each([
    ['specific-objectives', 'catalog_therapeutic_objectives'],
    ['activities', 'catalog_therapeutic_activities'],
    ['service-exit-reasons', 'catalog_service_exit_reasons'],
    ['service-shift-templates', 'catalog_service_shift_templates'],
  ] as const)('engine ON com %s:create + :update (PR-8b) — as ações existem', async (kind, resource) => {
    comEnforcement([`${resource}:read`, `${resource}:create`, `${resource}:update`], 'on');
    render(<TherapeuticCatalogPage kind={kind} />);
    await screen.findByTestId('therapeutic-catalog-table');

    expect(screen.getByTestId('therapeutic-catalog-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-edit-ativa')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-toggle-ativa')).toBeInTheDocument();
  });

  it('🔴 a escrita de OUTRO catálogo não libera as ações desta tela', async () => {
    comEnforcement(['catalog_therapeutic_objectives:read', 'catalog_therapeutic_activities:create', 'catalog_therapeutic_activities:update'], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await screen.findByTestId('therapeutic-catalog-table');

    expect(screen.queryByTestId('therapeutic-catalog-edit-ativa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-new-btn')).not.toBeInTheDocument();
  });

  it('🔴 motivos de saída: só :read (ou a escrita de OUTRO catálogo) esconde as ações — o gate é catalog_service_exit_reasons:update', async () => {
    comEnforcement(['catalog_service_exit_reasons:read', 'catalog_therapeutic_activities:update'], 'on');
    render(<TherapeuticCatalogPage kind="service-exit-reasons" />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(screen.queryByTestId('therapeutic-catalog-edit-ativa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-toggle-ativa')).not.toBeInTheDocument();
  });

  it('engine OFF (ou contrato ausente): tudo existe mesmo sem célula', async () => {
    render(<TherapeuticCatalogPage kind="activities" />);
    await screen.findByTestId('therapeutic-catalog-table');

    expect(screen.getByTestId('therapeutic-catalog-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-edit-ativa')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-toggle-ativa')).toBeInTheDocument();
  });
});

// ── 091 — colunas por kind, filtros, painel de CIDs e campos novos; sem Segmento ───────────────────

describe('TherapeuticCatalogPage — colunas por kind (091, §9.7)', () => {
  const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
  });

  it('objetivos: Título · Descripción · Serviço · CID-11 · Estado (+ Ações) — sem Segmento nem Ordem', async () => {
    await renderPage('specific-objectives');
    expect(headers()).toEqual([COPY.table.title, COPY.table.description, COPY.service, COPY.icdCategories, COPY.table.status, COPY.table.actions]);
    expect(screen.queryByRole('columnheader', { name: /segmento|segment/i })).toBeNull();
    expect(screen.getByTestId('therapeutic-catalog-service-ativa')).toHaveTextContent(COPY.serviceAT);
    expect(screen.getByTestId('therapeutic-catalog-icd-ativa')).toHaveTextContent('3 categorias');
    expect(screen.getByTestId('therapeutic-catalog-icd-inativa')).toHaveTextContent('0 categorias');
    expect(screen.getByTestId('therapeutic-catalog-row-inativa')).toHaveTextContent('—');
  });

  it('atividades: Título · Descripción · Objetivo · Frecuencia sugerida · CID-11 · Estado (+ Ações)', async () => {
    await renderPage('activities');
    expect(headers()).toEqual([COPY.table.title, COPY.table.description, COPY.objective, COPY.frequency, COPY.icdCategories, COPY.table.status, COPY.table.actions]);
    expect(screen.getByTestId('therapeutic-catalog-objective-ativa')).toHaveTextContent('Mejorar autonomía');
    expect(screen.getByTestId('therapeutic-catalog-frequency-ativa')).toHaveTextContent('3 veces por semana');
    expect(screen.getByTestId('therapeutic-catalog-icd-ativa')).toHaveTextContent('3 categorias');
  });

  it('atividade cujo objetivo está inativo mostra a marca de inativo', async () => {
    listCatalog.mockResolvedValue([item({ id: 'a2', objectiveId: 'o9', objectiveLabel: 'Objetivo SINTETICO', objectiveActive: false })]);
    await renderPage('activities');
    expect(screen.getByTestId('therapeutic-catalog-objective-a2')).toHaveTextContent(`Objetivo SINTETICO (${COPY.inactive})`);
  });

  it.each(['service-exit-reasons', 'service-shift-templates'] as const)('%s: sem colunas de serviço, objetivo, frequência nem CID-11, e sem filtros', async (kind) => {
    await renderPage(kind);
    for (const nome of [COPY.service, COPY.objective, COPY.frequency, COPY.icdCategories]) {
      expect(screen.queryByRole('columnheader', { name: nome })).toBeNull();
    }
    expect(screen.queryByTestId('therapeutic-catalog-filters')).toBeNull();
  });

  it('nenhum kind carrega a lista de segmentos (a chamada some com o Segmento)', async () => {
    await renderPage('specific-objectives');
    await renderPage('activities');
    expect(listCatalog.mock.calls.map(([k]) => k)).not.toContain('segments');
  });
});

describe('TherapeuticCatalogPage — filtros (091, DD-20)', () => {
  const OBJ_CUIDADO = item({ id: 'cuid', label: 'Objetivo cuidado SINTETICO', serviceCode: 'CAREGIVER', categoryCount: 1 });

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, OBJ_CUIDADO]);
  });

  it('o filtro de CID-11 se chama "Vinculado a CID-11" (vínculo existe, não "elegível na cascata")', async () => {
    await renderPage('specific-objectives');
    expect(screen.getByLabelText(COPY.filterIcd)).toBe(screen.getByTestId('therapeutic-catalog-filter-icd'));
    expect(COPY.filterIcd).toBe('Vinculado a CID-11');
  });

  it('objetivos: filtro de Serviço esconde as linhas de outro serviço', async () => {
    await renderPage('specific-objectives');
    expect(screen.getByTestId('therapeutic-catalog-row-cuid')).toBeInTheDocument();
    await selectCombo(screen.getByTestId('therapeutic-catalog-filter-service'), COPY.serviceAT);
    expect(screen.getByTestId('therapeutic-catalog-row-ativa')).toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-row-cuid')).toBeNull();
  });

  it('CID-11 só consulta com o código completo (4 caracteres) e manda `categoryCode` em maiúsculas', async () => {
    await renderPage('specific-objectives');
    const input = screen.getByTestId('therapeutic-catalog-filter-icd');
    fireEvent.change(input, { target: { value: '6a0' } });
    expect(itemListCalls()).toHaveLength(1);
    fireEvent.change(input, { target: { value: '6a02' } });
    await waitFor(() => expect(listCatalog).toHaveBeenCalledWith('specific-objectives', { includeInactive: true, categoryCode: '6A02' }));
    // limpar volta à lista sem filtro
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(itemListCalls()).toHaveLength(3));
    expect(itemListCalls()[2]).toEqual(['specific-objectives', { includeInactive: true }]);
  });

  it('o campo do filtro continua na tela enquanto a lista recarrega (o foco não se perde)', async () => {
    await renderPage('specific-objectives');
    const input = screen.getByTestId('therapeutic-catalog-filter-icd');
    fireEvent.change(input, { target: { value: '6A02' } });
    await waitFor(() => expect(itemListCalls()).toHaveLength(2));
    expect(screen.getByTestId('therapeutic-catalog-filter-icd')).toBe(input);
  });

  it('atividades: filtros de Objetivo (manda `objectiveId`) e de CID-11 (`categoryCode`) juntos', async () => {
    await renderPage('activities');
    await selectCombo(screen.getByTestId('therapeutic-catalog-filter-objective'), 'Mejorar autonomía');
    await waitFor(() => expect(listCatalog).toHaveBeenCalledWith('activities', { includeInactive: true, objectiveId: 'ativa' }));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-filter-icd'), { target: { value: '6A02' } });
    await waitFor(() => expect(listCatalog).toHaveBeenCalledWith('activities', { includeInactive: true, categoryCode: '6A02', objectiveId: 'ativa' }));
  });

  it('atividades: sem o filtro de Serviço; objetivos: sem o filtro de Objetivo', async () => {
    const { unmount } = await renderPage('activities');
    expect(screen.queryByTestId('therapeutic-catalog-filter-service')).toBeNull();
    unmount();
    await renderPage('specific-objectives');
    expect(screen.queryByTestId('therapeutic-catalog-filter-objective')).toBeNull();
  });
});

describe('TherapeuticCatalogPage — painel de CIDs ligado ao chip (091)', () => {
  const LINKS = { total: 2, items: [{ code: '6A02', title: 'Trastorno SINTETICO', activityLinks: 0 }, { code: '6A05', title: null, activityLinks: 0 }] };

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA]);
    listObjectiveCategories.mockResolvedValue(LINKS);
    listActivityCategories.mockResolvedValue(LINKS);
    removeObjectiveCategory.mockResolvedValue({});
  });

  it('o chip do objetivo abre o painel com as categorias dele', async () => {
    await renderPage('specific-objectives');
    expect(screen.queryByTestId('therapeutic-catalog-cid-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-icd-ativa'));
    expect(await screen.findByTestId('therapeutic-catalog-cid-panel')).toBeInTheDocument();
    await waitFor(() => expect(listObjectiveCategories).toHaveBeenCalledWith('ativa'));
    expect(await screen.findByTestId('cid-panel-row-6A02')).toHaveTextContent('6A02 — Trastorno SINTETICO');
    expect(screen.getByTestId('cid-panel-item')).toHaveTextContent('Mejorar autonomía');
  });

  it('o chip da atividade abre o painel de atividade (lista as categorias DA atividade)', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-icd-ativa'));
    await waitFor(() => expect(listActivityCategories).toHaveBeenCalledWith('ativa'));
    expect(listObjectiveCategories).toHaveBeenCalledWith('ativa'); // candidatos do select = categorias do objetivo dono
  });

  it('com :update o painel deixa Quitar e, ao quitar, a lista da tela recarrega (contagem do chip)', async () => {
    await renderPage('specific-objectives');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-icd-ativa'));
    fireEvent.click(await screen.findByTestId('cid-panel-remove-6A02'));
    await waitFor(() => expect(removeObjectiveCategory).toHaveBeenCalledWith('ativa', '6A02'));
    await waitFor(() => expect(itemListCalls()).toHaveLength(2));
  });

  it('🔴 engine ON com só :read — painel só leitura: linhas sim, Agregar/Quitar não', async () => {
    comEnforcement(['catalog_therapeutic_objectives:read'], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await screen.findByTestId('therapeutic-catalog-table');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-icd-ativa'));
    expect(await screen.findByTestId('cid-panel-row-6A02')).toBeInTheDocument();
    expect(screen.queryByTestId('cid-panel-remove-6A02')).toBeNull();
    expect(screen.queryByTestId('cid-panel-add')).toBeNull();
  });

  it('engine ON com :update — o painel tem Agregar', async () => {
    comEnforcement(['catalog_therapeutic_objectives:read', 'catalog_therapeutic_objectives:update'], 'on');
    render(<TherapeuticCatalogPage kind="specific-objectives" />);
    await screen.findByTestId('therapeutic-catalog-table');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-icd-ativa'));
    expect(await screen.findByTestId('cid-panel-add')).toBeInTheDocument();
  });
});

describe('TherapeuticCatalogPage — modal com os campos novos (091, DD-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([ATIVA, INATIVA]);
    createCatalogItem.mockResolvedValue(ATIVA);
    updateCatalogItem.mockResolvedValue(ATIVA);
  });

  it('objetivo: criar exige o Serviço e o POST leva `serviceCode` (sem `segmentId`)', async () => {
    await renderPage('specific-objectives');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Objetivo nuevo SINTETICO' } });
    expect(screen.getByTestId('therapeutic-catalog-form-save')).toBeDisabled();
    await selectCombo(screen.getByTestId('therapeutic-catalog-service-select'), COPY.serviceCAREGIVER);
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('specific-objectives', { label: 'Objetivo nuevo SINTETICO', serviceCode: 'CAREGIVER' }));
    expect(screen.queryByTestId('therapeutic-catalog-segment-select')).toBeNull();
  });

  it('atividade: criar escolhe o Objetivo (lista da tela) e a Frecuencia; o POST leva os dois', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Atividade nueva SINTETICA' } });
    await selectCombo(screen.getByTestId('therapeutic-catalog-objective-select'), 'Mejorar autonomía');
    fireEvent.change(screen.getByTestId('therapeutic-catalog-frequency-input'), { target: { value: 'Diaria' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('activities', { label: 'Atividade nueva SINTETICA', objectiveId: 'ativa', suggestedFrequency: 'Diaria' }));
  });

  it('atividade: esvaziar a Frecuencia no editar manda `suggestedFrequency: null` explícito no PATCH (DD-24)', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-ativa'));
    expect(screen.getByTestId('therapeutic-catalog-frequency-input')).toHaveValue('3 veces por semana');
    fireEvent.change(screen.getByTestId('therapeutic-catalog-frequency-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('activities', 'ativa', { suggestedFrequency: null }));
  });

  it('objetivo: trocar só o Serviço no editar viaja SÓ `serviceCode`', async () => {
    await renderPage('specific-objectives');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-ativa'));
    await selectCombo(screen.getByTestId('therapeutic-catalog-service-select'), COPY.serviceCAREGIVER);
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('specific-objectives', 'ativa', { serviceCode: 'CAREGIVER' }));
  });
});

describe('TherapeuticCatalogPage — guardias predefinidas (spec 074)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listShiftTemplates.mockResolvedValue([TEMPLATE]);
  });

  it('P1 guardias: lista mostra os turnos de cada guardia', async () => {
    await renderPage('service-shift-templates');
    expect(listShiftTemplates).toHaveBeenCalledWith({ includeInactive: true });
    expect(listCatalog).not.toHaveBeenCalled();
    expect(screen.queryByRole('columnheader', { name: COPY.table.order })).toBeNull();
    expect(screen.getByTestId('therapeutic-catalog-label-ativa')).toHaveTextContent('Guardia 6 + 6 + 12');
    expect(screen.getByTestId('therapeutic-catalog-shifts-ativa')).toHaveTextContent('08:00 – 14:00 · 14:00 – 20:00 · 20:00 – 08:00');
  });

  it('P2 guardias sem update: sem botões de criar e editar', async () => {
    comEnforcement(['catalog_service_shift_templates:read', 'catalog_service_exit_reasons:update'], 'on');
    render(<TherapeuticCatalogPage kind="service-shift-templates" />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(screen.queryByTestId('therapeutic-catalog-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-edit-ativa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-toggle-ativa')).not.toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-shifts-ativa')).toBeInTheDocument();
  });
});
