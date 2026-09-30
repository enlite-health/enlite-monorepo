/**
 * AiPromptsPage.test.tsx — spec 029, T024.
 *
 * i18n REAL (mesmo padrão de `AiPromptEditor.test.tsx`): os JSONs `es`/`pt-BR` de verdade — o caso
 * somente-leitura afirma o TEXTO do aviso, não só a chave.
 *
 * `AdminApiService` mockado por inteiro: `listAiPrompts` (o que esta página chama) e
 * `getAiPrompt`/`updateAiPrompt`/`undoAiPrompt` (o `AiPromptEditor`, T023, é renderizado DE
 * VERDADE nos casos de escrita — não é um dublê aqui — e chama esses três direto).
 *
 * ⚠️ Achado central desta task (ver cabeçalho de `AiPromptsPage.tsx`): `useCellAccess` (o hook que
 * a tarefa manda usar) NÃO olha `authz.enforcement` — ao contrário de `useActionGate` (usado
 * dentro do editor) e de `useContainerAccess` (usado por toda página irmã: `DedupCenterPage`,
 * `BlockedAttemptsPage`, `TherapeuticCatalogPage`). Os testes "engine off" e "cells nulos" abaixo
 * PROVAM essa divergência medida, não a presumem.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AiPromptsPage } from '../AiPromptsPage';
import { AdminApiService, type AiPrompt } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('@infrastructure/http/AdminApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminApiService')>();
  return {
    ...actual,
    AdminApiService: {
      listAiPrompts: vi.fn(),
      getAiPrompt: vi.fn(),
      updateAiPrompt: vi.fn(),
      undoAiPrompt: vi.fn(),
      listVacancies: vi.fn(),
      simulateVacancyCreation: vi.fn(),
    },
  };
});

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'pt-BR',
    fallbackLng: false,
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

/** Molde de `AiPromptEditor.test.tsx`: contrato ABAC pronto. `enforcement` default `'on'`. */
function comContrato(
  permissions: readonly string[] | null,
  enforcement: AuthzContract['enforcement'] = 'on',
): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as unknown as AuthzContract,
  });
}

function fakePrompts(overrides: Partial<Record<AiPrompt['slug'], Partial<AiPrompt>>> = {}): AiPrompt[] {
  const base: Record<AiPrompt['slug'], AiPrompt> = {
    VACANCY_DESCRIPTION: {
      slug: 'VACANCY_DESCRIPTION', body: 'Texto da descrição de vaga.', version: 3,
      updatedBy: 'uid-ana', updatedAt: '2026-09-20T10:00:00.000Z', isActive: true,
    },
    PRESCREENING_AT: {
      slug: 'PRESCREENING_AT', body: 'Texto da pré-seleção de AT.', version: 1,
      updatedBy: null, updatedAt: '2026-09-18T09:00:00.000Z', isActive: true,
    },
    PRESCREENING_CAREGIVER: {
      slug: 'PRESCREENING_CAREGIVER', body: 'Texto da pré-seleção de cuidador.', version: 2,
      updatedBy: 'uid-bea', updatedAt: '2026-09-19T09:00:00.000Z', isActive: true,
    },
  };
  return (Object.keys(base) as AiPrompt['slug'][]).map((slug) => ({ ...base[slug], ...overrides[slug] }));
}

const listAiPrompts = () => vi.mocked(AdminApiService.listAiPrompts);

beforeEach(() => {
  listAiPrompts().mockReset();
  vi.mocked(AdminApiService.getAiPrompt).mockReset();
  vi.mocked(AdminApiService.updateAiPrompt).mockReset();
  vi.mocked(AdminApiService.undoAiPrompt).mockReset();
  vi.mocked(AdminApiService.simulateVacancyCreation).mockReset();
  vi.mocked(AdminApiService.listVacancies).mockReset().mockResolvedValue({
    data: [{ id: '11111111-1111-4111-8111-111111111111', caso: 'Caso 101', isDraft: false }],
    total: 1,
  });
});

