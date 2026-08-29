import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCard } from '../KanbanCard';

// ── i18n mock — always returns key so we can assert exact i18n paths ─────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── Text atom mock ───────────────────────────────────────────────────────────
vi.mock('@presentation/components/atoms/Text', () => ({
  Text: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <span {...props}>{children}</span>
  ),
}));

// ── lucide-react mock ────────────────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  CalendarClock: (props: Record<string, unknown>) => <svg data-testid="icon-calendar-clock" {...props} />,
  MapPin: (props: Record<string, unknown>) => <svg data-testid="icon-map-pin" {...props} />,
  MessageSquare: (props: Record<string, unknown>) => <svg data-testid="icon-message-square" {...props} />,
  Send: (props: Record<string, unknown>) => <svg data-testid="icon-send" {...props} />,
  Phone: (props: Record<string, unknown>) => <svg data-testid="icon-phone" {...props} />,
  Star: (props: Record<string, unknown>) => <svg data-testid="icon-star" {...props} />,
  Hand: (props: Record<string, unknown>) => <svg data-testid="icon-hand" {...props} />,
}));

// ── Default props ────────────────────────────────────────────────────────────

const defaultProps = {
  id: 'enc-1',
  workerId: null as string | null,
  workerName: 'Ana Martínez',
  workerPhone: '5491155551234',
  occupation: 'Acompañante Terapéutico',
  workZone: 'Palermo',
  matchScore: 92,
  talentumStatus: null as string | null,
  rejectionReasonCategory: null as string | null,
  interviewDate: null as string | null,
  interviewTime: null as string | null,
  stage: 'COMPLETED',
};

// ── Visual Rendering ─────────────────────────────────────────────────────────

describe('KanbanCard — visual rendering', () => {
  it('renders worker name', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.getByText('Ana Martínez')).toBeInTheDocument();
  });

  it('renders i18n fallback key when worker name is null', () => {
    render(<KanbanCard {...defaultProps} workerName={null} />);
    // i18n mock returns the key: admin.kanban.noName
    expect(screen.getByText('admin.kanban.noName')).toBeInTheDocument();
  });

  it('renders match score with star icon', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.getByTestId('icon-star')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
  });

  it('does not render match score when null', () => {
    render(<KanbanCard {...defaultProps} matchScore={null} />);
    expect(screen.queryByTestId('icon-star')).not.toBeInTheDocument();
  });

  it('renders occupation badge', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.getByText('Acompañante Terapéutico')).toBeInTheDocument();
  });

  it('does not render occupation when null', () => {
    render(<KanbanCard {...defaultProps} occupation={null} />);
    expect(screen.queryByText('Acompañante Terapéutico')).not.toBeInTheDocument();
  });

  it('renders formatted phone number with icon', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.getByTestId('icon-phone')).toBeInTheDocument();
    // formatPhoneDisplay('5491155551234') → '+54 9 11 5555-1234'
    expect(screen.getByText('+54 9 11 5555-1234')).toBeInTheDocument();
  });

  it('does not render phone when null', () => {
    render(<KanbanCard {...defaultProps} workerPhone={null} />);
    expect(screen.queryByTestId('icon-phone')).not.toBeInTheDocument();
  });

  it('renders work zone with map pin icon', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.getByTestId('icon-map-pin')).toBeInTheDocument();
    expect(screen.getByText('Palermo')).toBeInTheDocument();
  });

  it('does not render work zone when null', () => {
    render(<KanbanCard {...defaultProps} workZone={null} />);
    expect(screen.queryByTestId('icon-map-pin')).not.toBeInTheDocument();
  });

  it('renders interview date formatted as es-AR locale', () => {
    render(<KanbanCard {...defaultProps} interviewDate="2026-03-15T12:00:00" />);
    // es-AR format: d/m/yyyy — using midday to avoid timezone shifts
    expect(screen.getByText(/15\/3\/2026/)).toBeInTheDocument();
  });

  it('renders interview date with time when provided', () => {
    render(<KanbanCard {...defaultProps} interviewDate="2026-03-15T12:00:00" interviewTime="10:30" />);
    expect(screen.getByText(/15\/3\/2026.*10:30/)).toBeInTheDocument();
  });

  it('does not render interview date when null', () => {
    render(<KanbanCard {...defaultProps} interviewDate={null} />);
    expect(screen.queryByText(/\/.*\//)).not.toBeInTheDocument();
  });
});

