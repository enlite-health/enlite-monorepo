import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseDetailsModal } from '../CaseDetailsModal';

// i18n mockado no molde dos vizinhos: devolve a própria chave, então as asserções
// são sobre testid e conteúdo, não sobre o texto traduzido.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const dx = (over = {}) => ({
  id: 'dx-1',
  uri: 'http://id.who.int/icd/entity/222222',
  title: 'Enfermedad pulmonar obstructiva crónica',
  isPrimary: true,
  source: 'PANEL',
  active: true,
  ...over,
});

function renderModal(caseInfo: Record<string, unknown>) {
  return render(
    <CaseDetailsModal
      isOpen
      onClose={() => {}}
      caseData={{ caseInfo: { case_number: 442, ...caseInfo }, metrics: {}, publicationsHistory: [] }}
    />,
  );
}

describe('CaseDetailsModal — patología', () => {
  it('lista os títulos', () => {
    renderModal({ diagnoses: [dx(), dx({ id: 'dx-2', title: 'Asma', isPrimary: false })] });
    const el = screen.getByTestId('case-details-patologias');
    expect(el).toHaveTextContent('Enfermedad pulmonar obstructiva crónica');
    expect(el).toHaveTextContent('Asma');
  });

  it('NUNCA mostra o código/URI do CID (REQ-21)', () => {
    renderModal({ diagnoses: [dx()] });
    expect(screen.queryByText(/id\.who\.int/)).toBeNull();
    expect(screen.queryByText(/6A02/)).toBeNull();
  });

  it('sem diagnóstico mostra "-"', () => {
    renderModal({ diagnoses: [] });
    expect(screen.getByTestId('case-details-patologia-empty')).toHaveTextContent('-');
  });

  it('sem permissão NÃO vira vazio', () => {
    renderModal({ diagnoses: null });
    expect(screen.getByTestId('case-details-patologia-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('case-details-patologia-empty')).toBeNull();
  });

  it('falha de leitura avisa, em vez de fingir ausência', () => {
    renderModal({ diagnoses: [], diagnosesUnavailable: true });
    expect(screen.getByTestId('case-details-patologia-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('case-details-patologia-empty')).toBeNull();
  });
});
