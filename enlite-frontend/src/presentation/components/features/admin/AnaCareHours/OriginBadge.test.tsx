import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OriginBadge } from './OriginBadge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('OriginBadge', () => {
  it.each(['sin_checkin', 'web_admin', 'app'] as const)('POSITIVO — renderiza a origem %s com o título (description) i18n', (origin) => {
    render(<OriginBadge origin={origin} />);
    const el = screen.getByText(`admin.anacareHours.origin.${origin === 'sin_checkin' ? 'sinCheckin' : origin === 'web_admin' ? 'webAdmin' : 'app'}`);
    expect(el.closest('span[title]')).toHaveAttribute(
      'title',
      `admin.anacareHours.origin.${origin === 'sin_checkin' ? 'descriptionSinCheckin' : origin === 'web_admin' ? 'descriptionWebAdmin' : 'descriptionApp'}`,
    );
  });

  it('POSITIVO — aceita className extra', () => {
    render(<OriginBadge origin="app" className="extra-class" />);
    expect(document.querySelector('.extra-class')).toBeInTheDocument();
  });
});
