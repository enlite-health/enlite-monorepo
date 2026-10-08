/**
 * VacanciesTable.visual.test.tsx
 *
 * Testes visuais/estruturais que GARANTEM:
 * - Ícone Eye é do lucide-react (SVG), não uma <img> externa
 * - Colunas numéricas (invited/applicants/selected/missing) são ocultas em mobile
 * - min-width da tabela é 500px (não 900px)
 * - Colunas essenciais (caso, status, última ação) sempre visíveis; localizadas por data-testid, nunca por posição
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';

const MOCK_VACANCIES: VacancyRow[] = [
  {
    id: '1',
    caseNumber: 100, caseOrdinal: 1,
    status: 'Activo',
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

const ESSENTIAL_KEYS = ['case', 'status', 'last-action'];
const RESPONSIVE_KEYS = [
  'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'COMPLETED',
  'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED', 'applicants', 'missing',
];

function headerByKey(container: HTMLElement, key: string): HTMLElement {
  const th = container.querySelector<HTMLElement>(`[data-testid="vacancies-col-${key}"]`);
  expect(th).toBeTruthy();
  return th!;
}

function cellByKey(container: HTMLElement, rowId: string, key: string): HTMLElement {
  const th = headerByKey(container, key);
  const headers = Array.from(container.querySelectorAll('thead th'));
  const cells = container.querySelectorAll(`[data-testid="vacancy-row-${rowId}"] td`);
  const cell = cells[headers.indexOf(th)] as HTMLElement | undefined;
  expect(cell).toBeTruthy();
  return cell!;
}

describe('VacanciesTable — responsive columns', () => {
  it('CRITICAL: numeric columns (as 8 do funil sem Confirmados + applicants + missing) have hidden md:table-cell', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);
    for (const key of RESPONSIVE_KEYS) {
      const cell = cellByKey(container, '1', key);
      expect(cell.className).toContain('hidden');
      expect(cell.className).toContain('md:table-cell');
    }
  });

  it('CRITICAL: essential columns (olho, caso, status, última ação) are always visible', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);
    const eye = container.querySelector(`[data-testid="vacancy-row-1"] td`) as HTMLElement;
    expect(eye.className).not.toContain('hidden');
    for (const key of ESSENTIAL_KEYS) {
      expect(cellByKey(container, '1', key).className).not.toContain('hidden');
    }
  });

  it('table headers also have responsive hidden classes', () => {
    const { container } = render(<VacanciesTable vacancies={MOCK_VACANCIES} />);
    for (const key of RESPONSIVE_KEYS) {
      const th = headerByKey(container, key);
      expect(th.className).toContain('hidden');
      expect(th.className).toContain('md:table-cell');
    }
    for (const key of ESSENTIAL_KEYS) {
      expect(headerByKey(container, key).className).not.toContain('hidden');
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
    // eye + case/status + última ação + 8 colunas do funil (sem CONFIRMED) + applicants/missing = 14
    // e igual ao número real de <th> (a soma deixa de ser literal).
    expect(colspan).toBe(14);
    expect(colspan).toBe(container.querySelectorAll('thead th').length);
  });
});
