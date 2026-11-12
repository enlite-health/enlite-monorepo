import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InviteProgressPanel } from '../InviteProgressPanel';
import { isInviteMatchRoute } from '../inviteMatchRoute';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <InviteProgressPanel />
    </MemoryRouter>,
  );

describe('InviteProgressPanel — rota (089 DF-18a)', () => {
  beforeEach(() => {
    useInviteProgressStore.setState({
      isOpen: true,
      isSending: true,
      collapsed: false,
      items: [{ vacancyId: 'v1', workerId: 'w1', workerName: 'Prestadora QA 01', status: 'sending' }],
    });
  });

  it('na página do match (/admin/vacancies/:id/match) o painel global não aparece', () => {
    renderAt('/admin/vacancies/abc-123/match?paso=5');
    expect(screen.queryByTestId('invite-progress-panel')).toBeNull();
  });

  it('em outra rota com envio em andamento o painel aparece', () => {
    renderAt('/admin/vacancies/abc-123');
    expect(screen.getByTestId('invite-progress-panel')).toBeTruthy();
  });

  it('isInviteMatchRoute só casa a rota do match', () => {
    expect(isInviteMatchRoute('/admin/vacancies/x/match')).toBe(true);
    expect(isInviteMatchRoute('/admin/vacancies/x/match/')).toBe(true);
    expect(isInviteMatchRoute('/admin/vacancies/x')).toBe(false);
    expect(isInviteMatchRoute('/admin/vacancies')).toBe(false);
  });
});
