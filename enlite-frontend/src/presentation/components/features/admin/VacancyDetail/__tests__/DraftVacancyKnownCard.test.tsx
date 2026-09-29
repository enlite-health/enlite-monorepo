import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DraftVacancyKnownCard } from '../DraftVacancyKnownCard';
import type { ComponentProps } from 'react';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type Props = ComponentProps<typeof DraftVacancyKnownCard>;

const dx = (over: Partial<PatientDiagnosisDetail> = {}): PatientDiagnosisDetail => ({
  id: 'dx-1',
  uri: 'http://id.who.int/icd/entity/999999',
  title: 'Trastorno del ritmo circadiano',
  isPrimary: true,
  source: 'PANEL',
  active: true,
  ...over,
});

const defaultProps: Props = {
  patientDisplayName: 'Juan Perez',
  dependencyLine: null,
  serviceDisplayValue: 'AT',
  providersNeeded: 1,
  emptyValue: 'Sin completar',
  addressDisplayValue: 'Palermo 123',
  addressZoneCityLine: null,
  schedule: null,
  scheduleSummary: '6 días, 32 horas',
  ageRangeValue: '25 - 45',
  hourlyRateValue: '$1000',
  isDefaultSalary: false,
  publicationLabel: '24 sep',
  patientId: 'patient-1',
  diagnoses: [],
  diagnosesUnavailable: false,
};

function renderCard(props: Partial<Props> = {}) {
  return render(
    <MemoryRouter>
      <DraftVacancyKnownCard {...defaultProps} {...props} />
    </MemoryRouter>,
  );
}

// ── Patología (CID-11 lido do paciente, spec cid-na-vacante) ───────────────────
// Os três estados são distintos de propósito: "não carregou" nunca pode se
// disfarçar de "não tem" — a tela mentiria sobre o paciente (regra dura do CLAUDE.md).

describe('DraftVacancyKnownCard — patología', () => {
  it('lista os títulos das patologías', () => {
    renderCard({
      diagnoses: [dx(), dx({ id: 'dx-2', title: 'Hipertensión esencial', isPrimary: false })],
    });
    const el = screen.getByTestId('draft-vacancy-patologias');
    expect(el).toHaveTextContent('Trastorno del ritmo circadiano');
    expect(el).toHaveTextContent('Hipertensión esencial');
  });

  it('NUNCA mostra código, grupo, release ou uri do CID — só o título (REQ-21)', () => {
    renderCard({
      diagnoses: [dx({ title: 'Trastorno del ritmo circadiano' })],
    });
    expect(screen.queryByText(/6A02/)).toBeNull();
    expect(screen.queryByText(/http:\/\/id\.who\.int/)).toBeNull();
    expect(screen.queryByText(/999999/)).toBeNull();
  });

  it('sem diagnóstico registrado mostra "—"', () => {
    renderCard({ diagnoses: [] });
    expect(screen.getByTestId('draft-vacancy-patologias-empty')).toHaveTextContent('—');
  });

  it('ator sem permissão clínica NÃO vê "—", vê o aviso de permissão', () => {
    renderCard({ diagnoses: null });
    expect(screen.getByTestId('draft-vacancy-patologias-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-vacancy-patologias-empty')).toBeNull();
  });

  it('falha de leitura do catálogo avisa, em vez de fingir que não há diagnóstico', () => {
    renderCard({ diagnoses: [], diagnosesUnavailable: true });
    expect(screen.getByTestId('draft-vacancy-patologias-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-vacancy-patologias-empty')).toBeNull();
  });
});
