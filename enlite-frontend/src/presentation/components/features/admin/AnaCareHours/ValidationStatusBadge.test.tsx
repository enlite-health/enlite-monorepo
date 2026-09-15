import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ValidationStatusBadge } from './ValidationStatusBadge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('ValidationStatusBadge', () => {
  it.each(['pendiente', 'validado', 'contestado'] as const)('POSITIVO — renderiza o status %s', (status) => {
    render(<ValidationStatusBadge status={status} />);
    expect(screen.getByText(`admin.anacareHours.status.${status}`)).toBeInTheDocument();
  });
});
