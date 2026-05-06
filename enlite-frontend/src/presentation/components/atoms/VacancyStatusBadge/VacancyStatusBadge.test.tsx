import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyStatusBadge } from './VacancyStatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Status mappings ──────────────────────────────────────────────────────────

describe('VacancyStatusBadge — BUSQUEDA', () => {
  it('renders with correct i18n key', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA')).toBeInTheDocument();
  });

  it('has bg-blue-yonder class', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA').className).toContain('bg-blue-yonder');
  });
});

describe('VacancyStatusBadge — ACTIVO', () => {
  it('renders with correct i18n key', () => {
    render(<VacancyStatusBadge status="ACTIVO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVO')).toBeInTheDocument();
  });

  it('has bg-blue-yonder class', () => {
    render(<VacancyStatusBadge status="ACTIVO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVO').className).toContain('bg-blue-yonder');
  });
});

describe('VacancyStatusBadge — ACTIVE (alias)', () => {
  it('maps ACTIVE to ACTIVO label', () => {
    render(<VacancyStatusBadge status="ACTIVE" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ACTIVO')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — REEMPLAZOS', () => {
  it('renders with wait background', () => {
    render(<VacancyStatusBadge status="REEMPLAZOS" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.REEMPLAZOS').className).toContain('bg-wait');
  });
});

describe('VacancyStatusBadge — REEMPLAZO (alias)', () => {
  it('maps REEMPLAZO to REEMPLAZOS label', () => {
    render(<VacancyStatusBadge status="REEMPLAZO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.REEMPLAZOS')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — CERRADO', () => {
  it('has bg-gray-800 class', () => {
    render(<VacancyStatusBadge status="CERRADO" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.CERRADO').className).toContain('bg-gray-800');
  });
});

describe('VacancyStatusBadge — CLOSED (alias)', () => {
  it('maps CLOSED to CERRADO label', () => {
    render(<VacancyStatusBadge status="CLOSED" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.CERRADO')).toBeInTheDocument();
  });
});

describe('VacancyStatusBadge — ADMISSION', () => {
  it('has bg-cyan-focus class', () => {
    render(<VacancyStatusBadge status="ADMISSION" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.ADMISSION').className).toContain('bg-cyan-focus');
  });
});

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
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA').tagName).toBe('SPAN');
  });

  it('has font-poppins class', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA').className).toContain('font-poppins');
  });

  it('has text-white class', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA').className).toContain('text-white');
  });

  it('applies extra className prop', () => {
    render(<VacancyStatusBadge status="BUSQUEDA" className="extra-class" />);
    expect(screen.getByText('admin.vacancyDetail.statusBadge.BUSQUEDA').className).toContain('extra-class');
  });
});
