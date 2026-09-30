/**
 * AiPromptEditor.test.tsx — spec 029, T023/T023a.
 *
 * i18n REAL (mesmo padrão de `AnaCareHoursStaleBanner.i18n.test.tsx`/`sex-both-i18n.test.tsx`):
 * os JSONs `es`/`pt-BR` de verdade, não o mock que devolve a própria chave — T023a exige afirmar o
 * TEXTO exibido (motivo do desfazer indisponível, quem alterou no conflito), e um mock de `t`
 * provaria só qual chave foi escolhida, nunca que o texto e a interpolação (`{{updatedBy}}`,
 * `{{count}}`) batem com o que a tela realmente mostra.
 *
 * `ApiError` é a classe REAL (`importOriginal`) — o componente faz `instanceof ApiError` no catch;
 * um dublê ad-hoc quebraria essa checagem (mesmo motivo de `ServicosContratadosCard.test.tsx` com
 * `ContractedServiceApiError`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AiPromptEditor } from '../AiPromptEditor';
import { AdminApiService, ApiError, type AiPrompt } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('@infrastructure/http/AdminApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminApiService')>();
  return {
    ...actual,
    AdminApiService: {
      getAiPrompt: vi.fn(),
      updateAiPrompt: vi.fn(),
      undoAiPrompt: vi.fn(),
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

/** Molde de `AxonicoSendControl.test.tsx`/`VacancyTalentumCard.test.tsx`: contrato ABAC pronto, engine LIGADO. */
function comEnforcement(permissions: string[]): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}

function fakePrompt(overrides: Partial<AiPrompt> = {}): AiPrompt {
  return {
    slug: 'VACANCY_DESCRIPTION',
    body: 'Texto original do prompt.',
    version: 3,
    updatedBy: 'uid-ana',
    updatedAt: '2026-09-20T10:00:00.000Z',
    isActive: true,
    ...overrides,
  };
}