// ── Talentum Status Badges ───────────────────────────────────────────────────

describe('KanbanCard — talentum status badges', () => {
  it('renders talentum badge when talentumStatus is provided', () => {
    render(<KanbanCard {...defaultProps} talentumStatus="INITIATED" />);
    expect(screen.getByTestId('talentum-badge')).toBeInTheDocument();
  });

  it('does not render talentum badge when talentumStatus is null', () => {
    render(<KanbanCard {...defaultProps} talentumStatus={null} />);
    expect(screen.queryByTestId('talentum-badge')).not.toBeInTheDocument();
  });

  it.each([
    ['INITIATED', 'admin.kanban.talentumStatus.INITIATED'],
    ['IN_PROGRESS', 'admin.kanban.talentumStatus.IN_PROGRESS'],
    ['COMPLETED', 'admin.kanban.talentumStatus.COMPLETED'],
    ['QUALIFIED', 'admin.kanban.talentumStatus.QUALIFIED'],
    ['IN_DOUBT', 'admin.kanban.talentumStatus.IN_DOUBT'],
    ['NOT_QUALIFIED', 'admin.kanban.talentumStatus.NOT_QUALIFIED'],
  ])('renders correct i18n key for %s status', (status, expectedKey) => {
    render(<KanbanCard {...defaultProps} talentumStatus={status} />);
    const badge = screen.getByTestId('talentum-badge');
    expect(badge).toHaveTextContent(expectedKey);
  });

  it.each([
    ['INITIATED', 'bg-slate-100'],
    ['IN_PROGRESS', 'bg-amber-50'],
    ['COMPLETED', 'bg-blue-50'],
    ['QUALIFIED', 'bg-green-50'],
    ['IN_DOUBT', 'bg-orange-50'],
    ['NOT_QUALIFIED', 'bg-red-50'],
  ])('applies correct CSS class for %s status badge', (status, expectedBg) => {
    render(<KanbanCard {...defaultProps} talentumStatus={status} />);
    const badge = screen.getByTestId('talentum-badge');
    expect(badge.className).toContain(expectedBg);
  });

  it('does not render badge for unknown talentum status', () => {
    render(<KanbanCard {...defaultProps} talentumStatus="UNKNOWN_STATUS" />);
    expect(screen.queryByTestId('talentum-badge')).not.toBeInTheDocument();
  });
});

// ── Rejection Reason Badges ──────────────────────────────────────────────────

describe('KanbanCard — rejection reason badges', () => {
  it('renders rejection badge when category is provided', () => {
    render(<KanbanCard {...defaultProps} rejectionReasonCategory="DISTANCE" />);
    expect(screen.getByTestId('rejection-badge')).toBeInTheDocument();
  });

  it('does not render rejection badge when category is null', () => {
    render(<KanbanCard {...defaultProps} rejectionReasonCategory={null} />);
    expect(screen.queryByTestId('rejection-badge')).not.toBeInTheDocument();
  });

  it('uses i18n key for rejection categories', () => {
    render(<KanbanCard {...defaultProps} rejectionReasonCategory="TALENTUM_NOT_QUALIFIED" />);
    const badge = screen.getByTestId('rejection-badge');
    expect(badge).toHaveTextContent('admin.kanban.rejectionLabels.TALENTUM_NOT_QUALIFIED');
  });

  it('uses i18n key pattern for any rejection category', () => {
    render(<KanbanCard {...defaultProps} rejectionReasonCategory="DISTANCE" />);
    const badge = screen.getByTestId('rejection-badge');
    expect(badge).toHaveTextContent('admin.kanban.rejectionLabels.DISTANCE');
  });
});

// ── Combined Scenarios ───────────────────────────────────────────────────────

