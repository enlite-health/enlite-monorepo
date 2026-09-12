/**
 * TherapeuticProjectDrawer — a modal larga do projeto terapêutico (spec 017 F4, Figma `6017:14962`).
 *
 * O que estes testes seguram:
 *  · lex C13 — "Exportar PDF" busca a versão no servidor A CADA clique, com `purpose: 'export'`.
 *    É ESSA chamada que deixa a linha `export_pdf` na trilha; reusar a versão que a tela já tinha
 *    geraria o mesmo PDF sem trilha nenhuma. A asserção é sobre a CHAMADA, não sobre o arquivo.
 *  · lex C12 — o insumo do PDF é montado com as células de container já lidas (`reads`), as mesmas
 *    dos cards; o PDF não pergunta nada a mais ao servidor.
 *  · D286/D269 — "Editar" é `ActionButton` sob `patient_therapeutic_project:write`: com o engine
 *    LIGADO e sem a célula, o botão SOME (não fica cinza). Com o engine desligado, aparece.
 *  · lex C5 — versão ANULADA não exporta nem vira origem de versão nova.
 *  · A recusa do servidor vira frase de tela por `code` (`saveRefusalMessage`), nunca o corpo cru.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticCatalogItem, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import type { AuthzContract } from '@domain/entities/Authz';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

// ── i18n mock (molde `PatientDetailCards.gate.test.tsx`) ─────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

// O tradutor FIXO em es-AR do PDF (D299.7): o documento não segue o idioma do painel.
vi.mock('@infrastructure/i18n/config', () => ({
  default: { getFixedT: () => (key: string, fallback?: string) => fallback ?? `es:${key}` },
}));

// ── Dublês de I/O ────────────────────────────────────────────────────────────

const mockListCatalog = vi.fn();
const mockCreateVersion = vi.fn();
const mockGetVersion = vi.fn();

vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => {
  class TherapeuticProjectApiError extends Error {
    readonly status: number;
    readonly code?: string;
    constructor(message: string, status: number, body?: { code?: string }) {
      super(message);
      this.name = 'TherapeuticProjectApiError';
      this.status = status;
      this.code = body?.code;
    }
  }
  return {
    TherapeuticProjectApiError,
    AdminTherapeuticProjectsApiService: {
      listCatalog: (...a: unknown[]) => mockListCatalog(...a),
      createVersion: (...a: unknown[]) => mockCreateVersion(...a),
      getVersion: (...a: unknown[]) => mockGetVersion(...a),
    },
  };
});

const mockRenderBlob = vi.fn();
vi.mock('../pdf/renderTherapeuticProjectPdf', () => ({
  renderTherapeuticProjectPdfBlob: (...a: unknown[]) => mockRenderBlob(...a),
  pdfFileName: (input: { caseRef: string; version: { version: string } }) =>
    `proyecto-terapeutico-caso-${input.caseRef}-${input.version.version.replace(/\./g, '_')}.pdf`,
}));

// O combobox de CID não é o objeto deste teste (REQ-21: o código nunca sai dele).
vi.mock('../../edit/IcdSearchCombobox', () => ({
  IcdSearchCombobox: () => <div data-testid="icd-stub" />,
}));

import { TherapeuticProjectApiError } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import { TherapeuticProjectDrawer, type TherapeuticProjectTarget } from '../TherapeuticProjectDrawer';
import { saveRefusalMessage } from '../saveRefusalMessage';

// ── Insumos ──────────────────────────────────────────────────────────────────

const tf = (k: string) => (ptBR.admin.patients.detail.therapeuticProjectForm as Record<string, any>)[k] as string;
const tfErr = (k: string) => (ptBR.admin.patients.detail.therapeuticProjectForm.errors as Record<string, any>)[k] as string;

const SERVICO: PatientContractedServiceDetail = {
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 1,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: null,
  hourlyValueRedacted: false,
  startDate: null,
  contractType: null,
  taxCondition: null,
  supervisionFrequency: null,
  guardShift: null,
  providerAgeBand: null,
  addressId: null,
  liveVacancyId: null,
  schedule: null,
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: [],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const PACIENTE: PatientDetail = {
  ...patientDetailFixture,
  contractedServices: [SERVICO],
  diagnoses: [{ id: 'd1', uri: 'urn:icd:A', title: 'Diagnóstico A', isPrimary: true, source: 'panel', active: true }],
};

const item = (id: string, label: string): TherapeuticCatalogItem => ({
  id,
  label,
  sortOrder: 1,
  active: true,
  deactivatedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});

const VERSAO: TherapeuticProjectVersion = {
  id: 'v1',
  patientId: PACIENTE.id,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-1',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'urn:icd:A', title: 'Diagnóstico A' }],
  clinicalContext: 'contexto de origem',
  generalObjective: 'objetivo de origem',
  specificObjectives: [{ id: 'so1', label: 'Objetivo 1' }],
  activities: [{ id: 'ac1', label: 'Atividade 1' }],
  pathologyTypes: [{ id: 'pt1', label: 'Neurológica' }],
  startDate: '2026-01-10',
  endDate: '2026-06-10',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-01-10T10:00:00Z',
  country: 'AR',
};

const CRIADA: TherapeuticProjectVersion = { ...VERSAO, id: 'v2', major: 1, minor: 1, version: 'V.1.1', createdByName: 'Gabriel QA' };

const onClose = vi.fn();
const onSaved = vi.fn();
const criarObjectURL = vi.fn(() => 'blob:fake-url');
const revogarObjectURL = vi.fn();
let cliqueNoAncora: MockInstance<[], void>;

const montar = (target: TherapeuticProjectTarget, over: { patient?: PatientDetail } = {}) =>
  render(<TherapeuticProjectDrawer patient={over.patient ?? PACIENTE} target={target} onClose={onClose} onSaved={onSaved} />);

/** Contrato ABAC pronto, com o engine LIGADO (D268/D286) e só as células listadas. */
function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement'] = 'on'): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

