import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InviteMergeNotice } from './InviteMergeNotice';
import { INVITE_MERGE_NOTICE_UNTIL } from './inviteMergeNoticeModel';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const BEFORE = new Date('2026-11-06T12:00:00');
const AFTER = new Date(`${INVITE_MERGE_NOTICE_UNTIL}T00:00:01`);
const NOTICE = 'invite-merge-notice';

function comUid(uid: string) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid, tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [], features: {}, enforcement: 'off' } as AuthzContract,
  });
}

beforeEach(() => {
  localStorage.clear();
  comUid('u1');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('InviteMergeNotice (089 T031 — ⚑1)', () => {
  it('antes da data-limite: mostra o aviso', () => {
    render(<InviteMergeNotice now={BEFORE} />);
    expect(screen.getByTestId(NOTICE)).toHaveTextContent('inviteEntry.mergeNotice');
  });

  it('a partir da data-limite: some sozinho', () => {
    render(<InviteMergeNotice now={AFTER} />);
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });

  it('fechar: some, persiste por pessoa e continua fechado ao remontar', async () => {
    const { unmount } = render(<InviteMergeNotice now={BEFORE} />);
    await userEvent.click(screen.getByRole('button', { name: 'admin.vacancyDetail.funnelView.inviteEntry.mergeNoticeClose' }));
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
    unmount();
    render(<InviteMergeNotice now={BEFORE} />);
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
    // outra pessoa no mesmo navegador ainda vê
    comUid('u2');
    render(<InviteMergeNotice now={BEFORE} />);
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
  });

  it('storage que lança (leitura e escrita): mostra, e fechar não quebra', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<InviteMergeNotice now={BEFORE} />);
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('invite-merge-notice-close'));
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });
});
