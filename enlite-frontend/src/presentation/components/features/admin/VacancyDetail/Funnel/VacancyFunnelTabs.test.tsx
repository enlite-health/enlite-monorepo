import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFunnelTabs } from './VacancyFunnelTabs';
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
};

describe('VacancyFunnelTabs', () => {
  it('renders all 5 tab buttons', () => {
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.invited/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.preSelected/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.rejected/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.withdrew/ })).toBeInTheDocument();
  });

  it('active tab has bg-primary', () => {
    render(
      <VacancyFunnelTabs
        activeBucket="POSTULATED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={vi.fn()}
      />,
    );
    const postulatedTab = screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ });
    expect(postulatedTab).toHaveClass('bg-primary');
  });

  it('inactive tab does not have bg-primary', () => {
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={vi.fn()}
      />,
    );
    const postulatedTab = screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ });
    expect(postulatedTab).not.toHaveClass('bg-primary');
  });

  it('calls onBucketChange when tab is clicked', async () => {
    const onBucketChange = vi.fn();
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={onBucketChange}
        onDispatchInvites={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole('tab', { name: /admin.vacancyDetail.funnelTabs.postulated/ }),
    );
    expect(onBucketChange).toHaveBeenCalledWith('POSTULATED');
  });

  it('shows counts in tab labels', () => {
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={vi.fn()}
      />,
    );
    // Count 5 for INVITED
    expect(screen.getByText(/\(5\)/)).toBeInTheDocument();
  });

  it('renders dispatch invites button', () => {
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={vi.fn()}
      />,
    );
    expect(
      screen.getByText('admin.vacancyDetail.funnelView.dispatchInvitesButton'),
    ).toBeInTheDocument();
  });

  it('calls onDispatchInvites when dispatch button is clicked', async () => {
    const onDispatchInvites = vi.fn();
    render(
      <VacancyFunnelTabs
        activeBucket="INVITED"
        counts={mockCounts}
        onBucketChange={vi.fn()}
        onDispatchInvites={onDispatchInvites}
      />,
    );
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.funnelView.dispatchInvitesButton'),
    );
    expect(onDispatchInvites).toHaveBeenCalled();
  });
});