describe('KanbanCard — combined scenarios', () => {
  it('renders card with talentum badge AND rejection reason simultaneously', () => {
    render(
      <KanbanCard
        {...defaultProps}
        talentumStatus="NOT_QUALIFIED"
        rejectionReasonCategory="TALENTUM_NOT_QUALIFIED"
      />,
    );
    expect(screen.getByTestId('talentum-badge')).toBeInTheDocument();
    expect(screen.getByTestId('rejection-badge')).toBeInTheDocument();
  });

  it('renders minimal card with all optional fields null', () => {
    render(
      <KanbanCard
        id="minimal"
        workerId={null}
        workerName={null}
        workerPhone={null}
        occupation={null}
        workZone={null}
        matchScore={null}
        talentumStatus={null}
        rejectionReasonCategory={null}
        interviewDate={null}
        interviewTime={null}
        stage="INVITED"
      />,
    );
    // Should still render with fallback name
    expect(screen.getByText('admin.kanban.noName')).toBeInTheDocument();
    // No optional elements
    expect(screen.queryByTestId('icon-phone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icon-map-pin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icon-star')).not.toBeInTheDocument();
    expect(screen.queryByTestId('talentum-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rejection-badge')).not.toBeInTheDocument();
  });
});

// ── Blocked Badge (INICIADO column) ──────────────────────────────────────────

describe('KanbanCard — blocked badge', () => {
  it('renders blocked section when isBlocked is true', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="INICIADO"
        isBlocked={true}
        blockedReason="registration_incomplete"
        missingFields={['phone', 'profession']}
        attemptCount={2}
      />,
    );
    expect(screen.getByTestId('blocked-section')).toBeInTheDocument();
  });

  it('renders BLOQUEADO badge with correct i18n key', () => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} />,
    );
    const badge = screen.getByTestId('blocked-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('admin.kanban.blockedBadge');
  });

  it('does NOT render blocked section when isBlocked is false', () => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={false} />,
    );
    expect(screen.queryByTestId('blocked-section')).not.toBeInTheDocument();
  });

  it('does NOT render blocked section when isBlocked is undefined', () => {
    render(<KanbanCard {...defaultProps} stage="INICIADO" />);
    expect(screen.queryByTestId('blocked-section')).not.toBeInTheDocument();
  });

  it('renders blockedReason via i18n key from admin.blockedAttempts.reason', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="INICIADO"
        isBlocked={true}
        blockedReason="registration_incomplete"
      />,
    );
    const reason = screen.getByTestId('blocked-reason');
    expect(reason).toHaveTextContent('admin.blockedAttempts.reason.registration_incomplete');
  });

  it.each([
    'worker_not_found',
    'registration_incomplete',
    'worker_disabled',
  ])('renders i18n key for blockedReason=%s', (reason) => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} blockedReason={reason} />,
    );
    expect(screen.getByTestId('blocked-reason')).toHaveTextContent(
      `admin.blockedAttempts.reason.${reason}`,
    );
  });

  it('renders missingFields as individual badges', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="INICIADO"
        isBlocked={true}
        missingFields={['phone', 'profession']}
      />,
    );
    const container = screen.getByTestId('blocked-missing-fields');
    expect(container).toBeInTheDocument();
    // Each field should be rendered as a badge using admin.blockedAttempts.missingField.*
    expect(container).toHaveTextContent('admin.blockedAttempts.missingField.phone');
    expect(container).toHaveTextContent('admin.blockedAttempts.missingField.profession');
  });

  it('does NOT render missingFields section when array is empty', () => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} missingFields={[]} />,
    );
    expect(screen.queryByTestId('blocked-missing-fields')).not.toBeInTheDocument();
  });

  it('renders attemptCount with correct i18n key', () => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} attemptCount={3} />,
    );
    expect(screen.getByTestId('blocked-attempt-count')).toBeInTheDocument();
  });

  it('does NOT render attemptCount when zero', () => {
    render(
      <KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} attemptCount={0} />,
    );
    expect(screen.queryByTestId('blocked-attempt-count')).not.toBeInTheDocument();
  });

  it('applies red-100 background to blocked badge', () => {
    render(<KanbanCard {...defaultProps} stage="INICIADO" isBlocked={true} />);
    const badge = screen.getByTestId('blocked-badge');
    expect(badge.className).toContain('bg-red-100');
    expect(badge.className).toContain('text-red-700');
  });

  it('renders the blocked-specific "no name" i18n key when isBlocked and workerName is null (worker_not_found)', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="BLOQUEADO"
        workerName={null}
        isBlocked={true}
        blockedReason="worker_not_found"
      />,
    );
    expect(screen.getByText('admin.kanban.blockedNoName')).toBeInTheDocument();
    expect(screen.queryByText('admin.kanban.noName')).not.toBeInTheDocument();
  });

  it('still renders the generic "no name" i18n key when NOT blocked and workerName is null', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" workerName={null} isBlocked={false} />);
    expect(screen.getByText('admin.kanban.noName')).toBeInTheDocument();
  });

  it('renders the worker name as a link to the profile (new tab) even when isBlocked, when workerId is present', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="BLOQUEADO"
        isBlocked={true}
        workerId="worker-blocked-1"
        workerName="Lucía Fernández"
      />,
    );
    const link = screen.getByRole('link', { name: 'Lucía Fernández' });
    expect(link).toHaveAttribute('href', '/admin/workers/worker-blocked-1');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the notes button in a blocked card when onOpenNotes is provided (contact notes are keyed by worker, not WJA)', () => {
    const onOpenNotes = vi.fn();
    render(
      <KanbanCard
        {...defaultProps}
        stage="BLOQUEADO"
        isBlocked={true}
        workerId="worker-blocked-1"
        onOpenNotes={onOpenNotes}
        contactNotesCount={2}
      />,
    );
    expect(screen.getByTestId('notes-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notes-button'));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });
});

