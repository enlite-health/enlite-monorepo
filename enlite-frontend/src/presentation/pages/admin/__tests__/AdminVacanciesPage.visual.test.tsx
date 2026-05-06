/**
 * AdminVacanciesPage.visual.test.tsx
 *
 * Testes visuais e estruturais que GARANTEM:
 * - Layout responsivo (mesma estrutura que AdminWorkersPage)
 * - Paginação funcional com botões reais (não imagem estática)
 * - Filtros não duplicam opções
 * - Container/borders corretos
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminVacanciesPage } from '../AdminVacanciesPage';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@hooks/admin/useVacanciesData', () => ({
  useVacanciesData: () => ({
    vacancies: [
      {
        id: '1',
        caso: 'Caso 100',
        status: 'Activo',
        grauColor: 'text-[#f9a000]',
        convidados: '10',
        postulados: '5',
        providers_needed: 3,
        faltantes: '2',
      },
      {
        id: '2',
        caso: 'Caso 200',
        status: 'Pausado',
        grauColor: 'text-[#81c784]',
        convidados: '20',
        postulados: '8',
        providers_needed: 1,
        faltantes: '0',
      },
    ],
    stats: [
      { label: '+7 días', value: '2', icon: 'clock' },
      { label: '+24 días', value: '5', icon: 'clock' },
      { label: 'En selección', value: '10', icon: 'user-check' },
    ],
    total: 25,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@presentation/components/features/admin/VacancyFormModal', () => ({
  VacancyFormModal: () => null,
}));

vi.mock('@presentation/components/features/admin/VacancyModal/VacancyModal', () => ({
  VacancyModal: () => null,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminVacanciesPage />
    </MemoryRouter>,
  );
}

// In test env, t() returns the raw key. So aria-labels are the i18n keys.
const PREV_LABEL = /previousPage/i;
const NEXT_LABEL = /nextPage/i;

// ── GARANTIA 1: Layout responsivo ─────────────────────────────────────────

describe('AdminVacanciesPage — responsive layout', () => {
  it('CRITICAL: container uses PageContainer atom with responsive padding', () => {
    const { container } = renderPage();
    const outer = container.firstElementChild as HTMLElement;
    const inner = outer.firstElementChild as HTMLElement;

    expect(outer.className).toContain('min-h-screen');
    expect(outer.className).toContain('bg-background');
    expect(inner.className).toContain('max-w-[1600px]');
    expect(inner.className).toContain('mx-auto');
    expect(inner.className).toContain('px-4');
    expect(inner.className).toContain('sm:px-6');
    expect(inner.className).toContain('md:px-8');
    expect(inner.className).toContain('lg:px-12');
  });

  it('CRITICAL: pagination select has responsive width', () => {
    const { container } = renderPage();
    const paginationArea = container.querySelector('.flex.flex-wrap.items-center.justify-end');
    expect(paginationArea).toBeTruthy();

    const selectWrapper = paginationArea!.querySelector('div');
    expect(selectWrapper?.className).toContain('sm:w-[164px]');
    expect(selectWrapper?.className).toContain('w-full');
  });
});

// ── GARANTIA 2: Paginação funcional ───────────────────────────────────────

describe('AdminVacanciesPage — functional pagination', () => {
  it('CRITICAL: pagination has real buttons, not static images', () => {
    renderPage();

    const prevButton = screen.getByRole('button', { name: PREV_LABEL });
    const nextButton = screen.getByRole('button', { name: NEXT_LABEL });

    expect(prevButton).toBeInTheDocument();
    expect(nextButton).toBeInTheDocument();
    expect(prevButton.tagName).toBe('BUTTON');
    expect(nextButton.tagName).toBe('BUTTON');
  });

  it('CRITICAL: no static pagination arrow images exist', () => {
    const { container } = renderPage();

    const arrowImages = container.querySelectorAll('img[alt*="Pagination"]');
    expect(arrowImages).toHaveLength(0);
    const arrowSvgImages = container.querySelectorAll('img[src*="setas"]');
    expect(arrowSvgImages).toHaveLength(0);
  });

  it('previous button is disabled on first page', () => {
    renderPage();

    const prevButton = screen.getByRole('button', { name: PREV_LABEL });
    expect(prevButton).toBeDisabled();
  });

  it('next button is enabled when there are more pages', () => {
    renderPage();

    // total=25, itemsPerPage=20 → 2 pages, on page 1 → next enabled
    const nextButton = screen.getByRole('button', { name: NEXT_LABEL });
    expect(nextButton).toBeEnabled();
  });

  it('clicking next enables previous button', async () => {
    renderPage();

    const nextButton = screen.getByRole('button', { name: NEXT_LABEL });
    await userEvent.click(nextButton);

    const prevButton = screen.getByRole('button', { name: PREV_LABEL });
    expect(prevButton).toBeEnabled();
  });

  it('displays pagination text with numbers', () => {
    const { container } = renderPage();
    const textContent = container.textContent || '';

    // Should contain pagination info (format: "start–end de total" or i18n key with interpolation)
    expect(textContent).toMatch(/\d+.*\d+/);
  });
});

// ── GARANTIA 3: Sem filtros duplicados ────────────────────────────────────

describe('AdminVacanciesPage — no duplicate filter options', () => {
  it('CRITICAL: each select does NOT have duplicate placeholder/all options', () => {
    const { container } = renderPage();

    const selects = container.querySelectorAll('select');
    selects.forEach((select) => {
      const options = Array.from(select.options);
      const values = options.map((o) => o.value);
      const emptyValues = values.filter((v) => v === '');

      // SelectField adds ONE placeholder option with value="".
      // No additional empty-value options should exist from the data.
      expect(emptyValues.length).toBeLessThanOrEqual(1);
    });
  });
});

// ── GARANTIA 4: Seção container correto ───────────────────────────────────

describe('AdminVacanciesPage — section container structure', () => {
  it('CRITICAL: section header has border-2 border-b-0 (matching Workers)', () => {
    const { container } = renderPage();

    const sectionHeader = container.querySelector('.rounded-t-\\[20px\\]');
    expect(sectionHeader).toBeTruthy();
    expect(sectionHeader!.className).toContain('border-2');
    expect(sectionHeader!.className).toContain('border-b-0');
    expect(sectionHeader!.className).not.toContain('border-t-2');
    expect(sectionHeader!.className).not.toContain('border-b-[1.5px]');
  });

  it('table section uses flex-col without gap-7', () => {
    const { container } = renderPage();

    const flexCols = container.querySelectorAll('.flex.flex-col');
    flexCols.forEach((el) => {
      expect(el.className).not.toContain('gap-7');
    });
  });
});

// ── GARANTIA 5: Botão "Nueva" usa ícone lucide, não imagem ───────────────

describe('AdminVacanciesPage — icons', () => {
  it('CRITICAL: "New" button uses lucide Plus icon, not external image', () => {
    const { container } = renderPage();

    const buttonArea = container.querySelector('.rounded-t-\\[20px\\]');
    expect(buttonArea).toBeTruthy();

    const addImages = buttonArea!.querySelectorAll('img[alt="Add"]');
    expect(addImages).toHaveLength(0);

    // Deve ter um SVG do lucide (Plus)
    const svgs = buttonArea!.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── GARANTIA 6: Filtros resetam página ao mudar ──────────────────────────

describe('AdminVacanciesPage — filters reset pagination', () => {
  it('changing items per page resets to page 1 implicitly', async () => {
    renderPage();

    // Go to page 2 first
    const nextButton = screen.getByRole('button', { name: NEXT_LABEL });
    await userEvent.click(nextButton);

    // Previous should now be enabled (we're on page 2)
    const prevButton = screen.getByRole('button', { name: PREV_LABEL });
    expect(prevButton).toBeEnabled();

    // Change items per page — last select is the pagination one
    const selects = screen.getAllByRole('combobox');
    const itemsPerPageSelect = selects[selects.length - 1];
    await userEvent.selectOptions(itemsPerPageSelect, '50');

    // After changing items per page, we should be back on page 1
    // With 25 total and 50 per page, there's only 1 page → next disabled
    expect(screen.getByRole('button', { name: NEXT_LABEL })).toBeDisabled();
  });
});
