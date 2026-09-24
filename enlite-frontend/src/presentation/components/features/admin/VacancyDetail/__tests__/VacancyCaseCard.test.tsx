import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyCaseCard } from '../VacancyCaseCard';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/components/atoms/VacancyStatusBadge', () => ({
  VacancyStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

const defaultProps = {
  status: 'BUSQUEDA',
  caseNumber: 748,
  dependencyLevel: 'MODERATE',
  profession: 'AT',
  sex: 'M',
  zone: 'Palermo',
  patientCity: 'Buenos Aires',
  patientNeighborhood: 'Palermo',
  paymentTermDays: 30,
  netHourlyRate: 'R$8.000,00',
  weeklyHours: 30,
  providersNeeded: 2,
  publishedAt: '2026-02-25T00:00:00Z',
  closedAt: null,
};

function renderCard(props = {}) {
  return render(<VacancyCaseCard {...defaultProps} {...props} />);
}

// ── Render with full data ────────────────────────────────────────────────────

describe('VacancyCaseCard — full data', () => {
  it('renders status badge', () => {
    renderCard();
    expect(screen.getByTestId('status-badge')).toBeInTheDocument();
  });

  it('renders case number in heading', () => {
    renderCard();
    // getAllByText because the case number can appear in multiple elements
    const elements = screen.getAllByText(/748/);
    expect(elements.length).toBeGreaterThan(0);
  });

  it('renders legado case number WITHOUT the "EN" prefix (< 1000, D412)', () => {
    renderCard({ caseNumber: 748 });
    expect(screen.queryByText(/EN748/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/748/).length).toBeGreaterThan(0);
  });

  it('renders dependency level pill', () => {
    renderCard();
    expect(screen.getByText('admin.patients.dependencyOptions.MODERATE')).toBeInTheDocument();
  });

  it('renders net hourly rate value', () => {
    renderCard();
    expect(screen.getByText('R$8.000,00')).toBeInTheDocument();
  });

  it('renders weekly hours with h suffix', () => {
    renderCard();
    expect(screen.getByText('30h')).toBeInTheDocument();
  });

  it('renders providers needed value', () => {
    renderCard();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders location city and neighborhood', () => {
    renderCard();
    expect(
      screen.getByText('Buenos Aires, Palermo'),
    ).toBeInTheDocument();
  });

  it('renders payment term section heading', () => {
    renderCard();
    expect(
      screen.getByText('admin.vacancyDetail.caseCard.paymentTerm'),
    ).toBeInTheDocument();
  });

  it('renders dates section heading', () => {
    renderCard();
    expect(
      screen.getByText('admin.vacancyDetail.caseCard.dates'),
    ).toBeInTheDocument();
  });
});

// ── Spec 028 — "CASO EN{n}" (formatCaseNumber) ───────────────────────────────

describe('VacancyCaseCard — formatCaseNumber (spec 028, caso nativo × nulo)', () => {
  it('caso NATIVO (case_number >= 1000): heading e descrição mostram "EN{n}"', () => {
    renderCard({ caseNumber: 1041 });
    // Heading: "admin.vacancyDetail.caseCard.caseLabel EN1041"
    expect(screen.getAllByText(/EN1041/).length).toBeGreaterThan(0);
    // Never the raw number without the prefix
    expect(screen.queryByText(/(?<!EN)\b1041\b/)).not.toBeInTheDocument();
  });

  it('caso nulo: heading cai para "—", sem lançar', () => {
    renderCard({ caseNumber: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});

// ── Partial/null data ────────────────────────────────────────────────────────

describe('VacancyCaseCard — partial data (missing optional fields)', () => {
  it('renders em dash when netHourlyRate is null', () => {
    renderCard({ netHourlyRate: null });
    // at least one — should appear
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('renders em dash when weeklyHours is null', () => {
    renderCard({ weeklyHours: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('does NOT render dependency pill when dependencyLevel is null', () => {
    renderCard({ dependencyLevel: null });
    expect(screen.queryByText('admin.patients.dependencyOptions.MODERATE')).not.toBeInTheDocument();
  });

  it('does NOT render location row when patientCity and patientNeighborhood are null', () => {
    renderCard({ patientCity: null, patientNeighborhood: null });
    expect(screen.queryByText(/Buenos Aires/)).not.toBeInTheDocument();
  });

  it('renders "—" for providersNeeded when null', () => {
    renderCard({ providersNeeded: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('renders "—" for paymentTermDays when null', () => {
    renderCard({ paymentTermDays: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('profession e sex nulos: caseParts cai só no zone (sexLabel/professionLabel = null)', () => {
    renderCard({ profession: null, sex: null, zone: 'Palermo' });
    // caseDesc vira "CASO 748 - Palermo" — sem os rótulos de profissão/sexo.
    expect(screen.getAllByText(/748 - Palermo/).length).toBeGreaterThan(0);
  });

  it('caso nulo E sem profissão/sexo/zona: caseDesc cai no "—" (nenhuma caseParts)', () => {
    renderCard({ caseNumber: null, profession: null, sex: null, zone: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});

// ── formatDateAR — branch do catch (defensivo) ───────────────────────────────

describe('VacancyCaseCard — formatDateAR catch (defensivo)', () => {
  it('toLocaleDateString lançando: cai no "—" em vez de propagar', () => {
    const original = Date.prototype.toLocaleDateString;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Date.prototype as any).toLocaleDateString = () => {
      throw new Error('boom — Intl indisponível');
    };
    try {
      renderCard({ publishedAt: '2026-02-25T00:00:00Z' });
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThan(0);
    } finally {
      Date.prototype.toLocaleDateString = original;
    }
  });
});

// ── D269 — status editor (PUT /vacancies/:id → vacancy:write) ───────────────

describe('VacancyCaseCard — status editor gate (D269)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
      } as AuthzContract,
    });
  }

  it('🔴 enforcement=on, sem vacancy:write: o EDITOR não existe — vira o badge estático (texto, sem gatilho/dropdown)', () => {
    comEnforcement([], 'on');
    renderCard({ onStatusChange: vi.fn() });
    expect(screen.queryByTestId('vacancy-status-editor-trigger')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-badge')).toBeInTheDocument();
  });

  it('enforcement=on, com vacancy:write: o editor existe (gatilho clicável)', () => {
    comEnforcement(['vacancy:update'], 'on');
    renderCard({ onStatusChange: vi.fn() });
    expect(screen.getByTestId('vacancy-status-editor-trigger')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): editor existe mesmo sem célula', () => {
    renderCard({ onStatusChange: vi.fn() }); // authz null — sem enforcement
    expect(screen.getByTestId('vacancy-status-editor-trigger')).toBeInTheDocument();
  });
});