// ── Clickable Worker Name ───────────────────────────────────────────────────

describe('KanbanCard — worker name opens the profile in a NEW TAB', () => {
  it('renders the name as a real link to /admin/workers/:id when workerId is provided', () => {
    render(<KanbanCard {...defaultProps} workerId="worker-42" />);
    const link = screen.getByRole('link', { name: 'Ana Martínez' });
    expect(link).toHaveAttribute('href', '/admin/workers/worker-42');
  });

  it('opens in a new tab safely (target=_blank + rel=noopener noreferrer)', () => {
    render(<KanbanCard {...defaultProps} workerId="worker-42" />);
    const link = screen.getByRole('link', { name: 'Ana Martínez' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does NOT render a link when workerId is null — name stays plain text', () => {
    render(<KanbanCard {...defaultProps} workerId={null} />);
    expect(screen.queryByRole('link', { name: 'Ana Martínez' })).not.toBeInTheDocument();
    expect(screen.getByText('Ana Martínez')).toBeInTheDocument();
  });

  it('does not let the click bubble to the draggable card', () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <KanbanCard {...defaultProps} workerId="worker-42" />
      </div>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Ana Martínez' }));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('applies hover:underline class to the linked name', () => {
    render(<KanbanCard {...defaultProps} workerId="worker-42" />);
    const nameSpan = screen.getByText('Ana Martínez');
    expect(nameSpan.className).toContain('hover:underline');
  });
});

// ── Phone Formatting ────────────────────────────────────────────────────────

describe('KanbanCard — phone formatting by country', () => {
  it('formats Argentine phone (13 digits, starts with 54)', () => {
    render(<KanbanCard {...defaultProps} workerPhone="5491155551234" />);
    expect(screen.getByText('+54 9 11 5555-1234')).toBeInTheDocument();
  });

  it('formats Brazilian phone (13 digits, starts with 55)', () => {
    render(<KanbanCard {...defaultProps} workerPhone="5511999991234" />);
    expect(screen.getByText('+55 (11) 99999-1234')).toBeInTheDocument();
  });

  it('formats generic international phone (8+ digits)', () => {
    render(<KanbanCard {...defaultProps} workerPhone="34612345678" />);
    expect(screen.getByText('+34612345678')).toBeInTheDocument();
  });

  it('strips non-digit characters before formatting', () => {
    render(<KanbanCard {...defaultProps} workerPhone="+54-911-5555-1234" />);
    expect(screen.getByText('+54 9 11 5555-1234')).toBeInTheDocument();
  });

  it('returns raw value for short numbers (< 8 digits)', () => {
    render(<KanbanCard {...defaultProps} workerPhone="12345" />);
    expect(screen.getByText('12345')).toBeInTheDocument();
  });
});

// ── Acquisition Channel Badge ───────────────────────────────────────────────

describe('KanbanCard — acquisition channel badge', () => {
  it('renders channel badge when acquisitionChannel is provided', () => {
    render(<KanbanCard {...defaultProps} acquisitionChannel="facebook" />);
    expect(screen.getByTestId('acquisition-channel-badge')).toBeInTheDocument();
  });

  it('does not render channel badge when acquisitionChannel is null', () => {
    render(<KanbanCard {...defaultProps} acquisitionChannel={null} />);
    expect(screen.queryByTestId('acquisition-channel-badge')).not.toBeInTheDocument();
  });

  it('does not render channel badge when acquisitionChannel is undefined', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.queryByTestId('acquisition-channel-badge')).not.toBeInTheDocument();
  });

  it.each([
    ['facebook', 'admin.kanban.acquisitionChannel.facebook', 'bg-blue-100', 'text-blue-700'],
    ['instagram', 'admin.kanban.acquisitionChannel.instagram', 'bg-pink-100', 'text-pink-700'],
    ['whatsapp', 'admin.kanban.acquisitionChannel.whatsapp', 'bg-green-100', 'text-green-700'],
    ['linkedin', 'admin.kanban.acquisitionChannel.linkedin', 'bg-sky-100', 'text-sky-700'],
    ['site', 'admin.kanban.acquisitionChannel.site', 'bg-slate-200', 'text-slate-700'],
  ])('renders correct i18n key and styling for %s channel', (channel, expectedKey, expectedBg, expectedText) => {
    render(<KanbanCard {...defaultProps} acquisitionChannel={channel} />);
    const badge = screen.getByTestId('acquisition-channel-badge');
    expect(badge).toHaveTextContent(expectedKey);
    expect(badge.className).toContain(expectedBg);
    expect(badge.className).toContain(expectedText);
  });

  it('does not render badge for unknown channel value', () => {
    render(<KanbanCard {...defaultProps} acquisitionChannel="tiktok" />);
    expect(screen.queryByTestId('acquisition-channel-badge')).not.toBeInTheDocument();
  });
});

