import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyStatusBadge } from './VacancyStatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Canonical status mappings (post-migration 148 + 166) ─────────────────────

describe('VacancyStatusBadge — SEARCHING', () => {
  it('renders with correct i18n key', () => {
    render(<VacancyStatusBadge status="SEARCHING" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING')).toBeInTheDocument();
  });

  it('has bg-blue-yonder class', () => {
    render(<VacancyStatusBadge status="SEARCHING" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING').className).toContain('bg-blue-yonder');
  });
});

describe('VacancyStatusBadge — SEARCHING_REPLACEMENT', () => {
  it('renders with wait background', () => {
    render(<VacancyStatusBadge status="SEARCHING_REPLACEMENT" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT').className).toContain('bg-wait');
  });
});

describe('VacancyStatusBadge — RAPID_RESPONSE', () => {
  it('renders with wait background', () => {
    render(<VacancyStatusBadge status="RAPID_RESPONSE" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.RAPID_RESPONSE').className).toContain('bg-wait');
  });
});

describe('VacancyStatusBadge — PENDING_ACTIVATION', () => {
  it('renders with i18n label (not raw status)', () => {
    render(<VacancyStatusBadge status="PENDING_ACTIVATION" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.PENDING_ACTIVATION')).toBeInTheDocument();
  });

  it('has bg-cyan-focus class', () => {
    render(<VacancyStatusBadge status="PENDING_ACTIVATION" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.PENDING_ACTIVATION').className).toContain('bg-cyan-focus');
  });
});

describe('VacancyStatusBadge — ACTIVE', () => {
  it('renders with correct i18n key', () => {
    render(<VacancyStatusBadge status="ACTIVE" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVE')).toBeInTheDocument();
  });

  it('has bg-blue-yonder class', () => {
    render(<VacancyStatusBadge status="ACTIVE" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVE').className).toContain('bg-blue-yonder');
  });
});

describe('VacancyStatusBadge — ON_HOLD', () => {
  it('renders with wait background', () => {
    render(<VacancyStatusBadge status="ON_HOLD" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ON_HOLD').className).toContain('bg-wait');
  });
});

describe('VacancyStatusBadge — SUSPENDED', () => {
  it('has bg-gray-800 class', () => {
    render(<VacancyStatusBadge status="SUSPENDED" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SUSPENDED').className).toContain('bg-gray-800');
  });
});

describe('VacancyStatusBadge — CLOSED', () => {
  it('has bg-gray-800 class', () => {
    render(<VacancyStatusBadge status="CLOSED" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.CLOSED').className).toContain('bg-gray-800');
  });
});

describe('VacancyStatusBadge — ADMISSION', () => {
  it('has bg-cyan-focus class', () => {
    render(<VacancyStatusBadge status="ADMISSION" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ADMISSION').className).toContain('bg-cyan-focus');
  });
});

// ── Legacy aliases (pre-migration 148) ───────────────────────────────────────

describe('VacancyStatusBadge — BUSQUEDA (legacy alias)', () => {
  it('maps BUSQUEDA to SEARCHING label', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — ACTIVO (legacy alias)', () => {
  it('maps ACTIVO to ACTIVE label', () => {
    render(<VacancyStatusBadge status="ACTIVO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVE')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — REEMPLAZOS (legacy alias)', () => {
  it('maps REEMPLAZOS to SEARCHING_REPLACEMENT label', () => {
    render(<VacancyStatusBadge status="REEMPLAZOS" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — REEMPLAZO (legacy alias)', () => {
  it('maps REEMPLAZO to SEARCHING_REPLACEMENT label', () => {
    render(<VacancyStatusBadge status="REEMPLAZO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — CERRADO (legacy alias)', () => {
  it('maps CERRADO to CLOSED label', () => {
    render(<VacancyStatusBadge status="CERRADO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.CLOSED')).toBeInTheDocument();
  });
});

// ── Fallback ────────────────────────────────────────────────────────────────

describe('VacancyStatusBadge — fallback (unknown status)', () => {
  it('capitalizes and shows raw status', () => {
    render(<VacancyStatusBadge status="UNKNOWN_STATUS" />);
    expect(screen.getByText('Unknown_status')).toBeInTheDocument();
  });

  it('uses bg-gray-800 for unknown status', () => {
    render(<VacancyStatusBadge status="UNKNOWN_STATUS" />);
    expect(screen.getByText('Unknown_status').className).toContain('bg-gray-800');
  });
});

// ── Styling ──────────────────────────────────────────────────────────────────

describe('VacancyStatusBadge — base styling', () => {
  it('always renders as <span>', () => {
    render(<VacancyStatusBadge status="SEARCHING" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING').tagName).toBe('SPAN');
  });

  it('has font-poppins class', () => {
    render(<VacancyStatusBadge status="SEARCHING" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING').className).toContain('font-poppins');
  });

  it('has text-white class', () => {
    render(<VacancyStatusBadge status="SEARCHING" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING').className).toContain('text-white');
  });

  it('applies extra className prop', () => {
    render(<VacancyStatusBadge status="SEARCHING" className="extra-class" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.SEARCHING').className).toContain('extra-class');
  });
});
