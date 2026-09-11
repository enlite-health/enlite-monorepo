/**
 * PostularseErrorModal.test.tsx
 *
 * Arquivo não tinha teste nenhum antes (33.87% lines / 0% funcs na suíte
 * cheia) — agora é reusado também pela home (D1, completude "não apurada").
 * onRetry/onCompleteRegistration viraram opcionais: em /vacantes/:id os dois
 * continuam sempre presentes; na home (JobsEmbeddedSection) nenhum dos dois
 * é passado — sem CTA de retry nem de "completar registro".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PostularseErrorModal } from './PostularseErrorModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('PostularseErrorModal — conteúdo', () => {
  it('mostra título e corpo do estado "não verificado"', () => {
    render(<PostularseErrorModal onClose={vi.fn()} />);
    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();
    expect(screen.getByText('publicVacancy.errorModal.body')).toBeInTheDocument();
  });

  it('sempre mostra o botão "Cerrar" (cancel)', () => {
    render(<PostularseErrorModal onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'publicVacancy.errorModal.cancel' })).toBeInTheDocument();
  });
});

describe('PostularseErrorModal — onClose', () => {
  it('clicar em "Cerrar" chama onClose', () => {
    const onClose = vi.fn();
    render(<PostularseErrorModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.errorModal.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicar no overlay (fundo) chama onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<PostularseErrorModal onClose={onClose} />);
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicar DENTRO do card NÃO fecha (stopPropagation)', () => {
    const onClose = vi.fn();
    render(<PostularseErrorModal onClose={onClose} />);
    fireEvent.click(screen.getByText('publicVacancy.errorModal.title'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PostularseErrorModal — body customizado (opcional, D1 rodada 5)', () => {
  it('sem prop `body` → usa o texto padrão (publicVacancy.errorModal.body)', () => {
    render(<PostularseErrorModal onClose={vi.fn()} />);
    expect(screen.getByText('publicVacancy.errorModal.body')).toBeInTheDocument();
  });

  it('com prop `body` → usa o texto CUSTOM, não o padrão (home passa um texto próprio, sem CTA embutido)', () => {
    render(<PostularseErrorModal onClose={vi.fn()} body="Texto próprio da home." />);
    expect(screen.getByText('Texto próprio da home.')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.body')).not.toBeInTheDocument();
  });
});

describe('PostularseErrorModal — onRetry (opcional)', () => {
  it('omitido (uso na home) → botão "Reintentar" NÃO renderiza', () => {
    render(<PostularseErrorModal onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'publicVacancy.errorModal.retry' })).not.toBeInTheDocument();
  });

  it('fornecido (uso em /vacantes/:id) → botão "Reintentar" renderiza e chama onRetry', () => {
    const onRetry = vi.fn();
    render(<PostularseErrorModal onClose={vi.fn()} onRetry={onRetry} />);
    const btn = screen.getByRole('button', { name: 'publicVacancy.errorModal.retry' });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('PostularseErrorModal — onCompleteRegistration (opcional)', () => {
  it('omitido (uso na home) → botão "Completar registro" NÃO renderiza (D1: sem CTA de completar algo que talvez já esteja completo)', () => {
    render(<PostularseErrorModal onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'publicVacancy.errorModal.complete' })).not.toBeInTheDocument();
  });

  it('fornecido (uso em /vacantes/:id) → botão "Completar registro" renderiza e chama onCompleteRegistration', () => {
    const onCompleteRegistration = vi.fn();
    render(<PostularseErrorModal onClose={vi.fn()} onCompleteRegistration={onCompleteRegistration} />);
    const btn = screen.getByRole('button', { name: 'publicVacancy.errorModal.complete' });
    fireEvent.click(btn);
    expect(onCompleteRegistration).toHaveBeenCalledTimes(1);
  });
});