// ── Completado Badge (COMPLETED stage internalStage) ────────────────────────

describe('KanbanCard — completado badge', () => {
  it('renders completado badge when stage is COMPLETED and internalStage is QUALIFIED', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" internalStage="QUALIFIED" />);
    const badge = screen.getByTestId('completado-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('admin.kanban.completadoBadge.QUALIFIED');
    expect(badge.className).toContain('bg-green-50');
    expect(badge.className).toContain('text-green-700');
  });

  it('renders completado badge when stage is COMPLETED and internalStage is IN_DOUBT', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" internalStage="IN_DOUBT" />);
    const badge = screen.getByTestId('completado-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('admin.kanban.completadoBadge.IN_DOUBT');
    expect(badge.className).toContain('bg-orange-50');
    expect(badge.className).toContain('text-orange-700');
  });

  it('renders completado badge when stage is COMPLETED and internalStage is COMPLETED', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" internalStage="COMPLETED" />);
    const badge = screen.getByTestId('completado-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('admin.kanban.completadoBadge.COMPLETED');
    expect(badge.className).toContain('bg-blue-50');
    expect(badge.className).toContain('text-blue-700');
  });

  it('does NOT render completado badge when stage is COMPLETED but internalStage is null', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" internalStage={null} />);
    expect(screen.queryByTestId('completado-badge')).not.toBeInTheDocument();
  });

  it('does NOT render completado badge when stage is not COMPLETED', () => {
    render(<KanbanCard {...defaultProps} stage="CONFIRMED" internalStage="QUALIFIED" />);
    expect(screen.queryByTestId('completado-badge')).not.toBeInTheDocument();
  });

  it('does NOT render completado badge for unknown internalStage value', () => {
    render(<KanbanCard {...defaultProps} stage="COMPLETED" internalStage="UNKNOWN" />);
    expect(screen.queryByTestId('completado-badge')).not.toBeInTheDocument();
  });
});

// ── Reject Button ────────────────────────────────────────────────────────────

