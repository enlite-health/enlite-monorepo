/**
 * ClinicalTextareaField — textarea clínico do drawer (observações gerais e instruções de
 * emergência usam o MESMO componente): contador por interpolação do i18n, máscara, ref, disabled.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, number>) =>
      key === 'admin.patients.detail.diagnosisCard.generalNotesCounter' ? `${opts!.count}/${opts!.max} caracteres` : key,
  }),
}));

import { ClinicalTextareaField } from '../ClinicalTextareaField';

describe('ClinicalTextareaField', () => {
  it('renderiza textarea com id/testid, rows, maxLength, rótulo e contador via t(key, {count, max})', () => {
    render(<ClinicalTextareaField id="campo" label="Rótulo" rows={8} maxChars={4000} value="abc" />);
    const ta = screen.getByTestId('campo') as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveAttribute('id', 'campo');
    expect(ta).toHaveAttribute('rows', '8');
    expect(ta).toHaveAttribute('maxlength', '4000');
    expect(screen.getByText('Rótulo')).toBeInTheDocument();
    expect(screen.getByTestId('campo-counter').textContent).toBe('3/4000 caracteres');
    expect(ta.parentElement).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('value undefined (antes do primeiro render do form) conta 0', () => {
    render(<ClinicalTextareaField id="campo" label="Rótulo" maxChars={10} value={undefined} />);
    expect(screen.getByTestId('campo-counter').textContent).toBe('0/10 caracteres');
  });

  it('encaminha ref (register do react-hook-form) e repassa disabled/placeholder/name ao textarea', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<ClinicalTextareaField ref={ref} id="campo" label="Rótulo" maxChars={10} value="" name="x" disabled placeholder="oculto" />);
    expect(ref.current).toBe(screen.getByTestId('campo'));
    expect(ref.current).toBeDisabled();
    expect(ref.current).toHaveAttribute('placeholder', 'oculto');
    expect(ref.current).toHaveAttribute('name', 'x');
  });
});
