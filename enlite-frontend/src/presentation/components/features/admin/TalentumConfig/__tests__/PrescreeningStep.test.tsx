import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrescreeningStep } from '../PrescreeningStep';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }),
}));

const ps = 'admin.vacancyDetail.prescreening';
const questions = [
  { question: 'Q1', responseType: ['text'], desiredResponse: 'R1', weight: 5, required: true, analyzed: true, earlyStoppage: false },
];
const faq = [{ question: 'F1', answer: 'A1' }];

describe('PrescreeningStep — modo padrão (como o wizard usa, sem a prop)', () => {
  it('controles seguem editáveis e botões de adicionar/remover seguem visíveis', () => {
    const { container } = render(<PrescreeningStep initialQuestions={questions} initialFaq={faq} />);
    expect(screen.getByText(`${ps}.addQuestion`)).toBeInTheDocument();
    expect(screen.getByText(`${ps}.addFaq`)).toBeInTheDocument();
    // 2 botões de remover (1 pergunta + 1 FAQ): botões sem texto com svg
    const fields = container.querySelectorAll('textarea, input[type="text"], input[type="number"]');
    expect(fields.length).toBe(5);
    fields.forEach((f) => expect(f).not.toHaveAttribute('readonly'));
    container.querySelectorAll('input[type="checkbox"]').forEach((c) => expect(c).not.toBeDisabled());
    expect(container.querySelectorAll('button:not([disabled]) svg.lucide-trash-2').length).toBe(2);
  });
});

describe('PrescreeningStep — readOnly', () => {
  it('sem botões de adicionar/remover e sem controle editável', () => {
    const { container } = render(<PrescreeningStep initialQuestions={questions} initialFaq={faq} readOnly />);
    expect(screen.queryByText(`${ps}.addQuestion`)).not.toBeInTheDocument();
    expect(screen.queryByText(`${ps}.addFaq`)).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg.lucide-trash-2').length).toBe(0);
    const fields = container.querySelectorAll('textarea, input[type="text"], input[type="number"]');
    expect(fields.length).toBe(5);
    fields.forEach((f) => expect(f).toHaveAttribute('readonly'));
    container.querySelectorAll('input[type="checkbox"]').forEach((c) => expect(c).toBeDisabled());
    expect(screen.getByDisplayValue('Q1')).toBeInTheDocument();
  });
});
