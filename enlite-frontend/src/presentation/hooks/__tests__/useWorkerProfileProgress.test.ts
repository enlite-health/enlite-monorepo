import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkerProfileProgress } from '../useWorkerProfileProgress';
import { makeWorkerProgress as makeWorker } from '../../../test/workerProgressFixtures';

// Suprime os avisos do i18next em ambiente de teste
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

/**
 * Fase 2 de postulacao-documento-pendente (DD1/DD2, fecha F4): este hook
 * PAROU de calcular documentos — a pendência de documento agora vem NOMEADA
 * do servidor (`missingFields` com `doc_*`, Fase 1) e é exibida pela lista
 * de tarefas (`PendingTasksCard`), não aqui. Os testes que existiam para a
 * seção "documents" (AT × Cuidador, `documentsData`, CTA de upload) saíram
 * COM a funcionalidade — não fazia sentido manter teste de comportamento que
 * o hook não tem mais. `useWorkerProfileProgress.contract.test.ts` (se
 * existir depois) e `PendingTasksCard.test.tsx` cobrem documentos agora.
 */
describe('useWorkerProfileProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('workerData nulo', () => {
    it('retorna 0% e sections vazio quando workerData é null', () => {
      const { result } = renderHook(() => useWorkerProfileProgress(null));
      expect(result.current.progress.overallPercentage).toBe(0);
      expect(result.current.progress.sections).toHaveLength(0);
      expect(result.current.isComplete).toBe(false);
    });
  });

  describe('seção única: registro', () => {
    it('só existe UMA seção ("registration") — não "documents"', () => {
      const worker = makeWorker({ missingFields: [] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      expect(result.current.progress.sections.map((s) => s.id)).toEqual(['registration']);
    });

    it('3 passos completos (missingFields: []) → seção 100%, isComplete true', () => {
      const worker = makeWorker({ missingFields: [] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      const section = result.current.progress.sections[0];
      expect(section.completedCount).toBe(3);
      expect(section.totalCount).toBe(3);
      expect(section.percentage).toBe(100);
      expect(result.current.isComplete).toBe(true);
      expect(result.current.progress.overallPercentage).toBe(100);
    });

    it('falta phone (aba general) → step1 pendente, isComplete false', () => {
      const worker = makeWorker({ missingFields: ['phone'] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      expect(result.current.isComplete).toBe(false);
      expect(result.current.progress.overallPercentage).toBeLessThan(100);
    });

    it('doc_* em missingFields NÃO afeta a seção de registro (não é aba general/address/availability)', () => {
      const worker = makeWorker({ missingFields: ['doc_criminal_record'] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      // Só documento pendente → registro 100%, isComplete true (a
      // completude de DOCUMENTO não é mais responsabilidade deste hook).
      expect(result.current.isComplete).toBe(true);
    });
  });

  describe('nextAction', () => {
    it('cadastro incompleto (falta telefone) → CTA leva ao cadastro', () => {
      const worker = makeWorker({ missingFields: ['phone'] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      expect(result.current.progress.nextAction).toEqual({
        label: 'profile.progress.completeRegistration',
        route: '/worker-registration',
      });
    });

    it('nextAction é undefined quando os 3 passos de registro estão completos', () => {
      const worker = makeWorker({ missingFields: [] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      expect(result.current.progress.nextAction).toBeUndefined();
    });

    it('nextAction é undefined mesmo com doc_* pendente (upload não é mais CTA deste hook)', () => {
      const worker = makeWorker({ missingFields: ['doc_criminal_record'] });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      expect(result.current.progress.nextAction).toBeUndefined();
    });
  });
});