describe('KanbanCard — reject button', () => {
  it('renders reject button when onReject is provided and stage is not REJECTED', () => {
    const onReject = vi.fn();
    render(<KanbanCard {...defaultProps} stage="INVITED" onReject={onReject} />);
    expect(screen.getByTestId('reject-button')).toBeInTheDocument();
    expect(screen.getByTestId('reject-button')).toHaveTextContent('admin.kanban.rejectButton');
  });

  it('does NOT render reject button when stage is REJECTED', () => {
    const onReject = vi.fn();
    render(<KanbanCard {...defaultProps} stage="REJECTED" onReject={onReject} />);
    expect(screen.queryByTestId('reject-button')).not.toBeInTheDocument();
  });

  it('does NOT render reject button when onReject is undefined', () => {
    render(<KanbanCard {...defaultProps} stage="INVITED" />);
    expect(screen.queryByTestId('reject-button')).not.toBeInTheDocument();
  });

  it('calls onReject when reject button is clicked', () => {
    const onReject = vi.fn();
    render(<KanbanCard {...defaultProps} stage="CONFIRMED" onReject={onReject} />);
    fireEvent.click(screen.getByTestId('reject-button'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it.each(['INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'CONFIRMED', 'SELECTED'])(
    'renders reject button in %s stage when onReject is provided',
    (stage) => {
      const onReject = vi.fn();
      render(<KanbanCard {...defaultProps} stage={stage} onReject={onReject} />);
      expect(screen.getByTestId('reject-button')).toBeInTheDocument();
    },
  );
});

// ── Notes Button (contact notes / comentários) ──────────────────────────────

describe('KanbanCard — notes button', () => {
  it('renders notes button when onOpenNotes is provided', () => {
    const onOpenNotes = vi.fn();
    render(<KanbanCard {...defaultProps} onOpenNotes={onOpenNotes} />);
    expect(screen.getByTestId('notes-button')).toBeInTheDocument();
    expect(screen.getByTestId('notes-button')).toHaveTextContent('admin.kanban.notesButton');
  });

  it('does NOT render notes button when onOpenNotes is undefined', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.queryByTestId('notes-button')).not.toBeInTheDocument();
  });

  it('calls onOpenNotes when notes button is clicked', () => {
    const onOpenNotes = vi.fn();
    render(<KanbanCard {...defaultProps} onOpenNotes={onOpenNotes} />);
    fireEvent.click(screen.getByTestId('notes-button'));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });

  it('shows the count badge with contactNotesCount when > 0', () => {
    render(<KanbanCard {...defaultProps} onOpenNotes={vi.fn()} contactNotesCount={3} />);
    const badge = screen.getByTestId('notes-count-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('3');
  });

  it('does NOT show the count badge when contactNotesCount is 0', () => {
    render(<KanbanCard {...defaultProps} onOpenNotes={vi.fn()} contactNotesCount={0} />);
    expect(screen.queryByTestId('notes-count-badge')).not.toBeInTheDocument();
  });

  it('does NOT show the count badge when contactNotesCount is undefined', () => {
    render(<KanbanCard {...defaultProps} onOpenNotes={vi.fn()} />);
    expect(screen.queryByTestId('notes-count-badge')).not.toBeInTheDocument();
  });
});

// ── Interview Schedule Tag (CONFIRMED stage) ────────────────────────────────

describe('KanbanCard — interview schedule tag in CONFIRMED', () => {
  it('shows interview tag with CalendarClock icon when stage is CONFIRMED and interviewDate exists', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="CONFIRMED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime="10:30"
      />,
    );
    expect(screen.getByTestId('icon-calendar-clock')).toBeInTheDocument();
    // Should show short date + time
    expect(screen.getByText(/mar.*10:30/i)).toBeInTheDocument();
  });

  it('shows interview tag with date only when interviewTime is null', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="CONFIRMED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime={null}
      />,
    );
    expect(screen.getByTestId('icon-calendar-clock')).toBeInTheDocument();
    // Should show short date only (e.g. "15 mar")
    expect(screen.getByText(/15.*mar/i)).toBeInTheDocument();
  });

  it('does NOT show interview tag when stage is CONFIRMED but interviewDate is null', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="CONFIRMED"
        interviewDate={null}
        interviewTime={null}
      />,
    );
    expect(screen.queryByTestId('icon-calendar-clock')).not.toBeInTheDocument();
  });

  it('does NOT show interview tag when stage is COMPLETED (non-CONFIRMED)', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="COMPLETED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime="10:30"
      />,
    );
    expect(screen.queryByTestId('icon-calendar-clock')).not.toBeInTheDocument();
  });

  it.each(['INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'SELECTED', 'REJECTED'])(
    'does NOT show interview tag when stage is %s',
    (stage) => {
      render(
        <KanbanCard
          {...defaultProps}
          stage={stage}
          interviewDate="2026-03-15T12:00:00"
          interviewTime="10:30"
        />,
      );
      expect(screen.queryByTestId('icon-calendar-clock')).not.toBeInTheDocument();
    },
  );

  it('shows interview tag with cyan styling', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="CONFIRMED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime="10:30"
      />,
    );
    const tag = screen.getByTestId('icon-calendar-clock').closest('span')!;
    expect(tag.className).toContain('bg-cyan-50');
    expect(tag.className).toContain('text-cyan-700');
  });

  it('hides plain interview date text when stage is CONFIRMED (no duplication)', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="CONFIRMED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime="10:30"
      />,
    );
    // The full date format (d/m/yyyy) used in non-CONFIRMED should NOT appear
    expect(screen.queryByText(/15\/3\/2026/)).not.toBeInTheDocument();
  });

  it('shows plain interview date text in non-CONFIRMED stages', () => {
    render(
      <KanbanCard
        {...defaultProps}
        stage="COMPLETED"
        interviewDate="2026-03-15T12:00:00"
        interviewTime="10:30"
      />,
    );
    // Full date format should appear
    expect(screen.getByText(/15\/3\/2026.*10:30/)).toBeInTheDocument();
  });
});

