import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));

vi.mock('@presentation/components/features/admin/AnaCareHours/AnaCareHoursListContainer', () => ({
  AnaCareHoursListContainer: ({ onOpenPatient }: { onOpenPatient: (id: string) => void }) => (
    <button data-testid="stub-list-container" onClick={() => onOpenPatient('90000')}>
      stub
    </button>
  ),
}));

import AnaCareHoursPage from './AnaCareHoursPage';

describe('AnaCareHoursPage', () => {
  it('POSITIVO — renderiza o container da lista e navega ao abrir um paciente', () => {
    render(<AnaCareHoursPage />);
    fireEvent.click(screen.getByTestId('stub-list-container'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas/90000');
  });
});