/** Um `promise` que o teste controla de fora — pra observar o estado "salvando"/"desfazendo" em voo. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getAiPrompt = () => vi.mocked(AdminApiService.getAiPrompt);
const updateAiPrompt = () => vi.mocked(AdminApiService.updateAiPrompt);
const undoAiPrompt = () => vi.mocked(AdminApiService.undoAiPrompt);

describe('AiPromptEditor', () => {
  beforeEach(() => {
    getAiPrompt().mockReset();
    updateAiPrompt().mockReset();
    undoAiPrompt().mockReset();
    comEnforcement(['ai_prompt:read', 'ai_prompt:update']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // ─── Render básico ────────────────────────────────────────────────────────

  it('mostra o texto do prompt, o contador e a autoria da versão atual', () => {
    render(<AiPromptEditor prompt={fakePrompt({ body: 'abc', updatedBy: 'Ana Julieta' })} />);
    expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('abc');
    expect(screen.getByTestId('ai-prompt-editor-counter').textContent).toBe('3 caracteres');
    expect(screen.getByTestId('ai-prompt-editor-author').textContent).toContain('Ana Julieta');
  });

  it('sem updatedAt: não mostra a linha de autoria (prompt nunca editado)', () => {
    render(<AiPromptEditor prompt={fakePrompt({ updatedAt: null as unknown as string })} />);
    expect(screen.queryByTestId('ai-prompt-editor-author')).not.toBeInTheDocument();
  });

  it('updatedAt presente mas updatedBy null: autoria cai no "—"', () => {
    render(<AiPromptEditor prompt={fakePrompt({ updatedBy: null })} />);
    expect(screen.getByTestId('ai-prompt-editor-author')).toHaveTextContent('—');
  });

  it('updatedAt corrompido (não parseável): mostra o valor cru, sem quebrar', () => {
    render(<AiPromptEditor prompt={fakePrompt({ updatedAt: 'nao-e-uma-data' })} />);
    expect(screen.getByTestId('ai-prompt-editor-author')).toHaveTextContent('nao-e-uma-data');
  });

  // ─── Salvar ───────────────────────────────────────────────────────────────

  it('salvar: sucesso grava o texto novo e avisa o pai via onSaved', async () => {
    const onSaved = vi.fn();
    const prompt = fakePrompt({ version: 3, body: 'Texto original do prompt.' });
    const saved = deferred<AiPrompt>();
    updateAiPrompt().mockReturnValue(saved.promise);

    render(<AiPromptEditor prompt={prompt} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('ai-prompt-editor-textarea'), { target: { value: 'Texto novo do prompt.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    // Em voo: botão mostra "Salvando…" e fica desabilitado (branch `saving=true`).
    expect(await screen.findByRole('button', { name: 'Salvando…' })).toBeDisabled();

    saved.resolve(fakePrompt({ version: 4, body: 'Texto novo do prompt.', updatedBy: 'uid-quem-salvou' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled());

    expect(updateAiPrompt()).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto novo do prompt.', 3);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
    expect(screen.getByTestId('ai-prompt-editor-author').textContent).toContain('uid-quem-salvou');
  });

  it('salvar: texto vazio mostra o erro e NÃO chama a API', async () => {
    render(<AiPromptEditor prompt={fakePrompt()} />);
    fireEvent.change(screen.getByTestId('ai-prompt-editor-textarea'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByTestId('ai-prompt-editor-save-error')).toHaveTextContent('O texto não pode ficar vazio.');
    expect(updateAiPrompt()).not.toHaveBeenCalled();
  });

  it('salvar: conflito de versão (409) mostra quem alterou e preserva o rascunho do usuário', async () => {
    const prompt = fakePrompt({ version: 3, body: 'Texto original do prompt.' });
    updateAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'version_conflict' }, 409));
    getAiPrompt().mockResolvedValue(fakePrompt({ version: 5, updatedBy: 'Fulana', body: 'Texto original do prompt.' }));

    render(<AiPromptEditor prompt={prompt} />);
    fireEvent.change(screen.getByTestId('ai-prompt-editor-textarea'), { target: { value: 'Meu rascunho não salvo.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const error = await screen.findByTestId('ai-prompt-editor-save-error');
    expect(error.textContent).toBe('Outra pessoa (Fulana) já salvou uma mudança neste prompt. Recarregue para ver a versão atual antes de salvar de novo.');
    // Rascunho do usuário PRESERVADO — não foi sobrescrito pelo conteúdo fresco do servidor.
    expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('Meu rascunho não salvo.');
  });

  it('salvar: conflito de versão onde o próprio reconferir falha cai no "—"', async () => {
    updateAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'version_conflict' }, 409));
    getAiPrompt().mockRejectedValue(new Error('rede caiu'));

    render(<AiPromptEditor prompt={fakePrompt()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const error = await screen.findByTestId('ai-prompt-editor-save-error');
    expect(error.textContent).toContain('Outra pessoa (—)');
  });

  it('salvar: conflito de versão onde o reconferir funciona mas o autor fresco é null cai no "—"', async () => {
    updateAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'version_conflict' }, 409));
    getAiPrompt().mockResolvedValue(fakePrompt({ version: 9, updatedBy: null }));

    render(<AiPromptEditor prompt={fakePrompt()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const error = await screen.findByTestId('ai-prompt-editor-save-error');
    expect(error.textContent).toContain('Outra pessoa (—)');
  });

  it('salvar: erro genérico (Error) mostra a mensagem do erro', async () => {
    updateAiPrompt().mockRejectedValue(new Error('o servidor caiu'));
    render(<AiPromptEditor prompt={fakePrompt()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByTestId('ai-prompt-editor-save-error')).toHaveTextContent('o servidor caiu');
  });

  it('salvar: erro que não é instância de Error cai na mensagem padrão', async () => {
    updateAiPrompt().mockRejectedValue('falha crua, sem Error');
    render(<AiPromptEditor prompt={fakePrompt()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByTestId('ai-prompt-editor-save-error')).toHaveTextContent('O texto não pode ficar vazio.');
  });

  // ─── Desfazer (T023a) ────────────────────────────────────────────────────

  it('desfazer: aciona e o texto volta ao anterior', async () => {
    const onSaved = vi.fn();
    const prompt = fakePrompt({ version: 4, body: 'Texto atual.' });
    const undone = deferred<AiPrompt>();
    undoAiPrompt().mockReturnValue(undone.promise);

    render(<AiPromptEditor prompt={prompt} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));

    expect(window.confirm).toHaveBeenCalledWith('Desfazer a última alteração? O texto volta para a versão anterior.');
    // Em voo: botão de desfazer fica desabilitado (branch `undoing=true`).
    expect(screen.getByRole('button', { name: 'Desfazer última alteração' })).toBeDisabled();

    undone.resolve(fakePrompt({ version: 3, body: 'Texto anterior, de volta.' }));
    await waitFor(() => expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('Texto anterior, de volta.'));

    expect(undoAiPrompt()).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 4);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  });

  it('desfazer: cancelar a confirmação não chama a API', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AiPromptEditor prompt={fakePrompt({ version: 4 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));
    expect(undoAiPrompt()).not.toHaveBeenCalled();
  });

  it('desfazer: desabilitado com o motivo visível quando não há versão anterior', () => {
    render(<AiPromptEditor prompt={fakePrompt({ version: 1 })} />);
    expect(screen.getByRole('button', { name: 'Desfazer última alteração' })).toBeDisabled();
    expect(screen.getByTestId('ai-prompt-editor-undo-reason')).toHaveTextContent(
      'Não há uma versão anterior para desfazer.',
    );
  });

  it('desfazer: ausente para quem só tem leitura (ai_prompt:read, sem update)', () => {
    comEnforcement(['ai_prompt:read']);
    render(<AiPromptEditor prompt={fakePrompt({ version: 4 })} />);
    expect(screen.queryByRole('button', { name: 'Desfazer última alteração' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-prompt-editor-undo-reason')).not.toBeInTheDocument();
  });

  it('desfazer: conflito de versão (409) mostra quem alterou e atualiza o rascunho intocado', async () => {
    const prompt = fakePrompt({ version: 4, body: 'Texto atual.' });
    undoAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'version_conflict' }, 409));
    getAiPrompt().mockResolvedValue(fakePrompt({ version: 6, updatedBy: 'Beltrana', body: 'Texto mais novo no servidor.' }));

    render(<AiPromptEditor prompt={prompt} />);
    // Sem editar o textarea: body === current.body — o conflito reconfere e ATUALIZA o rascunho.
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));

    const error = await screen.findByTestId('ai-prompt-editor-undo-error');
    expect(error.textContent).toBe('Outra pessoa (Beltrana) já salvou uma mudança neste prompt. Recarregue para ver a versão atual antes de salvar de novo.');
    expect(screen.getByTestId('ai-prompt-editor-textarea')).toHaveValue('Texto mais novo no servidor.');
  });

  it('desfazer: servidor recusa com 422 (sem versão anterior) mesmo já permitido no cliente', async () => {
    undoAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'sem_versao_anterior' }, 422));
    render(<AiPromptEditor prompt={fakePrompt({ version: 4 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));
    expect(await screen.findByTestId('ai-prompt-editor-undo-error')).toHaveTextContent(
      'Não há uma versão anterior para desfazer.',
    );
  });

  it('desfazer: erro genérico (Error) mostra a mensagem do erro', async () => {
    undoAiPrompt().mockRejectedValue(new Error('undo explodiu'));
    render(<AiPromptEditor prompt={fakePrompt({ version: 4 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));
    expect(await screen.findByTestId('ai-prompt-editor-undo-error')).toHaveTextContent('undo explodiu');
  });

  it('desfazer: erro que não é instância de Error cai na mensagem padrão', async () => {
    undoAiPrompt().mockRejectedValue({ oops: true });
    render(<AiPromptEditor prompt={fakePrompt({ version: 4 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer última alteração' }));
    expect(await screen.findByTestId('ai-prompt-editor-undo-error')).toHaveTextContent(
      'Não há uma versão anterior para desfazer.',
    );
  });
});