// ── "Levantou a mão" (lead que se postulou sozinho) ─────────────────────────
describe('KanbanCard — selo de auto-postulação', () => {
  it('mostra o selo quando o próprio prestador entrou na vaga', () => {
    render(<KanbanCard {...defaultProps} selfAppliedAt="2026-08-07T13:51:19.923Z" />);
    expect(screen.getByTestId('self-applied-badge')).toHaveTextContent(
      'admin.kanban.selfApplied',
    );
  });

  it('sem carimbo NÃO mostra o selo — ausência não é prova de desinteresse', () => {
    render(<KanbanCard {...defaultProps} selfAppliedAt={null} />);
    expect(screen.queryByTestId('self-applied-badge')).toBeNull();
  });

  it('prop ausente (card antigo, anterior à autoria) também não mostra', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.queryByTestId('self-applied-badge')).toBeNull();
  });
});

// ── Reprogram badge (F7.b) ──────────────────────────────────────────────────

describe('KanbanCard — reprogram badge', () => {
  it('renders the badge when interviewResponse=awaiting_reschedule and there is no meet link', () => {
    render(<KanbanCard {...defaultProps} interviewResponse="awaiting_reschedule" meetLink={null} />);
    expect(screen.getByTestId('reprogram-badge')).toHaveTextContent('admin.kanban.reprogramBadge');
  });

  it('does NOT render the badge when a meet link already exists', () => {
    render(<KanbanCard {...defaultProps} interviewResponse="awaiting_reschedule" meetLink="https://meet.google.com/x" />);
    expect(screen.queryByTestId('reprogram-badge')).not.toBeInTheDocument();
  });
});

// ── "Reenviar" (REQ-08) ─────────────────────────────────────────────────────

