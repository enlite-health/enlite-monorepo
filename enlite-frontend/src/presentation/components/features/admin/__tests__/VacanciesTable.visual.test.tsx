/**
 * VacanciesTable.visual.test.tsx
 *
 * Testes visuais/estruturais que GARANTEM:
 * - Ícone Eye é do lucide-react (SVG), não uma <img> externa
 * - Colunas numéricas (invited/applicants/selected/missing) são ocultas em mobile
 * - min-width da tabela é 500px (não 900px)
 * - Colunas essenciais (caso, status, priority) sempre visíveis
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';

const MOCK_VACANCIES: VacancyRow[] = [
  {
    id: '1',
    caso: 'Caso 100',
    status: 'Activo',
    priority: 'HIGH',
    diasAberto: '05',
    stageCounts: {
      INVITED: 10,
      INICIADO: 1,
      PRE_SCREENING: 2,
      COMPLETED: 3,
      CONFIRMED: 4,
      SELECTED: 3,
      REJECTED: 0,
    },
    postulados: '5',
    faltantes: '2',
    isDraft: false,
    lastActionAt: '2026-09-20T14:30:00.000Z',
    daysWithoutDivulgation: 3,
  },
];

// ── GARANTIA 1: Eye icon é SVG lucide, não <img> ─────────────────────────

describe('VacanciesTable — Eye icon', () => {
  it('CRITICAL: uses SVG icon (lucide Eye), not external <img>', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);

    const eyeImages = container.querySelectorAll('img[alt="View"]');
    expect(eyeImages).toHaveLength(0);

    const eyeImgSrc = container.querySelectorAll('img[src*="eye"]');
    expect(eyeImgSrc).toHaveLength(0);

    const firstRow = container.querySelector('[class*="h-[72px]"]');
    expect(firstRow).toBeTruthy();

    const svgs = firstRow!.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('Eye icon has aria-label for accessibility', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);
    const svgWithLabel = container.querySelector('svg[aria-label]');
    expect(svgWithLabel).toBeTruthy();
  });
});

// ── GARANTIA 2: Colunas responsivas (hidden md:table-cell) ────────────────

describe('VacanciesTable — responsive columns', () => {
  it('CRITICAL: numeric columns (as 7 do funil + applicants + missing) have hidden md:table-cell', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);

    const row = container.querySelector('[class*="h-[72px]"]');
    expect(row).toBeTruthy();

    const cells = row!.querySelectorAll('td');
    // Cells: eye(0), caso(1), status(2), priority(3), última ação(4), dias(5),
    // 7 colunas do funil(6-12), postulados(13), faltantes(14) — DX-3.7.
    for (let i = 6; i <= 14; i++) {
      expect(cells[i].className).toContain('hidden');
      expect(cells[i].className).toContain('md:table-cell');
    }
  });

  it('CRITICAL: essential columns (caso, status, priority, última ação, dias) are always visible', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);

    const row = container.querySelector('[class*="h-[72px]"]');
    const cells = row!.querySelectorAll('td');

    // olho(0), caso(1), status(2), priority(3), última ação(4), dias(5) — DX-3.7:
    // as duas colunas novas ficam visíveis também abaixo de md.
    for (let i = 0; i <= 5; i++) {
      expect(cells[i].className).not.toContain('hidden');
    }
  });

  it('table headers also have responsive hidden classes', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);

    const headerCells = container.querySelectorAll('thead th');
    // Headers: empty(0), case(1), status(2), priority(3), última ação(4), dias(5),
    // 7 colunas do funil(6-12), applicants(13), missing(14) — DX-3.7.
    for (let i = 6; i <= 14; i++) {
      expect(headerCells[i].className).toContain('hidden');
      expect(headerCells[i].className).toContain('md:table-cell');
    }
  });
});

// ── GARANTIA 3: min-width correta ─────────────────────────────────────────

describe('VacanciesTable — min-width', () => {
  it('CRITICAL: table has min-w-[500px], not min-w-[900px]', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);

    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    expect(table!.className).toContain('min-w-[500px]');
    expect(table!.className).not.toContain('min-w-[900px]');
  });
});

// ── GARANTIA 4: colSpan dinâmico no empty state ───────────────────────────

describe('VacanciesTable — empty state colspan', () => {
  it('empty state cell spans all columns dynamically', () => {
    const { container } = render(<VacanciesTable vacancies={[]} />);

    const emptyCell = container.querySelector('td[colspan]');
    expect(emptyCell).toBeTruthy();

    const colspan = parseInt(emptyCell!.getAttribute('colspan') || '0');
    // 3 (case/status/priority) + 2 (última ação/dias) + 7 colunas do funil + 2 (applicants/missing) + 1 (eye) = 15
    expect(colspan).toBe(15);
  });
});
