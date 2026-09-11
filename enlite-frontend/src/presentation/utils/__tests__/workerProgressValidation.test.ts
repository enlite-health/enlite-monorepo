import { describe, it, expect } from 'vitest';
import {
  isStep1Complete,
  isStep2Complete,
  isStep3Complete,
  isCompletenessKnown,
  getStep1Progress,
  getStep2Progress,
  getStep3Progress,
  validateRegistrationSteps,
} from '../workerProgressValidation';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

/**
 * Contrato NOVO (08/09/2026): completude é DERIVADA do `missingFields` que o
 * backend devolve — a mesma lista que decide se a postulação passa. Este módulo
 * não olha mais campo por campo, então as fixtures descrevem o VEREDITO do
 * servidor, não os valores do cadastro.
 *
 * A suíte anterior alimentava campos e afirmava o cálculo local. Ela passava
 * verde afirmando o defeito: dava "etapa 1 completa" para quem não tinha
 * `phone` nem `title_certificate` — os dois campos que o portão exige e a
 * lista do frontend ignorava. Os testes marcados REGRESSÃO abaixo são
 * exatamente esses casos, agora com o sinal invertido.
 */
const withMissing = (missingFields: string[] | null | undefined): WorkerProgressResponse =>
  ({
    id: '123',
    authUid: 'auth123',
    email: 'test@example.com',
    status: 'INCOMPLETE_REGISTER',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    missingFields,
  }) as WorkerProgressResponse;

describe('workerProgressValidation — completude derivada do backend', () => {
  describe('isCompletenessKnown', () => {
    it('array (mesmo vazio) = o backend respondeu', () => {
      expect(isCompletenessKnown(withMissing([]))).toBe(true);
      expect(isCompletenessKnown(withMissing(['phone']))).toBe(true);
    });

    it('null ou ausente = não sei', () => {
      expect(isCompletenessKnown(withMissing(null))).toBe(false);
      expect(isCompletenessKnown(withMissing(undefined))).toBe(false);
    });
  });

  describe('isStep1Complete', () => {
    it('true quando o backend não reporta pendência nenhuma', () => {
      expect(isStep1Complete(withMissing([]))).toBe(true);
    });

    it('false quando falta um campo da aba geral', () => {
      expect(isStep1Complete(withMissing(['first_name']))).toBe(false);
      expect(isStep1Complete(withMissing(['languages']))).toBe(false);
    });

    it('REGRESSÃO — sem telefone a etapa 1 NÃO está completa', () => {
      // A lista antiga do frontend não olhava `phone`: devolvia `true` aqui, a
      // home dizia "cadastro completo" e a postulação era recusada.
      expect(isStep1Complete(withMissing(['phone']))).toBe(false);
    });

    it('REGRESSÃO — sem título profissional a etapa 1 NÃO está completa', () => {
      // 18 das 23 prestadoras travadas em produção envolviam este campo.
      expect(isStep1Complete(withMissing(['title_certificate']))).toBe(false);
    });

    it('pendência de OUTRA aba não derruba a etapa 1', () => {
      expect(isStep1Complete(withMissing(['worker_service_areas']))).toBe(true);
      expect(isStep1Complete(withMissing(['worker_availability']))).toBe(true);
      expect(isStep1Complete(withMissing(['worker_documents']))).toBe(true);
    });

    it('FAIL-CLOSED — sem resposta do backend, não afirma completo', () => {
      // "Não sei" nunca pode virar "está tudo certo": é a confusão que originou
      // o incidente. Preferimos mandar conferir um cadastro pronto a dizer
      // "completo" e a pessoa levar "registro incompleto" ao se postular.
      expect(isStep1Complete(withMissing(null))).toBe(false);
      expect(isStep1Complete(withMissing(undefined))).toBe(false);
    });

    it('FAIL-CLOSED — token desconhecido trava em vez de liberar', () => {
      // Campo novo no portão que ninguém mapeou cai no fallback 'general'.
      expect(isStep1Complete(withMissing(['campo_que_ainda_nao_existe']))).toBe(false);
    });
  });

  describe('isStep2Complete / isStep3Complete', () => {
    it('true quando não há pendência da própria aba', () => {
      expect(isStep2Complete(withMissing(['phone']))).toBe(true);
      expect(isStep3Complete(withMissing(['phone']))).toBe(true);
    });

    it('false quando a pendência é da própria aba', () => {
      expect(isStep2Complete(withMissing(['worker_service_areas']))).toBe(false);
      expect(isStep3Complete(withMissing(['worker_availability']))).toBe(false);
    });

    it('FAIL-CLOSED sem resposta do backend', () => {
      expect(isStep2Complete(withMissing(null))).toBe(false);
      expect(isStep3Complete(withMissing(null))).toBe(false);
    });
  });

  describe('progresso por etapa', () => {
    it('100% quando nada falta', () => {
      expect(getStep1Progress(withMissing([])).percentage).toBe(100);
      expect(getStep2Progress(withMissing([])).percentage).toBe(100);
      expect(getStep3Progress(withMissing([])).percentage).toBe(100);
    });

    it('desconta só os campos pendentes da própria aba', () => {
      const p = getStep1Progress(withMissing(['phone', 'title_certificate', 'worker_availability']));
      expect(p.totalFields).toBeGreaterThan(0);
      // as duas pendências da aba geral descontam; a de disponibilidade não
      expect(p.completedFields).toBe(p.totalFields - 2);
      expect(p.percentage).toBeLessThan(100);
    });

    it('o denominador da etapa 1 inclui phone e title_certificate', () => {
      // O denominador antigo era 14 e omitia os dois campos do incidente.
      const p = getStep1Progress(withMissing([]));
      expect(p.totalFields).toBeGreaterThanOrEqual(15);
    });

    it('sem resposta do backend, 0% — "não sei", não "não preencheu"', () => {
      expect(getStep1Progress(withMissing(null)).percentage).toBe(0);
    });
  });

  describe('validateRegistrationSteps', () => {
    it('cadastro completo libera as três etapas', () => {
      expect(validateRegistrationSteps(withMissing([]))).toEqual({
        step1: true,
        step2: true,
        step3: true,
      });
    });

    it('separa a pendência na etapa certa', () => {
      expect(validateRegistrationSteps(withMissing(['phone', 'worker_availability']))).toEqual({
        step1: false,
        step2: true,
        step3: false,
      });
    });

    it('FAIL-CLOSED sem resposta do backend', () => {
      expect(validateRegistrationSteps(withMissing(null))).toEqual({
        step1: false,
        step2: false,
        step3: false,
      });
    });
  });
});
