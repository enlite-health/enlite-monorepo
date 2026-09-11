/**
 * Fase 2 de postulacao-documento-pendente: `useWorkerProfileProgress` parou
 * de saber de documentos (DD1) — só de REGISTRO. `ProfileCompletionSummary`
 * combina esse veredito com `areAllRequiredDocsComplete(documentsData, ...)`
 * pra decidir "completo" de verdade (branch nova, introduzida nesta fase).
 *
 * Sem este AND, um worker com REGISTRO ok mas documento pendente veria a
 * tela "¡Tu registro está completo!" incorretamente — mesmo a lista de
 * pendências (`pendingTabs`, que já checava documentos por conta própria)
 * continuando certa por baixo.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

// Registro SEMPRE completo (hook novo, Fase 2 — só sabe de registro).
// `progress` precisa da FORMA real (WorkerProfileProgress: overallPercentage
// + sections[]) — `ProfileCompletionCard` (renderizado no ramo "pendente")
// itera `progress.sections`, e um mock raso (`progress: 100`) quebra assim
// que esse ramo é exercido pela primeira vez.
vi.mock('@presentation/hooks/useWorkerProfileProgress', () => ({
  useWorkerProfileProgress: () => ({
    progress: { overallPercentage: 100, sections: [] },
    isComplete: true,
  }),
}));

vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({
    getProgress: vi.fn().mockResolvedValue({}),
    getAvailability: vi.fn().mockResolvedValue([]),
  }),
}));

const mockGetDocuments = vi.fn();
vi.mock('@infrastructure/http/DocumentApiService', () => ({
  DocumentApiService: { getDocuments: (...args: unknown[]) => mockGetDocuments(...args) },
}));

import { ProfileCompletionSummary } from './ProfileCompletionSummary';

describe('ProfileCompletionSummary — completude combina registro + documentos', () => {
  it('registro completo mas documento pendente (profession ausente → Cuidador) → tela de PENDÊNCIAS, não a de parabéns', async () => {
    // Cuidador exige identity_document + criminal_record (F5); falta o 2º.
    mockGetDocuments.mockResolvedValue({ identityDocumentUrl: 'path/identity.pdf' });

    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('summary-pending')).toBeInTheDocument());
    expect(screen.queryByTestId('summary-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-view-vacancies')).not.toBeInTheDocument();
    // BLOCKER 2 (gate 11/09): `useWorkerProfileProgress` só sabe de REGISTRO
    // (DD1) — o mock acima devolve `overallPercentage: 100` porque o
    // REGISTRO está completo aqui; só o documento falta. Antes do fix, o
    // ramo pendente renderizava `ProfileCompletionCard` sempre, mostrando
    // "100%" em cima de "Te falta completar: Documentos" — uma mentira
    // visual. Quem só tem documento pendente não deve ver NENHUM percentual
    // de registro na tela.
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('registro completo E os dois documentos de Cuidador presentes → tela de PARABÉNS', async () => {
    mockGetDocuments.mockResolvedValue({
      identityDocumentUrl: 'path/identity.pdf',
      criminalRecordUrl: 'path/criminal.pdf',
    });

    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('summary-complete')).toBeInTheDocument());
    expect(screen.queryByTestId('summary-pending')).not.toBeInTheDocument();
  });
});
