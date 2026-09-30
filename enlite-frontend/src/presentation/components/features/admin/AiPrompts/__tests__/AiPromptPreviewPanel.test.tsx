/**
 * AiPromptPreviewPanel.test.tsx — spec 029, T034.
 *
 * i18n REAL (texto exibido é o afirmado). `vi.mock` no MESMO caminho que o componente importa
 * (`@infrastructure/http/AdminApiService`); `ApiError` é a classe real (o componente faz
 * `instanceof`). A junta com o `request()` real está em
 * `infrastructure/http/__tests__/AdminApiService.aiPrompts.wire.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AiPromptPreviewPanel } from '../AiPromptPreviewPanel';
import { AdminApiService, ApiError } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminApiService')>();
  return {
    ...actual,
    AdminApiService: { listVacancies: vi.fn(), previewAiPrompt: vi.fn() },
  };
});

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const listVacancies = () => vi.mocked(AdminApiService.listVacancies);
const previewAiPrompt = () => vi.mocked(AdminApiService.previewAiPrompt);

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'pt-BR',
    fallbackLng: false,
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  listVacancies().mockResolvedValue({
    data: [
      { id: CASE_ID, caso: 'Caso 101', isDraft: false },
      { id: 'rascunho-id', caso: 'Caso 999', isDraft: true },
    ],
    total: 2,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function pickCaseAndRun(): Promise<void> {
  const select = await screen.findByTestId('ai-prompt-preview-case');
  fireEvent.change(select, { target: { value: CASE_ID } });
  fireEvent.click(screen.getByTestId('ai-prompt-preview-run'));
}

describe('AiPromptPreviewPanel', () => {
  it('lista os casos da listagem de vacantes, sem rascunhos', async () => {
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="texto" />);
    expect(await screen.findByRole('option', { name: 'Caso 101' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Caso 999' })).not.toBeInTheDocument();
  });

  it('só habilita simular com caso escolhido', async () => {
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="texto" />);
    const select = await screen.findByTestId('ai-prompt-preview-case');
    expect(screen.getByTestId('ai-prompt-preview-run')).toBeDisabled();
    fireEvent.change(select, { target: { value: CASE_ID } });
    expect(screen.getByTestId('ai-prompt-preview-run')).toBeEnabled();
  });

  it('envia o TEXTO EM EDIÇÃO e o caso escolhido, e mostra o generated cru', async () => {
    previewAiPrompt().mockResolvedValue({
      jobPostingId: CASE_ID,
      slug: 'PRESCREENING_AT',
      generated: '{"questions":[],"faq":[]}',
    });
    render(<AiPromptPreviewPanel slug="PRESCREENING_AT" body="rascunho ainda não salvo" />);
    await pickCaseAndRun();
    expect((await screen.findByTestId('ai-prompt-preview-generated')).textContent).toBe('{"questions":[],"faq":[]}');
    expect(previewAiPrompt()).toHaveBeenCalledWith('PRESCREENING_AT', 'rascunho ainda não salvo', CASE_ID);
  });

  it('o aviso de simulação CONTINUA no documento 30 s depois do resultado', async () => {
    previewAiPrompt().mockResolvedValue({ jobPostingId: CASE_ID, slug: 'VACANCY_DESCRIPTION', generated: 'descrição gerada' });
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="texto" />);
    await pickCaseAndRun();
    const notice = await screen.findByTestId('ai-prompt-preview-notice');
    expect(notice).toHaveTextContent(/SIMULAÇÃO/);

    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByTestId('ai-prompt-preview-notice')).toBeInTheDocument();
    expect(document.body).toContainElement(notice);
    expect(screen.getByTestId('ai-prompt-preview-generated')).toHaveTextContent('descrição gerada');
  });

  it('503: mostra mensagem de indisponível, sem resultado e sem aviso de simulação', async () => {
    previewAiPrompt().mockRejectedValue(new ApiError({ success: false, error: 'model_unavailable' } as never, 503));
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="meu texto em edição" />);
    await pickCaseAndRun();
    expect(await screen.findByTestId('ai-prompt-preview-error')).toHaveTextContent(/indisponível/);
    expect(screen.queryByTestId('ai-prompt-preview-result')).not.toBeInTheDocument();
  });

  it('erro genérico: mensagem genérica que cita a preservação do texto', async () => {
    previewAiPrompt().mockRejectedValue(new Error('rede'));
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="texto" />);
    await pickCaseAndRun();
    expect(await screen.findByTestId('ai-prompt-preview-error')).toHaveTextContent(/preservado/);
  });

  it('falha ao listar os casos: mostra erro e não oferece o seletor', async () => {
    listVacancies().mockRejectedValue(new Error('boom'));
    render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="texto" />);
    expect(await screen.findByTestId('ai-prompt-preview-cases-error')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-prompt-preview-case')).not.toBeInTheDocument();
  });

  it('trocar de slug descarta o resultado do prompt anterior', async () => {
    previewAiPrompt().mockResolvedValue({ jobPostingId: CASE_ID, slug: 'VACANCY_DESCRIPTION', generated: 'x' });
    const { rerender } = render(<AiPromptPreviewPanel slug="VACANCY_DESCRIPTION" body="t" />);
    await pickCaseAndRun();
    await screen.findByTestId('ai-prompt-preview-result');
    rerender(<AiPromptPreviewPanel slug="PRESCREENING_AT" body="t" />);
    expect(screen.queryByTestId('ai-prompt-preview-result')).not.toBeInTheDocument();
  });
});
