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
import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { TherapeuticCatalogItem, TherapeuticCatalogKind } from '@domain/entities/TherapeuticProject';

// Esta tela administra só objetivos/atividades — `segments` não tem tela própria (task 7.7, fora do escopo).
type ManagedCatalogKind = Exclude<TherapeuticCatalogKind, 'segments'>;

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
vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => ({
  AdminTherapeuticProjectsApiService: {
    listCatalog: (...a: unknown[]) => listCatalog(...a),
    createCatalogItem: (...a: unknown[]) => createCatalogItem(...a),
    updateCatalogItem: (...a: unknown[]) => updateCatalogItem(...a),
  },
}));

const { TherapeuticCatalogPage } = await import('../TherapeuticCatalogPage');
const TherapeuticCatalogPageDefault = (await import('../TherapeuticCatalogPage')).default;

const COPY = ptBR.admin.therapeuticCatalog;

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

const ATIVA = item({ id: 'ativa', label: 'Mejorar autonomía', sortOrder: 1 });
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
  ] as const)('kind %s: título e subtítulo próprios', async (kind, copy) => {
    await renderPage(kind);
    // ⚠️ `getByRole` e não o `data-testid` do código: o atom `Heading` NÃO repassa `data-*`
    // (medido em 08/09) — o `data-testid="therapeutic-catalog-title"` da página é inerte.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.title);
    expect(screen.getByText(copy.subtitle)).toBeInTheDocument();
  });

  it('pede o catálogo COM inativos — quem administra precisa ver o desligado para reativar', async () => {
    await renderPage('activities');
    expect(listCatalog).toHaveBeenCalledWith('activities', { includeInactive: true });
  });

  it('a tabela mostra ordem, texto e estado de cada opção — e nada de enum cru', async () => {
    const { container } = await renderPage();

    const linha = screen.getByTestId('therapeutic-catalog-row-ativa');
    expect(linha).toHaveTextContent('1');
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
    let libera: (v: TherapeuticCatalogItem[]) => void = () => {};
    listCatalog.mockImplementation(() => new Promise((r) => { libera = r; }));
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
    fireEvent.change(screen.getByTestId('therapeutic-catalog-order-input'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('activities', { label: 'Nueva opción', sortOrder: 4 }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(listCatalog).toHaveBeenCalledTimes(2);
    expect(updateCatalogItem).not.toHaveBeenCalled();
  });

  it('editar: a modal abre com o texto atual e o salvar vira PATCH naquele id (D299 — sem DELETE)', async () => {
    await renderPage('activities');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-ativa'));

    expect(screen.getByTestId('therapeutic-catalog-label-input')).toHaveValue('Mejorar autonomía');
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Autonomía en el hogar' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    // A ordem já preenchida na modal viaja junto — renomear não perde a posição da opção.
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('activities', 'ativa', { label: 'Autonomía en el hogar', sortOrder: 1 }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(listCatalog).toHaveBeenCalledTimes(2);
    expect(createCatalogItem).not.toHaveBeenCalled();
  });

  it('fechar a modal pelo X não grava nada nem recarrega', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-close'));

    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(createCatalogItem).not.toHaveBeenCalled();
    expect(listCatalog).toHaveBeenCalledTimes(1);
  });

  it('a recusa do servidor ao salvar fica DENTRO da modal — a lista não recarrega', async () => {
    createCatalogItem.mockRejectedValue(Object.assign(new Error('Label already exists'), { status: 409 }));
    await renderPage();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Repetida' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    expect(await screen.findByTestId('therapeutic-catalog-form-error')).toHaveTextContent(COPY.errors.duplicate);
    expect(screen.getByTestId('therapeutic-catalog-form-modal')).toBeInTheDocument();
    expect(listCatalog).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(listCatalog).toHaveBeenCalledTimes(3));
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
    expect(listCatalog).toHaveBeenCalledTimes(1);
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

  it('engine OFF (ou contrato ausente): tudo existe mesmo sem célula', async () => {
    render(<TherapeuticCatalogPage kind="activities" />);
    await screen.findByTestId('therapeutic-catalog-table');

    expect(screen.getByTestId('therapeutic-catalog-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-edit-ativa')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-toggle-ativa')).toBeInTheDocument();
  });
});
