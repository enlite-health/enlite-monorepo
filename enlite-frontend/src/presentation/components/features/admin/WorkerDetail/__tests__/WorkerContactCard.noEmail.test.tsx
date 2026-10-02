import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkerContactCard } from '../WorkerContactCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const base = {
  status: 'REGISTERED',
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  whatsappPhone: null,
  profilePhotoUrl: null,
  documentType: null,
  documentNumber: null,
  platform: 'talentum',
  dataSources: [] as string[],
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',
};

describe('WorkerContactCard — worker sem e-mail (spec 040 T4.0)', () => {
  it('sem nome e sem e-mail: título e e-mail mostram "—", avatar "?" e nunca "null"', () => {
    render(<WorkerContactCard {...base} />);
    const card = screen.getByTestId('worker-contact-card');
    expect(screen.getByRole('heading', { level: 3, name: '—' })).toBeInTheDocument();
    expect(card).toHaveTextContent('?');
    expect(card.textContent).not.toContain('null');
  });

  it('com nome e e-mail nulo: o nome continua no título', () => {
    render(<WorkerContactCard {...base} firstName="Ana" lastName="Silva" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Ana Silva' })).toBeInTheDocument();
  });
});