describe('KanbanCard — botão Reenviar e último envio', () => {
  it('não renderiza a seção quando onResend não é passado', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" />);
    expect(screen.queryByTestId('resend-section')).not.toBeInTheDocument();
  });

  it('renderiza o botão e "sem envios" quando nunca houve envio', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} lastMessagedAt={null} />);
    expect(screen.getByTestId('resend-button')).toHaveTextContent('admin.kanban.resendButton');
    expect(screen.getByTestId('resend-last-sent')).toHaveTextContent('admin.kanban.neverSent');
  });

  // D200.1: dentro da janela o botão já vem desabilitado com o porquê — o 422 nunca acontece.
  it('resendBlockedReason desabilita o botão e mostra o motivo + quando a janela abre', () => {
    const onResend = vi.fn();
    render(
      <KanbanCard
        {...defaultProps}
        workerId="w-1"
        onResend={onResend}
        lastMessagedAt="2026-08-28T17:35:00.000Z"
        resendBlockedReason={{ code: 'RESEND_COOLDOWN', until: '2026-08-29T17:35:00.000Z' }}
      />,
    );
    const btn = screen.getByTestId('resend-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'admin.messaging.blocked.RESEND_COOLDOWN');
    const reason = screen.getByTestId('resend-blocked-reason');
    expect(reason).toHaveTextContent('admin.messaging.blocked.RESEND_COOLDOWN');
    expect(reason).toHaveTextContent('admin.kanban.resendBlockedUntil');
    // Sem clique possível: o handler NÃO é chamado.
    fireEvent.click(btn);
    expect(onResend).not.toHaveBeenCalled();
  });

  it('sem resendBlockedReason o botão fica habilitado e sem título', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} resendBlockedReason={null} />);
    const btn = screen.getByTestId('resend-button');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('title');
    expect(screen.queryByTestId('resend-blocked-reason')).not.toBeInTheDocument();
  });

  it('mostra a data/hora do último envio quando existe', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} lastMessagedAt="2026-08-28T17:35:00.000Z" />);
    expect(screen.getByTestId('resend-last-sent')).toHaveTextContent('admin.kanban.lastSentAt');
  });

  it('data inválida não quebra o card (mostra o valor cru)', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} lastMessagedAt="não-é-data" />);
    expect(screen.getByTestId('resend-last-sent')).toBeInTheDocument();
  });

  it('clicar chama onResend e não propaga o clique ao card (drag)', () => {
    const onResend = vi.fn();
    const onParent = vi.fn();
    render(
      <div onClick={onParent}>
        <KanbanCard {...defaultProps} workerId="w-1" onResend={onResend} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('resend-button'));
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
  });

  it('enquanto envia, o botão fica desabilitado com o rótulo de envio', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} resendStatus="sending" />);
    const btn = screen.getByTestId('resend-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('admin.kanban.resendSending');
  });

  it('mostra "enviado" após sucesso e o motivo (role=alert) após recusa', () => {
    const { rerender } = render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} resendStatus="sent" />);
    expect(screen.getByTestId('resend-feedback')).toHaveTextContent('admin.kanban.resendDone');
    rerender(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} resendStatus="error" resendMessage="Ya se le reenvió" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Ya se le reenvió');
  });

  it('erro sem mensagem não renderiza feedback', () => {
    render(<KanbanCard {...defaultProps} workerId="w-1" onResend={vi.fn()} resendStatus="error" resendMessage={null} />);
    expect(screen.queryByTestId('resend-feedback')).not.toBeInTheDocument();
  });
});


describe('KanbanCard — último envio por etapa (PEND-14 / DEC-12)', () => {
  it('sem lastStageMessage → nada renderizado', () => {
    render(<KanbanCard {...defaultProps} />);
    expect(screen.queryByTestId('stage-last-message')).toBeNull();
  });

  it('com lastStageMessage → "Mensaje de etapa" com a etapa e a data', () => {
    render(<KanbanCard {...defaultProps} lastStageMessage={{ stage: 'COMPLETED', templateSlug: 'x', at: '2026-08-29T12:00:00Z' }} />);
    const el = screen.getByTestId('stage-last-message');
    expect(el).toBeInTheDocument();
    expect(el.textContent).toContain('admin.kanban.stageLastMessage');
  });
});

describe('KanbanCard — desfazer descarte', () => {
  it('descartado com onUndismiss → botão aparece e chama o callback sem propagar o clique', () => {
    const onUndismiss = vi.fn();
    render(<KanbanCard {...defaultProps} isDismissed onUndismiss={onUndismiss} />);
    fireEvent.click(screen.getByTestId('undismiss-button'));
    expect(onUndismiss).toHaveBeenCalledTimes(1);
  });
});
