import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFunnelTabs } from './VacancyFunnelTabs';
import { FUNNEL_TABS } from './funnelTabsConfig';
import type { FunnelTableCounts } from '@domain/entities/Funnel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockCounts: FunnelTableCounts = {
  INVITED: 5,
  POSTULATED: 3,
  PRE_SELECTED: 2,
  REJECTED: 1,
  WITHDREW: 0,
  ALL: 11,
  columns: {},
};

describe('VacancyFunnelTabs', () => {
  it('renders all 11 tab buttons (Todos + 7 colunas + Postulados + Pre Seleccionados + Desistentes)', () => {
    render(
      <VacancyFunnelTabs
        activeTab="ALL"
        counts={mockCounts}
        onTabChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.all/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.INVITED/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.INICIADO/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.PRE_SCREENING/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.COMPLETED/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.CONFIRMED/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.SELECTED/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.kanban.columns.REJECTED/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.preSelected/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.withdrew/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(11);
  });

  it('active tab has bg-primary', () => {
    render(
      <VacancyFunnelTabs
        activeTab="POSTULATED"
        counts={mockCounts}
        onTabChange={vi.fn()}
      />,
    );
    const postulatedTab = screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ });
    expect(postulatedTab).toHaveClass('bg-primary');
  });

  it('inactive tab does not have bg-primary', () => {
    render(
      <VacancyFunnelTabs
        activeTab="ALL"
        counts={mockCounts}
        onTabChange={vi.fn()}
      />,
    );
    const postulatedTab = screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ });
    expect(postulatedTab).not.toHaveClass('bg-primary');
  });

  it('calls onTabChange with a aba POSTULATED quando clicada', async () => {
    const onTabChange = vi.fn();
    render(
      <VacancyFunnelTabs
        activeTab="ALL"
        counts={mockCounts}
        onTabChange={onTabChange}
      />,
    );
    await userEvent.click(
      screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ }),
    );
    const postulatedTab = FUNNEL_TABS.find((t) => t.key === 'POSTULATED');
    expect(onTabChange).toHaveBeenCalledWith(postulatedTab);
  });

  it('shows counts in tab labels (bucket)', () => {
    render(
      <VacancyFunnelTabs
        activeTab="ALL"
        counts={mockCounts}
        onTabChange={vi.fn()}
      />,
    );
    // Count 3 for POSTULATED (bucket)
    expect(screen.getByTestId('funnel-tab-POSTULATED-count')).toHaveTextContent('3');
  });

  it('soma columnCount de todos os sources da coluna (Pre Screening = PRE_SCREENING + IN_PROGRESS)', () => {
    const counts: FunnelTableCounts = {
      ...mockCounts,
      columns: { PRE_SCREENING: 1, IN_PROGRESS: 2 },
    };
    render(
      <VacancyFunnelTabs
        activeTab="ALL"
        counts={counts}
        onTabChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('funnel-tab-PRE_SCREENING-count')).toHaveTextContent('3');
  });
});
