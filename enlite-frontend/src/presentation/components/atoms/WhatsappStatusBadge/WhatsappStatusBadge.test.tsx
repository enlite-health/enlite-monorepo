import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WhatsappStatusBadge } from './WhatsappStatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('WhatsappStatusBadge', () => {
  it('renders NOT_SENT with cancelled bg', () => {
    render(<WhatsappStatusBadge status="NOT_SENT" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.notSent');
    expect(badge).toHaveClass('bg-cancelled');
  });

  it('renders null as NOT_SENT with cancelled bg', () => {
    render(<WhatsappStatusBadge status={null} />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.notSent');
    expect(badge).toHaveClass('bg-cancelled');
  });

  it('renders SENT with blue-yonder bg', () => {
    render(<WhatsappStatusBadge status="SENT" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.sent');
    expect(badge).toHaveClass('bg-blue-yonder');
  });

  it('renders DELIVERED with cyan-focus bg', () => {
    render(<WhatsappStatusBadge status="DELIVERED" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.delivered');
    expect(badge).toHaveClass('bg-cyan-focus');
  });

  it('renders READ with new-car bg', () => {
    render(<WhatsappStatusBadge status="READ" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.read');
    expect(badge).toHaveClass('bg-new-car');
  });

  it('renders REPLIED with turquoise bg', () => {
    render(<WhatsappStatusBadge status="REPLIED" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.replied');
    expect(badge).toHaveClass('bg-turquoise');
  });

  it('renders FAILED with cancelled bg', () => {
    render(<WhatsappStatusBadge status="FAILED" />);
    const badge = screen.getByText('admin.vacancyDetail.whatsappStatus.failed');
    expect(badge).toHaveClass('bg-cancelled');
  });
});