function catalogosOk(): void {
  mockListCatalog.mockImplementation(async (kind: string) => [item(`${kind}-1`, `Rótulo ${kind}`)]);
}

/** Espera o formulário (os 3 catálogos resolvidos) aparecer. */
const esperarFormulario = () => screen.findByTestId('therapeutic-project-form');

function alternarNoMulti(id: string, label: string): void {
  const raiz = document.getElementById(id)!;
  const gatilho = raiz.querySelector('button')!;
  if (gatilho.getAttribute('aria-expanded') !== 'true') fireEvent.click(gatilho);
  const lista = raiz.querySelector('ul[role="listbox"]') as HTMLElement;
  fireEvent.click(within(lista).getByText(label).closest('button')!);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  Object.defineProperty(URL, 'createObjectURL', { value: criarObjectURL, writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revogarObjectURL, writable: true, configurable: true });
  cliqueNoAncora = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cliqueNoAncora.mockRestore();
  vi.useRealTimers();
});

// ── Modo view ────────────────────────────────────────────────────────────────

describe('modo `view` — uma versão em leitura', () => {
  it('subtítulo `V.x.y - Criado por: <nome>` e a versão renderizada em leitura', () => {
    montar({ mode: 'view', version: VERSAO });

    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('view');
    expect(screen.getByTestId('therapeutic-project-subtitle')).toHaveTextContent('V.1.0 - Criado por: Ana Fixture');
    expect(screen.getByTestId('therapeutic-project-version-view')).toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-project-form')).not.toBeInTheDocument();
    expect(mockListCatalog).not.toHaveBeenCalled(); // em leitura não se busca catálogo
  });

  it('versão sem autor conhecido cai em `—`', () => {
    montar({ mode: 'view', version: { ...VERSAO, createdByName: null } });

    expect(screen.getByTestId('therapeutic-project-subtitle')).toHaveTextContent('V.1.0 - Criado por: —');
  });

  it('"Editar" troca o drawer para `edit` e carrega os catálogos (a versão de origem enche o form)', async () => {
    catalogosOk();
    montar({ mode: 'view', version: VERSAO });

    fireEvent.click(screen.getByTestId('therapeutic-project-edit-btn'));

    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('edit');
    await esperarFormulario();
    expect((screen.getByTestId('tp-startDate') as HTMLInputElement).value).toBe('2026-01-10');
  });
});

// ── Exportar (lex C13) ───────────────────────────────────────────────────────