describe('AiPromptsPage — acesso de ESCRITA (ai_prompt:update)', () => {
  beforeEach(() => {
    comContrato(['ai_prompt:read', 'ai_prompt:update']);
    listAiPrompts().mockResolvedValue(fakePrompts());
  });

  it('mostra as três abas e o editor completo da aba ativa (primeira, VACANCY_DESCRIPTION)', async () => {
    render(<AiPromptsPage />);
    // O editor abre em modo leitura; o textarea só existe depois do "Editar".
    expect(await screen.findByTestId('ai-prompt-editor-reader')).toHaveTextContent('Texto da descrição de vaga.');
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(await screen.findByTestId('ai-prompt-editor-textarea')).toHaveValue('Texto da descrição de vaga.');
    expect(screen.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION')).toBeInTheDocument();
    expect(screen.getByTestId('ai-prompt-tab-PRESCREENING_AT')).toBeInTheDocument();
    expect(screen.getByTestId('ai-prompt-tab-PRESCREENING_CAREGIVER')).toBeInTheDocument();
    // Botão Salvar do editor de verdade, habilitado — sem o aviso de somente-leitura.
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled();
    expect(screen.queryByTestId('ai-prompts-read-only-notice')).not.toBeInTheDocument();
  });

  it('trocar de aba troca o prompt mostrado no editor (cada aba abre em modo leitura)', async () => {
    render(<AiPromptsPage />);
    expect(await screen.findByTestId('ai-prompt-editor-reader')).toHaveTextContent('Texto da descrição de vaga.');

    fireEvent.click(screen.getByTestId('ai-prompt-tab-PRESCREENING_AT'));
    await waitFor(() => {
      expect(screen.getByTestId('ai-prompt-editor-reader')).toHaveTextContent('Texto da pré-seleção de AT.');
    });
    expect(screen.queryByTestId('ai-prompt-editor-textarea')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-prompt-tab-PRESCREENING_CAREGIVER'));
    await waitFor(() => {
      expect(screen.getByTestId('ai-prompt-editor-reader')).toHaveTextContent('Texto da pré-seleção de cuidador.');
    });
    expect(screen.queryByTestId('ai-prompt-editor-textarea')).not.toBeInTheDocument();
  });
});

describe('AiPromptsPage — simulador de vacante FORA das abas (T073)', () => {
  const CASE_ID = '11111111-1111-4111-8111-111111111111';
  const simulacao = {
    description: 'desc', prescreening: { questions: [], faq: [] }, workerType: 'AT' as const,
    usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_AT'] as AiPrompt['slug'][],
  };
  const simular = async () => {
    fireEvent.change(await screen.findByTestId('vacancy-simulation-case'), { target: { value: CASE_ID } });
    fireEvent.click(screen.getByTestId('vacancy-simulation-run'));
    await screen.findByTestId('vacancy-simulation-result');
  };

  beforeEach(() => {
    comContrato(['ai_prompt:read', 'ai_prompt:update']);
    listAiPrompts().mockResolvedValue(fakePrompts());
    vi.mocked(AdminApiService.simulateVacancyCreation).mockResolvedValue(simulacao);
  });

  it('existe em qualquer aba e fica fora do painel de abas', async () => {
    render(<AiPromptsPage />);
    const secao = await screen.findByTestId('vacancy-simulation-section');
    expect(screen.getByRole('tablist')).not.toContainElement(secao);
    fireEvent.click(screen.getByTestId('ai-prompt-tab-PRESCREENING_CAREGIVER'));
    expect(await screen.findByTestId('vacancy-simulation-section')).toBeInTheDocument();
  });

  it('sem edição, nada é enviado em `bodies` (o backend usa o salvo)', async () => {
    render(<AiPromptsPage />);
    await simular();
    expect(AdminApiService.simulateVacancyCreation).toHaveBeenCalledWith(CASE_ID, {});
  });

  it('o texto em edição (rascunho NÃO salvo) sobe do editor e chega ao simulador', async () => {
    render(<AiPromptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    fireEvent.change(await screen.findByTestId('ai-prompt-editor-textarea'), { target: { value: 'rascunho novo da descrição' } });
    await simular();
    expect(AdminApiService.simulateVacancyCreation).toHaveBeenCalledWith(CASE_ID, {
      VACANCY_DESCRIPTION: 'rascunho novo da descrição',
    });
    expect(AdminApiService.updateAiPrompt).not.toHaveBeenCalled();
  });

  const editarEDigitar = async (texto: string) => {
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    fireEvent.change(await screen.findByTestId('ai-prompt-editor-textarea'), { target: { value: texto } });
  };
  const irPara = async (tab: string, textoSalvo: string) => {
    fireEvent.click(screen.getByTestId(`ai-prompt-tab-${tab}`));
    await waitFor(() => {
      expect(screen.getByTestId('ai-prompt-editor-reader')).toHaveTextContent(textoSalvo);
    });
  };

  it('VAI E VOLTA: editar A sem salvar, ir para B e voltar para A mostra o RASCUNHO, não o salvo', async () => {
    render(<AiPromptsPage />);
    await editarEDigitar('rascunho da descrição');
    await irPara('PRESCREENING_AT', 'Texto da pré-seleção de AT.');
    fireEvent.click(screen.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION'));
    expect(await screen.findByTestId('ai-prompt-editor-textarea')).toHaveValue('rascunho da descrição');
    expect(screen.queryByTestId('ai-prompt-editor-reader')).not.toBeInTheDocument();
    expect(AdminApiService.updateAiPrompt).not.toHaveBeenCalled();
  });

  it('a aba com rascunho não salvo é marcada SEM entrar nela; a sem rascunho não é', async () => {
    render(<AiPromptsPage />);
    expect(screen.queryByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).not.toBeInTheDocument();
    await editarEDigitar('rascunho da descrição');
    expect(screen.getByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).toHaveAttribute('title', 'Alterações não salvas');
    await irPara('PRESCREENING_AT', 'Texto da pré-seleção de AT.');
    expect(screen.getByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-prompt-tab-unsaved-PRESCREENING_AT')).not.toBeInTheDocument();
  });

  it('DOIS RASCUNHOS AO MESMO TEMPO: o `bodies` enviado ao AdminApiService contém os dois', async () => {
    render(<AiPromptsPage />);
    await editarEDigitar('rascunho da descrição');
    await irPara('PRESCREENING_AT', 'Texto da pré-seleção de AT.');
    await editarEDigitar('rascunho do AT');
    await simular();
    expect(AdminApiService.simulateVacancyCreation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(AdminApiService.simulateVacancyCreation).mock.calls[0]).toEqual([
      CASE_ID,
      { VACANCY_DESCRIPTION: 'rascunho da descrição', PRESCREENING_AT: 'rascunho do AT' },
    ]);
  });

  it('GUARDAR LIMPA: salvar A, trocar e voltar mostra o salvo, sem rascunho nem marca pendurados', async () => {
    vi.mocked(AdminApiService.updateAiPrompt).mockResolvedValue(
      fakePrompts({ VACANCY_DESCRIPTION: { body: 'texto guardado', version: 4 } })[0],
    );
    render(<AiPromptsPage />);
    await editarEDigitar('texto guardado');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByTestId('ai-prompt-editor-reader')).toHaveTextContent('texto guardado'));
    expect(screen.queryByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).not.toBeInTheDocument();
    await irPara('PRESCREENING_AT', 'Texto da pré-seleção de AT.');
    fireEvent.click(screen.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION'));
    expect(await screen.findByTestId('ai-prompt-editor-reader')).toHaveTextContent('texto guardado');
    expect(screen.queryByTestId('ai-prompt-editor-textarea')).not.toBeInTheDocument();
    await simular();
    expect(AdminApiService.simulateVacancyCreation).toHaveBeenCalledWith(CASE_ID, {});
  });

  it('DESFAZER não ressuscita o rascunho: após desfazer, voltar à aba mostra o texto restaurado', async () => {
    listAiPrompts().mockResolvedValue(fakePrompts()); // VACANCY_DESCRIPTION está na versão 3 (desfazível)
    vi.mocked(AdminApiService.undoAiPrompt).mockResolvedValue(
      fakePrompts({ VACANCY_DESCRIPTION: { body: 'texto restaurado', version: 4 } })[0],
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AiPromptsPage />);
    await editarEDigitar('rascunho que não deve voltar');
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));
    await waitFor(() => expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('texto restaurado'));
    expect(screen.queryByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-prompt-tab-PRESCREENING_AT'));
    await screen.findByTestId('ai-prompt-editor-reader');
    fireEvent.click(screen.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION'));
    expect(await screen.findByTestId('ai-prompt-editor-reader')).toHaveTextContent('texto restaurado');
    expect(screen.queryByText('rascunho que não deve voltar')).not.toBeInTheDocument();
  });

  it('409 ao salvar: o rascunho é PRESERVADO (nem a marca nem o texto somem) e volta ao reabrir a aba', async () => {
    const { ApiError } = await import('@infrastructure/http/AdminApiService');
    vi.mocked(AdminApiService.updateAiPrompt).mockRejectedValue(new ApiError({ success: false, error: 'conflict' } as never, 409));
    vi.mocked(AdminApiService.getAiPrompt).mockResolvedValue(
      fakePrompts({ VACANCY_DESCRIPTION: { body: 'texto do outro', version: 4, updatedBy: 'uid-outro' } })[0],
    );
    render(<AiPromptsPage />);
    await editarEDigitar('meu rascunho em conflito');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByTestId('ai-prompt-editor-save-error')).toHaveTextContent('uid-outro');
    expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('meu rascunho em conflito');
    expect(screen.getByTestId('ai-prompt-tab-unsaved-VACANCY_DESCRIPTION')).toBeInTheDocument();
    await irPara('PRESCREENING_AT', 'Texto da pré-seleção de AT.');
    fireEvent.click(screen.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION'));
    expect(await screen.findByTestId('ai-prompt-editor-textarea')).toHaveValue('meu rascunho em conflito');
  });

  it('rascunho em branco não é enviado (corpo vazio é 400 no backend)', async () => {
    render(<AiPromptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    fireEvent.change(await screen.findByTestId('ai-prompt-editor-textarea'), { target: { value: '   ' } });
    await simular();
    expect(AdminApiService.simulateVacancyCreation).toHaveBeenCalledWith(CASE_ID, {});
  });

  it('somente leitura: o simulador não aparece', async () => {
    comContrato(['ai_prompt:read']);
    render(<AiPromptsPage />);
    await screen.findByTestId('ai-prompt-readonly-textarea');
    expect(screen.queryByTestId('vacancy-simulation-section')).not.toBeInTheDocument();
  });
});

describe('AiPromptsPage — caso somente-leitura (ai_prompt:read, SEM ai_prompt:update)', () => {
  beforeEach(() => {
    comContrato(['ai_prompt:read']);
    listAiPrompts().mockResolvedValue(fakePrompts());
  });

  it('conteúdo aparece E salvar está desabilitado — as duas metades', async () => {
    render(<AiPromptsPage />);

    // Metade 1: o conteúdo aparece (o texto do prompt está na tela, legível).
    const readonly = await screen.findByTestId('ai-prompt-readonly-textarea');
    expect(readonly).toHaveValue('Texto da descrição de vaga.');

    // Metade 2: salvar está desabilitado — aqui, ausente por completo (não existe `AiPromptEditor`
    // nesta árvore: ele não tem prop pra desabilitar o próprio botão de fora, então a página troca
    // de componente em vez de tentar apagar um botão que ficaria clicável por dentro).
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-prompt-editor')).not.toBeInTheDocument();
  });

  it('mostra o aviso de somente-leitura, com o texto real (i18n)', async () => {
    render(<AiPromptsPage />);
    const notice = await screen.findByTestId('ai-prompts-read-only-notice');
    expect(notice).toHaveTextContent('Somente leitura: você pode ver o conteúdo, mas não salvá-lo.');
  });

  it('o textarea somente-leitura é readOnly de verdade (não aceita edição)', async () => {
    render(<AiPromptsPage />);
    const readonly = await screen.findByTestId('ai-prompt-readonly-textarea');
    expect(readonly).toHaveAttribute('readonly');
  });
});

describe('AiPromptsPage — carregamento e erro', () => {
  beforeEach(() => comContrato(['ai_prompt:read', 'ai_prompt:update']));

  it('mostra o estado de carregamento antes da lista chegar', () => {
    listAiPrompts().mockReturnValue(new Promise(() => {})); // nunca resolve neste teste
    render(<AiPromptsPage />);
    expect(screen.getByTestId('ai-prompts-loading')).toBeInTheDocument();
  });

  it('falha ao carregar: mostra o erro, sem quebrar a tela', async () => {
    listAiPrompts().mockRejectedValue(new Error('rede caiu'));
    render(<AiPromptsPage />);
    expect(await screen.findByTestId('ai-prompts-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-prompt-editor-textarea')).not.toBeInTheDocument();
  });
});

describe('AiPromptsPage — ABAC: cells === null (motor não decidiu) × cells === [] (decidiu: nada)', () => {
  // D113 (backend, `AiPromptController.canReadAiPrompt`/`canWriteAiPrompt`): `null` LIBERA (o
  // motor ainda não decidiu para esta família/rota) e `[]` BARRA (decidiu que não há célula
  // nenhuma) são coisas DIFERENTES — confundi-las já causou incidente neste repo.
  //
  // useCellAccess/accessLevelFor, do lado do FRONTEND, não fazem essa distinção: os dois casos
  // abaixo têm ENTRADAS diferentes e o mesmo resultado medido (`hidden`) — isso é o achado, não
  // uma suposição. Ver LISTA no relatório desta task.

  it('cells === null: useCellAccess NÃO libera — página fica hidden (diverge do invariante do backend)', async () => {
    comContrato(null); // authz.permissions === null, contrato "pronto" (status ready)
    listAiPrompts().mockResolvedValue(fakePrompts());
    const { container } = render(<AiPromptsPage />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(listAiPrompts()).not.toHaveBeenCalled();
  });

  it('cells === [] (decidido, nenhuma célula ai_prompt:*): barra — página fica hidden', async () => {
    comContrato([]);
    listAiPrompts().mockResolvedValue(fakePrompts());
    const { container } = render(<AiPromptsPage />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(listAiPrompts()).not.toHaveBeenCalled();
  });
});

describe('AiPromptsPage — engine de ABAC OFF (ausente), sem nenhuma célula ai_prompt:* distribuída', () => {
  // O ESTADO ATUAL do rollout (D268): `enforcement` ainda `off`/ausente pra maioria dos recursos,
  // e ninguém tem `ai_prompt:*` porque a distribuição de células novas é ação da operação, não
  // deste código. `useContainerAccess` (usado por TODA página irmã) trataria isto como
  // fail-OPEN — mas a tarefa manda usar `useCellAccess` puro, que NÃO tem esse freio.
  it('sem contrato/permissões e engine off: a página fica hidden — NÃO é fail-open como o resto do painel', async () => {
    comContrato([], 'off');
    listAiPrompts().mockResolvedValue(fakePrompts());
    const { container } = render(<AiPromptsPage />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
