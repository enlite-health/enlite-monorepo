import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LockedFieldBadgeLink } from '../LockedFieldBadgeLink';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('LockedFieldBadgeLink', () => {
  it('o href abre a ficha do paciente NA ABA Servicio Contratado (?tab=contractedService)', () => {
    render(<LockedFieldBadgeLink patientId="p-42" testId="locked-field-link-schedule" />);
    const link = screen.getByTestId('locked-field-link-schedule');
    expect(link).toHaveAttribute('href', '/admin/patients/p-42?tab=contractedService');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('sem patientId não renderiza nada', () => {
    const { container } = render(<LockedFieldBadgeLink patientId={null} testId="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