describe('🔒 lex C13 — "Exportar PDF" busca a versão A CADA clique', () => {
  it('chama `getVersion` com `purpose: export`, gera o Blob e dispara o download', async () => {
    mockGetVersion.mockResolvedValue(VERSAO);
    mockRenderBlob.mockResolvedValue(new Blob(['%PDF-fake']));
    montar({ mode: 'view', version: VERSAO });

    await act(async () => { fireEvent.click(screen.getByTestId('therapeutic-project-export-btn')); });

    expect(mockGetVersion).toHaveBeenCalledWith(PACIENTE.id, 'v1', { purpose: 'export' });
    expect(mockRenderBlob).toHaveBeenCalledTimes(1);
    expect(criarObjectURL).toHaveBeenCalledTimes(1);
    expect(cliqueNoAncora).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('therapeutic-project-export-error')).not.toBeInTheDocument();
  });

  it('lex C12/C14: o insumo do PDF sai das células já lidas e o arquivo não leva nome de paciente', async () => {
    mockGetVersion.mockResolvedValue(VERSAO);
    mockRenderBlob.mockResolvedValue(new Blob(['%PDF-fake']));
    montar({ mode: 'view', version: VERSAO });

    await act(async () => { fireEvent.click(screen.getByTestId('therapeutic-project-export-btn')); });

    const input = mockRenderBlob.mock.calls[0][0];
    expect(input.caseRef).toBe(PACIENTE.id);
    expect(input.version).toBe(VERSAO); // a versão FRESCA, não a que a tela tinha
    expect(input.identification).not.toBeNull(); // engine OFF → todos os containers visíveis
    expect(input.logoSrc).toBeTruthy();
  });

  it('a URL do Blob é revogada 10 s depois (não fica pendurada na aba)', async () => {
    vi.useFakeTimers();
    mockGetVersion.mockResolvedValue(VERSAO);
    mockRenderBlob.mockResolvedValue(new Blob(['%PDF-fake']));
    montar({ mode: 'view', version: VERSAO });

    await act(async () => { fireEvent.click(screen.getByTestId('therapeutic-project-export-btn')); });
    expect(revogarObjectURL).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(10_000); });

    expect(revogarObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('recusa do servidor no export aparece no banner (e o drawer não quebra)', async () => {
    mockGetVersion.mockRejectedValue(new Error('403 sem célula de export'));
    montar({ mode: 'view', version: VERSAO });

    await act(async () => { fireEvent.click(screen.getByTestId('therapeutic-project-export-btn')); });

    expect(screen.getByTestId('therapeutic-project-export-error')).toHaveTextContent('403 sem célula de export');
    expect(cliqueNoAncora).not.toHaveBeenCalled();
  });

  it('falha que não é `Error` (a geração do PDF rejeitando cru) também vira frase no banner', async () => {
    mockGetVersion.mockResolvedValue(VERSAO);
    mockRenderBlob.mockRejectedValue('fonte não carregou');
    montar({ mode: 'view', version: VERSAO });

    await act(async () => { fireEvent.click(screen.getByTestId('therapeutic-project-export-btn')); });

    expect(screen.getByTestId('therapeutic-project-export-error')).toHaveTextContent('fonte não carregou');
  });

  it('🔒 lex C5: versão ANULADA não exporta e não oferece "Editar"', () => {
    montar({ mode: 'view', version: { ...VERSAO, annulledAt: '2026-07-01' } });

    expect((screen.getByTestId('therapeutic-project-export-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('therapeutic-project-edit-btn')).not.toBeInTheDocument();
  });
});

// ── Gate de escrita (D286/D269) ──────────────────────────────────────────────

describe('🔒 D286/D269 — "Editar" é célula `patient_therapeutic_project:write`', () => {
  it('engine LIGADO e sem a célula → o botão SOME (não fica cinza)', () => {
    comEnforcement([]);
    montar({ mode: 'view', version: VERSAO });

    expect(screen.queryByTestId('therapeutic-project-edit-btn')).not.toBeInTheDocument();
    // exportar continua: é leitura, e a trilha é do servidor
    expect(screen.getByTestId('therapeutic-project-export-btn')).toBeInTheDocument();
  });

  it('🔴 a célula do PAI (`patient:write`) não vale — a permissão é do CONTAINER', () => {
    comEnforcement(['patient:read', 'patient:write']);
    montar({ mode: 'view', version: VERSAO });

    expect(screen.queryByTestId('therapeutic-project-edit-btn')).not.toBeInTheDocument();
  });

  it('com a célula do container o botão existe', () => {
    comEnforcement(['patient_therapeutic_project:write']);
    montar({ mode: 'view', version: VERSAO });

    expect(screen.getByTestId('therapeutic-project-edit-btn')).toBeInTheDocument();
  });

  it('engine DESLIGADO: o botão existe mesmo sem célula nenhuma (freio de rollout)', () => {
    comEnforcement([], 'off');
    montar({ mode: 'view', version: VERSAO });

    expect(screen.getByTestId('therapeutic-project-edit-btn')).toBeInTheDocument();
  });
});

// ── Modo new e catálogos ─────────────────────────────────────────────────────

describe('modo `new` — os catálogos antes do formulário', () => {
  it('título e subtítulo de versão nova; enquanto os catálogos não chegam, o aviso de carregando', async () => {
    catalogosOk();
    montar({ mode: 'new' });

    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('new');
    expect(screen.getByTestId('therapeutic-project-subtitle')).toHaveTextContent(tf('newSubtitle'));
    expect(screen.getByRole('dialog', { name: tf('newTitle') })).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-project-catalogs-loading')).toHaveTextContent(tf('loadingCatalogs'));

    await esperarFormulario();
    expect(screen.queryByTestId('therapeutic-project-catalogs-loading')).not.toBeInTheDocument();
  });

  it('catálogo que falha: mensagem no lugar do formulário (não formulário com lista vazia)', async () => {
    mockListCatalog.mockRejectedValue(new Error('catálogo fora do ar'));
    montar({ mode: 'new' });

    expect(await screen.findByTestId('therapeutic-project-catalogs-error')).toHaveTextContent('catálogo fora do ar');
    expect(screen.queryByTestId('therapeutic-project-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('therapeutic-project-catalogs-loading')).not.toBeInTheDocument();
  });
});

// ── Salvar ───────────────────────────────────────────────────────────────────

describe('salvar — `new` cria a major seguinte, `edit` a minor da origem', () => {
  it('`new`: manda `mode: new` sem `fromVersionId`, avisa o pai e vira `view` da versão criada', async () => {
    catalogosOk();
    mockCreateVersion.mockResolvedValue(CRIADA);
    montar({ mode: 'new' });
    await esperarFormulario();

    fireEvent.change(screen.getByTestId('tp-modality'), { target: { value: 'IN_PERSON' } });
    fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: 'contexto novo' } });
    fireEvent.change(screen.getByTestId('tp-generalObjective'), { target: { value: 'objetivo novo' } });
    alternarNoMulti('tp-specificObjectives', 'Rótulo specific-objectives');
    alternarNoMulti('tp-activities', 'Rótulo activities');
    fireEvent.change(screen.getByTestId('tp-startDate'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-12-01' } });

    await act(async () => { fireEvent.click(screen.getByTestId('tp-save')); });

    expect(mockCreateVersion).toHaveBeenCalledWith(PACIENTE.id, {
      mode: 'new',
      version: {
        contractedServiceId: 'svc-1',
        modality: 'IN_PERSON',
        diagnoses: [{ uri: 'urn:icd:A', title: 'Diagnóstico A' }],
        clinicalContext: 'contexto novo',
        generalObjective: 'objetivo novo',
        specificObjectiveIds: ['specific-objectives-1'],
        activityIds: ['activities-1'],
        startDate: '2026-09-01',
        endDate: '2026-12-01',
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('view');
    expect(screen.getByTestId('therapeutic-project-subtitle')).toHaveTextContent('V.1.1 - Criado por: Gabriel QA');
  });

  it('`edit`: manda `mode: edit` com o `fromVersionId` da origem', async () => {
    catalogosOk();
    mockCreateVersion.mockResolvedValue(CRIADA);
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();

    await act(async () => { fireEvent.click(screen.getByTestId('tp-save')); });

    expect(mockCreateVersion).toHaveBeenCalledWith(PACIENTE.id, expect.objectContaining({ mode: 'edit', fromVersionId: 'v1' }));
    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('view');
  });

  it('recusa do servidor vira a frase da tela dentro do formulário (o drawer não fecha)', async () => {
    catalogosOk();
    mockCreateVersion.mockRejectedValue(new TherapeuticProjectApiError('forbidden', 403));
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();

    await act(async () => { fireEvent.click(screen.getByTestId('tp-save')); });

    expect(screen.getByTestId('tp-form-error')).toHaveTextContent(tfErr('forbidden'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('therapeutic-project-drawer').getAttribute('data-mode')).toBe('edit');
  });
});

// ── saveRefusalMessage ───────────────────────────────────────────────────────

describe('saveRefusalMessage — a recusa do servidor em frase de tela', () => {
  it('403 vira a frase de permissão (precisa também da célula clínica)', () => {
    expect(saveRefusalMessage(new TherapeuticProjectApiError('nope', 403), t)).toBe(tfErr('forbidden'));
  });

  it.each([
    ['catalog_items_unknown', 'catalogItemsUnknown'],
    ['service_not_of_patient', 'serviceNotOfPatient'],
    ['source_version_not_found', 'sourceNotFound'],
    ['ptp_diagnosis_unknown', 'diagnosisUnknown'],
    ['TERMINOLOGY_UNAVAILABLE', 'terminologyUnavailable'],
  ])('`%s` vira a frase própria', (code, chave) => {
    expect(saveRefusalMessage(new TherapeuticProjectApiError('nope', 422, { code }), t)).toBe(tfErr(chave));
  });

  it('erro da API com `code` desconhecido cai na mensagem crua do servidor', () => {
    expect(saveRefusalMessage(new TherapeuticProjectApiError('conflito de versão', 409, { code: 'algo_novo' }), t)).toBe('conflito de versão');
  });

  it('erro da API SEM `code` também cai na mensagem crua', () => {
    expect(saveRefusalMessage(new TherapeuticProjectApiError('HTTP 500', 500), t)).toBe('HTTP 500');
  });

  it('`Error` comum (rede) devolve a própria mensagem; o que não é Error vira `String`', () => {
    expect(saveRefusalMessage(new Error('Failed to fetch'), t)).toBe('Failed to fetch');
    expect(saveRefusalMessage({ toString: () => 'coisa estranha' }, t)).toBe('coisa estranha');
  });
});

// ── Fechamento ───────────────────────────────────────────────────────────────

describe('fechamento — Escape e backdrop, com confirmação quando há mudança', () => {
  const avancarFechamento = () => act(() => { vi.advanceTimersByTime(300); });

  it('sem mudança: Escape fecha depois da animação (300 ms)', () => {
    montar({ mode: 'view', version: VERSAO });
    vi.useFakeTimers();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    avancarFechamento();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.confirm).toBeDefined();
  });

  it('tecla que não é Escape não fecha nada', () => {
    montar({ mode: 'view', version: VERSAO });
    vi.useFakeTimers();

    fireEvent.keyDown(document, { key: 'Enter' });
    avancarFechamento();

    expect(onClose).not.toHaveBeenCalled();
  });

  it('o "x" do cabeçalho fecha', () => {
    montar({ mode: 'view', version: VERSAO });
    vi.useFakeTimers();

    fireEvent.click(screen.getByTestId('therapeutic-project-close'));
    avancarFechamento();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('🔴 com mudança não salva: Escape pergunta e, se o operador CANCELA, o drawer fica', async () => {
    catalogosOk();
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();
    fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: 'mexi aqui' } });

    vi.useFakeTimers();
    fireEvent.keyDown(document, { key: 'Escape' });
    avancarFechamento();

    expect(confirmar).toHaveBeenCalledWith(tf('discardConfirm'));
    expect(onClose).not.toHaveBeenCalled();
    confirmar.mockRestore();
  });

  it('com mudança não salva: o backdrop pergunta e, confirmando, fecha', async () => {
    catalogosOk();
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(true);
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();
    fireEvent.change(screen.getByTestId('tp-generalObjective'), { target: { value: 'mexi aqui também' } });

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('therapeutic-project-backdrop'));
    avancarFechamento();

    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmar.mockRestore();
  });

  it('"Cancelar" do formulário passa pela MESMA confirmação', async () => {
    catalogosOk();
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();
    fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: 'x' } });

    fireEvent.click(screen.getByText(ptBR.common.cancel));

    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    confirmar.mockRestore();
  });

  it('depois de SALVAR o formulário deixa de estar sujo — fechar não pergunta mais', async () => {
    catalogosOk();
    mockCreateVersion.mockResolvedValue(CRIADA);
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    montar({ mode: 'edit', version: VERSAO });
    await esperarFormulario();
    fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: 'mexi e salvei' } });
    await act(async () => { fireEvent.click(screen.getByTestId('tp-save')); });

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('therapeutic-project-close'));
    avancarFechamento();

    expect(confirmar).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmar.mockRestore();
  });
});

// ── Animação de entrada ──────────────────────────────────────────────────────

describe('animação de entrada', () => {
  it('o painel entra da direita no quadro seguinte (`requestAnimationFrame`)', async () => {
    montar({ mode: 'view', version: VERSAO });

    expect(screen.getByTestId('therapeutic-project-drawer').className).toContain('translate-x-full');
    await waitFor(() => expect(screen.getByTestId('therapeutic-project-drawer').className).toContain('translate-x-0'));
  });
});
