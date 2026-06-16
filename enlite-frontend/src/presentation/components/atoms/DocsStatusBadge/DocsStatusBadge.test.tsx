import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocsStatusBadge } from './DocsStatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));

describe('DocsStatusBadge — null / empty status', () => {
  it('renders an em dash when status is null', () => {
    render(<DocsStatusBadge status={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an em dash when status is empty string', () => {
    render(<DocsStatusBadge status="" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('DocsStatusBadge — complete (green) statuses', () => {
  it('approved renders green pill', () => {
    render(<DocsStatusBadge status="approved" />);
    const label = screen.getByText('admin.workers.docsStatus.approved');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-green-100');
  });

  it('submitted renders green pill', () => {
    render(<DocsStatusBadge status="submitted" />);
    const label = screen.getByText('admin.workers.docsStatus.submitted');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-green-100');
  });

  it('under_review renders green pill', () => {
    render(<DocsStatusBadge status="under_review" />);
    const label = screen.getByText('admin.workers.docsStatus.under_review');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-green-100');
  });
});

describe('DocsStatusBadge — incomplete (red) statuses', () => {
  it('pending renders red pill', () => {
    render(<DocsStatusBadge status="pending" />);
    const label = screen.getByText('admin.workers.docsStatus.pending');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-red-100');
  });

  it('rejected renders red pill', () => {
    render(<DocsStatusBadge status="rejected" />);
    const label = screen.getByText('admin.workers.docsStatus.rejected');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-red-100');
  });

  it('incomplete renders red pill', () => {
    render(<DocsStatusBadge status="incomplete" />);
    const label = screen.getByText('admin.workers.docsStatus.incomplete');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-red-100');
  });
});

describe('DocsStatusBadge — explicit complete override (WorkersTable semantics)', () => {
  it('complete=true renders green pill with "complete" label regardless of status', () => {
    render(<DocsStatusBadge status="pending" complete />);
    const label = screen.getByText('admin.workers.docsStatus.complete');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-green-100');
  });

  it('complete=false forces red pill', () => {
    render(<DocsStatusBadge status="approved" complete={false} />);
    const label = screen.getByText('admin.workers.docsStatus.approved');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-red-100');
  });
});
