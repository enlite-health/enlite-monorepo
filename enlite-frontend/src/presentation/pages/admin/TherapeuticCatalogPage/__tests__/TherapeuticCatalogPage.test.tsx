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

// Mesmo conjunto da tela: os 3 catálogos do projeto terapêutico (inclui `segments`, spec 030) + motivos de saída.
type ManagedCatalogKind = TherapeuticCatalogKind | 'service-exit-reasons';

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

/** Chamadas de `listCatalog` ao catálogo da própria tela (a carga dos segmentos, spec 030, não conta). */
const itemListCalls = () => listCatalog.mock.calls.filter(([k]) => k !== 'segments');

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
    ['service-exit-reasons', COPY.kinds.serviceExitReasons],
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
    expect(itemListCalls()).toHaveLength(2);
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
    expect(itemListCalls()).toHaveLength(2);
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

// ── Spec 030 (F1) — `segments` ganha tela: o MESMO componente, `kind="segments"` ──────────────────

describe('TherapeuticCatalogPage — kind segments (spec 030)', () => {
  const SEG = item({ id: 'seg1', label: 'AT para Pacientes con TEA', sortOrder: 4 });

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listCatalog.mockResolvedValue([SEG]);
    createCatalogItem.mockResolvedValue(SEG);
  });

  it('segments: lista o catálogo COM inativos, com título e subtítulo próprios', async () => {
    await renderPage('segments');
    expect(listCatalog).toHaveBeenCalledWith('segments', { includeInactive: true });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(COPY.kinds.segments.title);
    expect(screen.getByText(COPY.kinds.segments.subtitle)).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-label-seg1')).toHaveTextContent('AT para Pacientes con TEA');
  });

  it('segments: cria pela modal — POST no kind segments e recarrega a lista', async () => {
    await renderPage('segments');
    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Segmento nuevo' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));

    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('segments', { label: 'Segmento nuevo', sortOrder: undefined }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());
    expect(listCatalog).toHaveBeenCalledTimes(2);
  });

  it('segments: engine ON com :read abre a tela mas SEM ações; a escrita de OUTRO catálogo não as libera', async () => {
    comEnforcement(['catalog_therapeutic_segments:read', 'catalog_therapeutic_activities:update'], 'on');
    render(<TherapeuticCatalogPage kind="segments" />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('therapeutic-catalog-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-edit-seg1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-catalog-toggle-seg1')).not.toBeInTheDocument();
  });

  it('segments: engine ON com read+create+update — as ações existem; sem :read manda para /admin', async () => {
    comEnforcement(['catalog_therapeutic_segments:read', 'catalog_therapeutic_segments:create', 'catalog_therapeutic_segments:update'], 'on');
    const { unmount } = render(<TherapeuticCatalogPage kind="segments" />);
    await screen.findByTestId('therapeutic-catalog-table');
    expect(screen.getByTestId('therapeutic-catalog-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-toggle-seg1')).toBeInTheDocument();
    unmount();

    comEnforcement([], 'on');
    render(<TherapeuticCatalogPage kind="segments" />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
  });
});

// ── Spec 030 (F4) — coluna "Segmento" e o vínculo no objetivo/atividade ─────────────────────────────

describe('TherapeuticCatalogPage — vínculo de segmento (spec 030, F4)', () => {
  const SEG_ON = item({ id: 'seg-on', label: 'AT para Pacientes con TEA', sortOrder: 1 });
  const SEG_OFF = item({ id: 'seg-off', label: 'Segmento viejo', sortOrder: 2, active: false });
  const OBJ = item({ id: 'obj1', label: 'Mejorar autonomía', segmentId: 'seg-on' });
  const OBJ_OFF = item({ id: 'obj2', label: 'Otro objetivo', sortOrder: 2, segmentId: 'seg-off' });
  const OBJ_LIVRE = item({ id: 'obj3', label: 'Sin segmento', sortOrder: 3, segmentId: null });

  function respondePorKind(segments: TherapeuticCatalogItem[] | Error) {
    listCatalog.mockImplementation(async (kind: string) => {
      if (kind !== 'segments') return [OBJ, OBJ_OFF, OBJ_LIVRE];
      if (segments instanceof Error) throw segments;
      return segments;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    updateCatalogItem.mockResolvedValue(OBJ);
    createCatalogItem.mockResolvedValue(OBJ);
  });

  it('coluna "Segmento": rótulo resolvido por id no front; "(inactivo)" no desligado; "—" sem vínculo', async () => {
    respondePorKind([SEG_ON, SEG_OFF]);
    await renderPage('specific-objectives');
    expect(listCatalog).toHaveBeenCalledWith('segments', { includeInactive: true });
    expect(screen.getByRole('columnheader', { name: COPY.table.segment })).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-catalog-segment-obj1')).toHaveTextContent('AT para Pacientes con TEA');
    expect(screen.getByTestId('therapeutic-catalog-segment-obj2')).toHaveTextContent('Segmento viejo (inactivo)');
    expect(screen.getByTestId('therapeutic-catalog-segment-obj3')).toHaveTextContent('—');
  });

  it('403 na lista de segmentos (allSettled → null): a coluna e o campo SOMEM, a tela abre', async () => {
    respondePorKind(Object.assign(new Error('forbidden'), { status: 403 }));
    await renderPage('activities');
    expect(screen.queryByRole('columnheader', { name: COPY.table.segment })).toBeNull();
    expect(screen.queryByTestId('therapeutic-catalog-segment-obj1')).toBeNull();
    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-obj1'));
    expect(screen.queryByTestId('therapeutic-catalog-segment-select')).toBeNull();
  });

  it('PATCH leva `segmentId` (trocar) e `null` (limpar); POST leva o escolhido', async () => {
    respondePorKind([SEG_ON, SEG_OFF]);
    await renderPage('specific-objectives');

    fireEvent.click(screen.getByTestId('therapeutic-catalog-edit-obj2'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-segment-select'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(updateCatalogItem).toHaveBeenCalledWith('specific-objectives', 'obj2', { label: 'Otro objetivo', sortOrder: 2, segmentId: null }));
    await waitFor(() => expect(screen.queryByTestId('therapeutic-catalog-form-modal')).toBeNull());

    fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
    fireEvent.change(screen.getByTestId('therapeutic-catalog-label-input'), { target: { value: 'Nuevo objetivo' } });
    fireEvent.change(screen.getByTestId('therapeutic-catalog-segment-select'), { target: { value: 'seg-on' } });
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-save'));
    await waitFor(() => expect(createCatalogItem).toHaveBeenCalledWith('specific-objectives', { label: 'Nuevo objetivo', segmentId: 'seg-on' }));
  });

  it('kind="segments": não carregam segmentos, sem coluna e sem campo na modal', async () => {
    for (const kind of ['segments'] as const) {
      listCatalog.mockClear();
      listCatalog.mockResolvedValue([SEG_ON]);
      const { unmount } = await renderPage(kind);
      expect(listCatalog).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('columnheader', { name: COPY.table.segment })).toBeNull();
      fireEvent.click(screen.getByTestId('therapeutic-catalog-new-btn'));
      expect(screen.queryByTestId('therapeutic-catalog-segment-select')).toBeNull();
      unmount();
    }
  });
});
