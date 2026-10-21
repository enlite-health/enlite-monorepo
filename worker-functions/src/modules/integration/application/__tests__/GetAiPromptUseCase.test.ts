/**
 * GetAiPromptUseCase.test.ts
 *
 * Cenários:
 *   1. Happy path — slug válido com linha → { found: true, prompt }
 *   2. Não encontrado — slug válido, repositório retorna null → { found: false }
 *   3. Identificador desconhecido — fora de AI_PROMPT_SLUGS → { found: false }, sem consultar o repo
 *   4. Erro do repositório — propaga sem mascarar
 *   5. Contrato de chamada — findBySlug é chamado exatamente 1 vez com o slug correto
 *   6. list() — repassa os registros do repositório, sem transformação
 */

import { GetAiPromptUseCase } from '../GetAiPromptUseCase';
import { AiPromptRepository } from '../../infrastructure/AiPromptRepository';
import type { AiPrompt } from '../../infrastructure/AiPromptRepository';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockPrompt: AiPrompt = {
  slug: 'VACANCY_DESCRIPTION',
  body: 'Você é um assistente que descreve vagas de cuidado domiciliar.',
  version: 7,
  isActive: true,
  createdBy: 'uid-seed',
  updatedBy: 'uid-abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
};

const mockPromptList: AiPrompt[] = [
  mockPrompt,
  {
    slug: 'PRESCREENING_AT',
    body: 'Prompt de pré-triagem para AT.',
    version: 1,
    isActive: true,
    createdBy: 'uid-seed',
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    slug: 'PRESCREENING_CAREGIVER',
    body: 'Prompt de pré-triagem para cuidador.',
    version: 1,
    isActive: true,
    createdBy: 'uid-seed',
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(overrides: { findBySlug?: jest.Mock; listAll?: jest.Mock } = {}) {
  return {
    findBySlug: jest.fn().mockResolvedValue(mockPrompt),
    listAll: jest.fn().mockResolvedValue(mockPromptList),
    updateBody: jest.fn(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GetAiPromptUseCase', () => {
  describe('Cenário 1 — Prompt encontrado', () => {
    it('deve retornar { found: true, prompt } quando o repositório retorna o registro', async () => {
      const repo = makeRepo();
      const useCase = new GetAiPromptUseCase(repo as any);

      const result = await useCase.execute('VACANCY_DESCRIPTION');

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.prompt).toEqual(mockPrompt);
      }
    });
  });

  describe('Cenário 2 — Slug válido sem linha na tabela', () => {
    it('deve retornar { found: false } quando o repositório retorna null', async () => {
      const repo = makeRepo({ findBySlug: jest.fn().mockResolvedValue(null) });
      const useCase = new GetAiPromptUseCase(repo as any);

      const result = await useCase.execute('PRESCREENING_AT');

      expect(result.found).toBe(false);
    });
  });

  describe('Cenário 3 — Identificador desconhecido', () => {
    it('deve retornar { found: false } para um slug fora de AI_PROMPT_SLUGS, sem consultar o repositório', async () => {
      const findBySlug = jest.fn().mockResolvedValue(mockPrompt);
      const repo = makeRepo({ findBySlug });
      const useCase = new GetAiPromptUseCase(repo as any);

      const result = await useCase.execute('SLUG_QUE_NAO_EXISTE');

      expect(result.found).toBe(false);
      expect(findBySlug).not.toHaveBeenCalled();
    });

    it('deve retornar { found: false } para string vazia', async () => {
      const repo = makeRepo();
      const useCase = new GetAiPromptUseCase(repo as any);

      const result = await useCase.execute('');

      expect(result.found).toBe(false);
    });
  });

  describe('Cenário 4 — Erro do repositório', () => {
    it('deve propagar o erro sem mascarar', async () => {
      const dbError = new Error('DB connection lost');
      const repo = makeRepo({ findBySlug: jest.fn().mockRejectedValue(dbError) });
      const useCase = new GetAiPromptUseCase(repo as any);

      await expect(useCase.execute('VACANCY_DESCRIPTION')).rejects.toThrow('DB connection lost');
    });
  });

  describe('Cenário 5 — Contrato de chamada', () => {
    it('deve chamar findBySlug exatamente uma vez com o slug correto', async () => {
      const findBySlug = jest.fn().mockResolvedValue(mockPrompt);
      const repo = makeRepo({ findBySlug });
      const useCase = new GetAiPromptUseCase(repo as any);

      await useCase.execute('VACANCY_DESCRIPTION');

      expect(findBySlug).toHaveBeenCalledTimes(1);
      expect(findBySlug).toHaveBeenCalledWith('VACANCY_DESCRIPTION');
    });
  });

  describe('Cenário 7 — Construtor sem repositório injetado', () => {
    it('usa uma AiPromptRepository real como default quando nenhum repo é passado', () => {
      const useCase = new GetAiPromptUseCase();

      expect((useCase as unknown as { repo: unknown }).repo).toBeInstanceOf(AiPromptRepository);
    });
  });

  describe('Cenário 6 — Listagem', () => {
    it('deve repassar os registros do repositório exatamente como retornados', async () => {
      const listAll = jest.fn().mockResolvedValue(mockPromptList);
      const repo = makeRepo({ listAll });
      const useCase = new GetAiPromptUseCase(repo as any);

      const result = await useCase.list();

      expect(result).toEqual(mockPromptList);
      expect(listAll).toHaveBeenCalledTimes(1);
    });

    it('deve propagar o erro do repositório sem mascarar', async () => {
      const dbError = new Error('DB connection lost');
      const repo = makeRepo({ listAll: jest.fn().mockRejectedValue(dbError) });
      const useCase = new GetAiPromptUseCase(repo as any);

      await expect(useCase.list()).rejects.toThrow('DB connection lost');
    });
  });
});
