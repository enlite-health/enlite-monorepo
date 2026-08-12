/**
 * NewVersionBanner — testes unitários.
 *
 * Mocka `useAppVersionPolling` para isolar a renderização. Cobre:
 *   - não renderiza quando hook retorna false (default)
 *   - renderiza banner + botão de reload quando hook retorna true
 *   - botão dispara window.location.reload()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewVersionBanner } from '../NewVersionBanner';

const mockUseAppVersionPolling = vi.fn();

vi.mock('@hooks/useAppVersionPolling', () => ({
  useAppVersionPolling: () => mockUseAppVersionPolling(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

describe('NewVersionBanner', () => {
  beforeEach(() => {
    mockUseAppVersionPolling.mockReset();
  });

  it('does not render when there is no new version', () => {
    mockUseAppVersionPolling.mockReturnValue(false);
    render(<NewVersionBanner />);
    expect(screen.queryByTestId('new-version-banner')).not.toBeInTheDocument();
  });

  it('renders banner + reload button when new version detected', () => {
    mockUseAppVersionPolling.mockReturnValue(true);
    render(<NewVersionBanner />);

    expect(screen.getByTestId('new-version-banner')).toBeVisible();
    expect(screen.getByTestId('new-version-banner-reload')).toBeVisible();
    expect(screen.getByText('app.newVersion.message')).toBeInTheDocument();
    expect(screen.getByText('app.newVersion.reload')).toBeInTheDocument();
  });

  it('calls window.location.reload when reload button clicked', async () => {
    mockUseAppVersionPolling.mockReturnValue(true);
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy },
    });

    render(<NewVersionBanner />);
    await userEvent.click(screen.getByTestId('new-version-banner-reload'));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
