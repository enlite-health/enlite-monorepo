/**
 * ProfileCompletionSummary.test.tsx
 *
 * Fecha a cobertura do arquivo (D200.12 — arquivo no diff da Fase 2 de
 * postulacao-documento-pendente, régua é 100% do ARQUIVO INTEIRO, não só
 * das linhas que esta fase escreveu). `.navigate.test.tsx` cobre o CTA "Ver
 * vacantes"; `.completeness.test.tsx` cobre o AND registro×documentos. Este
 * arquivo cobre o resto: interações (fechar, clicar numa aba pendente),
 * erro no fetch (com e sem cancelamento por unmount) e as combinações de
 * `pendingTabs` que faltavam (steps completos individualmente).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { makeWorkerProgress } from '../../../../test/workerProgressFixtures';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Registro sempre "conhecido mas incompleto" por padrão aqui — cada teste
// decide via o próprio `workerData` (missingFields) o que realmente importa
// pra `pendingTabs`; o hook só precisa não travar o render.
vi.mock('@presentation/hooks/useWorkerProfileProgress', () => ({
  useWorkerProfileProgress: () => ({
    progress: { overallPercentage: 0, sections: [] },
    isComplete: false,
  }),
}));

const mockGetProgress = vi.fn();
const mockGetAvailability = vi.fn();
vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({ getProgress: mockGetProgress, getAvailability: mockGetAvailability }),
}));

const mockGetDocuments = vi.fn();
vi.mock('@infrastructure/http/DocumentApiService', () => ({
  DocumentApiService: { getDocuments: (...args: unknown[]) => mockGetDocuments(...args) },
}));

import { ProfileCompletionSummary } from './ProfileCompletionSummary';

/** Promise controlável de fora — pra testar as duas metades do guard `cancelled`. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProfileCompletionSummary — fechar', () => {
  it('botão X (summary-close) chama onClose', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone'] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});
    const onClose = vi.fn();

    render(<ProfileCompletionSummary onClose={onClose} onGoToTab={vi.fn()} />);
    await waitFor(() => screen.getByTestId('summary-pending'));

    fireEvent.click(screen.getByTestId('summary-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicar no fundo (overlay) chama onClose', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone'] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});
    const onClose = vi.fn();

    render(<ProfileCompletionSummary onClose={onClose} onGoToTab={vi.fn()} />);
    await waitFor(() => screen.getByTestId('summary-pending'));

    fireEvent.click(screen.getByTestId('profile-completion-summary'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicar DENTRO do card (conteúdo) NÃO chama onClose — stopPropagation', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone'] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});
    const onClose = vi.fn();

    render(<ProfileCompletionSummary onClose={onClose} onGoToTab={vi.fn()} />);
    await waitFor(() => screen.getByTestId('summary-pending'));

    // "Te falta completar:" fica dentro do card interno (o que tem stopPropagation).
    fireEvent.click(screen.getByText('Te falta completar:'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('botão "Seguir editando" chama onClose', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone'] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});
    const onClose = vi.fn();

    render(<ProfileCompletionSummary onClose={onClose} onGoToTab={vi.fn()} />);
    await waitFor(() => screen.getByTestId('summary-keep-editing'));

    fireEvent.click(screen.getByTestId('summary-keep-editing'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileCompletionSummary — pendingTabs: cada combinação step completo/incompleto', () => {
  it('registro TOTALMENTE completo (missingFields: []) + documento pendente → só a aba "documents" aparece (steps 1/2/3 NÃO entram)', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: [] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({}); // nenhum documento → pendente

    const onGoToTab = vi.fn();
    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={onGoToTab} />);
    await waitFor(() => screen.getByTestId('summary-pending'));

    expect(screen.queryByTestId('summary-pending-general')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-pending-address')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-pending-availability')).not.toBeInTheDocument();
    const docRow = screen.getByTestId('summary-pending-documents');
    expect(docRow).toBeInTheDocument();

    fireEvent.click(docRow);
    expect(onGoToTab).toHaveBeenCalledWith('documents');
  });

  it('registro TOTALMENTE incompleto + documentos completos → as 3 abas de registro aparecem, "documents" NÃO aparece', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone', 'worker_service_areas', 'worker_availability'] }));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({
      identityDocumentUrl: 'path/identity.pdf',
      criminalRecordUrl: 'path/criminal.pdf',
    });

    const onGoToTab = vi.fn();
    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={onGoToTab} />);
    await waitFor(() => screen.getByTestId('summary-pending'));

    expect(screen.getByTestId('summary-pending-general')).toBeInTheDocument();
    expect(screen.getByTestId('summary-pending-address')).toBeInTheDocument();
    expect(screen.getByTestId('summary-pending-availability')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-pending-documents')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('summary-pending-address'));
    expect(onGoToTab).toHaveBeenCalledWith('address');
  });
});

describe('ProfileCompletionSummary — availability presente (ramo `length > 0` do slots)', () => {
  it('getAvailability devolve slots → workerData.availability vira { slots }, sem crash', async () => {
    mockGetProgress.mockResolvedValue(makeWorkerProgress({ missingFields: ['phone'] }));
    mockGetAvailability.mockResolvedValue([{ day: 'monday', start: '09:00', end: '17:00' }]);
    mockGetDocuments.mockResolvedValue({});

    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);

    await waitFor(() => screen.getByTestId('summary-pending'));
    // Não afirma NADA sobre o CONTEÚDO de availability na tela (este resumo
    // não renderiza slots) — só prova que o ramo `length > 0` roda sem
    // quebrar o componente.
    expect(screen.getByTestId('summary-pending-general')).toBeInTheDocument();
  });
});

describe('ProfileCompletionSummary — erro no fetch (linha 81 do catch)', () => {
  it('getProgress rejeita (sem unmount) → workerData vira null, tela de pendências vazia, sem crash', async () => {
    mockGetProgress.mockRejectedValue(new Error('network down'));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});

    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);

    await waitFor(() => screen.getByTestId('summary-pending'));
    // workerData null → pendingTabs = [] (linha 91: `if (!workerData) return [];`)
    expect(screen.queryByTestId('summary-pending-general')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-pending-documents')).not.toBeInTheDocument();
  });

  it('unmount ANTES do erro chegar → o guard `cancelled` impede setWorkerData/setIsLoading pós-unmount (sem warning de "update on unmounted")', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deferred<never>();
    mockGetProgress.mockReturnValue(d.promise);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});

    const { unmount } = render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);
    unmount();
    d.reject(new Error('too late, already unmounted'));

    // Dá um tick pra microtask do catch/finally rodar.
    await new Promise((r) => setTimeout(r, 0));

    const updateOnUnmountedWarning = errorSpy.mock.calls.some((call) =>
      String(call[0]).includes('unmounted component'),
    );
    expect(updateOnUnmountedWarning).toBe(false);
    errorSpy.mockRestore();
  });

  it('unmount ANTES do sucesso chegar → o guard `cancelled` impede setWorkerData/setDocumentsData pós-unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deferred<WorkerProgressResponse>();
    mockGetProgress.mockReturnValue(d.promise);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue({});

    const { unmount } = render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);
    unmount();
    d.resolve(makeWorkerProgress({ missingFields: [] }));

    await new Promise((r) => setTimeout(r, 0));

    const updateOnUnmountedWarning = errorSpy.mock.calls.some((call) =>
      String(call[0]).includes('unmounted component'),
    );
    expect(updateOnUnmountedWarning).toBe(false);
    errorSpy.mockRestore();
  });
});
