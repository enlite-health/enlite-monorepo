import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DocumentsGrid } from './DocumentsGrid';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import { makeWorkerDocuments as makeDocuments } from '../../../../test/workerProgressFixtures';

// ── i18n mock — returns fallback text (or key when no fallback) so
// assertions read naturally and the AT/não-AT texts stay distinguishable ────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────
// makeDocuments vem de test/workerProgressFixtures.ts (fixture compartilhada
// com useWorkerProfileProgress.test.ts e WorkerHome.test.tsx — gate
// revisao-pr, critério 2).

const noop = vi.fn().mockResolvedValue(undefined);

function buildProps(overrides: Partial<{
  documents: WorkerDocumentsResponse | null;
  profession: string | null;
}> = {}) {
  return {
    documents: makeDocuments(),
    profession: null,
    onUpload: noop,
    onDelete: noop,
    onView: noop,
    ...overrides,
  };
}

describe('DocumentsGrid — aviso de pendentes por profissão (bug camada 0 #3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('AT com documentos pendentes → mostra o aviso nomeando "como Acompañante Terapéutico"', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'AT' })} />);
    const notice = screen.getByTestId('at-required-notice');
    expect(notice).toHaveTextContent('Para postularte como Acompañante Terapéutico necesitás subir:');
    expect(screen.queryByTestId('at-required-done')).not.toBeInTheDocument();
  });

  it('CUIDADOR com documentos pendentes → mostra o MESMO aviso, sem mencionar AT', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR' })} />);
    const notice = screen.getByTestId('at-required-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('Para postularte necesitás subir:');
    expect(notice).not.toHaveTextContent('Acompañante Terapéutico');
  });

  it('profession=null (gate trata como AT) com pendências → aviso de AT', () => {
    render(<DocumentsGrid {...buildProps({ profession: null })} />);
    expect(screen.getByTestId('at-required-notice')).toHaveTextContent('Acompañante Terapéutico');
  });

  it('CUIDADOR completo (identity_document + criminal_record) → aviso verde, sem o de pendência', () => {
    const documents = makeDocuments({
      identityDocumentUrl: 'path/dni.pdf',
      criminalRecordUrl: 'path/crim.pdf',
    });
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', documents })} />);
    expect(screen.getByTestId('at-required-done')).toBeInTheDocument();
    expect(screen.queryByTestId('at-required-notice')).not.toBeInTheDocument();
  });

  it('AT completo (4 docs obrigatórios) → aviso verde', () => {
    const documents = makeDocuments({
      resumeCvUrl: 'a', identityDocumentUrl: 'b', criminalRecordUrl: 'c', atCertificateUrl: 'd',
    });
    render(<DocumentsGrid {...buildProps({ profession: 'AT', documents })} />);
    expect(screen.getByTestId('at-required-done')).toBeInTheDocument();
    expect(screen.queryByTestId('at-required-notice')).not.toBeInTheDocument();
  });

  it('aviso de pendência do CUIDADOR lista os documentos que faltam', () => {
    const documents = makeDocuments({ identityDocumentUrl: 'path/dni.pdf' }); // falta criminal_record
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', documents })} />);
    expect(screen.getByTestId('at-required-notice')).toHaveTextContent('documentTypes.criminal_record');
  });

  it('CUIDADOR não vê o slot at_certificate (atOnly)', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR' })} />);
    expect(screen.queryByTestId('doc-slot-at_certificate')).not.toBeInTheDocument();
  });

  it('CUIDADOR vê o slot carta_recomendacion (cuidadorOnly)', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR' })} />);
    expect(screen.getByTestId('doc-slot-carta_recomendacion')).toBeInTheDocument();
  });

  it('AT não vê o slot carta_recomendacion (cuidadorOnly)', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'AT' })} />);
    expect(screen.queryByTestId('doc-slot-carta_recomendacion')).not.toBeInTheDocument();
  });

  it('AT vê os slots at_certificate, apto_psicofisico e analitico_universitario (atOnly)', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'AT' })} />);
    expect(screen.getByTestId('doc-slot-at_certificate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-slot-apto_psicofisico')).toBeInTheDocument();
    expect(screen.getByTestId('doc-slot-analitico_universitario')).toBeInTheDocument();
  });

  it('slot com documento enviado chama onView com o filePath ao clicar em "Visualizar"', async () => {
    const onView = vi.fn().mockResolvedValue(undefined);
    const documents = makeDocuments({ identityDocumentUrl: 'path/dni.pdf' });
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', documents, onView } as any)} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Visualizar documento'));
    });
    expect(onView).toHaveBeenCalledWith('path/dni.pdf');
  });

  it('slot com documento enviado chama onDelete com o docType ao clicar em "Remover"', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const documents = makeDocuments({ identityDocumentUrl: 'path/dni.pdf' });
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', documents, onDelete } as any)} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remover documento'));
    });
    expect(onDelete).toHaveBeenCalledWith('identity_document');
  });

  it('documents=null → nenhum slot marcado como enviado e onView não é chamável (getFilePath null)', () => {
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', documents: null })} />);
    expect(screen.queryByLabelText('Visualizar documento')).not.toBeInTheDocument();
  });

  it('erro no upload mostra a mensagem de erro no card do slot', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Falha no upload'));
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', onUpload } as any)} />);
    const slot = screen.getByTestId('doc-slot-identity_document');
    const input = slot.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await screen.findByText('Falha no upload');
  });

  it('erro no upload sem mensagem cai no fallback "Erro"', async () => {
    const onUpload = vi.fn().mockRejectedValue('boom');
    render(<DocumentsGrid {...buildProps({ profession: 'CUIDADOR', onUpload } as any)} />);
    const slot = screen.getByTestId('doc-slot-identity_document');
    const input = slot.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await screen.findByText('Erro');
  });
});
