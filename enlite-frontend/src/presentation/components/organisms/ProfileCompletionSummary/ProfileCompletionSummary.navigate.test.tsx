/**
 * Regressão: o CTA "Ver vacantes" do resumo de cadastro completo deve navegar
 * para `/` (RoleBasedHome → home do worker com as vacantes), NUNCA para `/worker`.
 *
 * Bug original: onClick={() => navigate('/worker')}. Não existe rota `/worker`
 * nem catch-all `path="*"` em App.tsx, então React Router renderizava null →
 * TELA BRANCA após concluir o cadastro. Ver docs/features/worker-registration-ux/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

// Força o estado "cadastro completo" para renderizar o CTA "Ver vacantes".
//
// Fase 2 de postulacao-documento-pendente: `useWorkerProfileProgress` só
// sabe de REGISTRO (documentos saíram — DD1). `ProfileCompletionSummary`
// combina esse veredito com `areAllRequiredDocsComplete(documentsData, ...)`
// pra decidir "completo" de verdade — então o mock de documentos abaixo
// também precisa estar completo, senão o CTA nunca aparece (documentos
// pendentes → tela de pendências, não a de parabéns).
vi.mock('@presentation/hooks/useWorkerProfileProgress', () => ({
  useWorkerProfileProgress: () => ({ progress: 100, isComplete: true }),
}));

vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({
    getProgress: vi.fn().mockResolvedValue({}),
    getAvailability: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('@infrastructure/http/DocumentApiService', () => ({
  DocumentApiService: {
    // profession ausente no mock de getProgress → classifyProfession trata
    // como Cuidador (identity_document + criminal_record). Os dois presentes
    // aqui é o que faz areAllRequiredDocsComplete devolver true.
    getDocuments: vi.fn().mockResolvedValue({
      identityDocumentUrl: 'path/identity.pdf',
      criminalRecordUrl: 'path/criminal.pdf',
    }),
  },
}));

import { ProfileCompletionSummary } from './ProfileCompletionSummary';

describe('ProfileCompletionSummary — CTA "Ver vacantes"', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('navega para a home "/" (não para a rota inexistente "/worker")', async () => {
    render(<ProfileCompletionSummary onClose={vi.fn()} onGoToTab={vi.fn()} />);

    const cta = await waitFor(() => screen.getByTestId('summary-view-vacancies'));
    fireEvent.click(cta);

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockNavigate).not.toHaveBeenCalledWith('/worker');
  });
});
