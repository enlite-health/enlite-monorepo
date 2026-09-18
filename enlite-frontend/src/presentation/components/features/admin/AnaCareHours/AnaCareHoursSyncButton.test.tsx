import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnaCareHoursSyncButton } from './AnaCareHoursSyncButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }),
}));

describe('AnaCareHoursSyncButton', () => {
  it('POSITIVO — idle sem cursor retomável: botão habilitado, rótulo "Sincronizar"', () => {
    render(<AnaCareHoursSyncButton status="idle" round={0} reservationsProcessed={0} error={null} resumableCursor={null} onStart={vi.fn()} />);
    const button = screen.getByTestId('anacare-hours-sync-button');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('admin.anacareHours.sync.button');
    expect(screen.queryByTestId('anacare-hours-sync-resume-hint')).not.toBeInTheDocument();
  });

  it('POSITIVO — running: botão DESABILITADO e progresso visível com round/count reais', () => {
    render(<AnaCareHoursSyncButton status="running" round={2} reservationsProcessed={7} error={null} resumableCursor={50} onStart={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-sync-button')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-sync-progress')).toHaveTextContent(
      'admin.anacareHours.sync.progress|{"round":2,"count":7}',
    );
  });

  it('NEGATIVO — error: mensagem crua aparece, botão volta a ficar habilitado', () => {
    render(
      <AnaCareHoursSyncButton status="error" round={1} reservationsProcessed={4} error="falhou geral" resumableCursor={50} onStart={vi.fn()} />,
    );
    expect(screen.getByTestId('anacare-hours-sync-button')).not.toBeDisabled();
    expect(screen.getByTestId('anacare-hours-sync-error')).toHaveTextContent('falhou geral');
  });

  it('POSITIVO — idle com cursor retomável: rótulo muda para retomar e mostra a dica', () => {
    render(<AnaCareHoursSyncButton status="idle" round={0} reservationsProcessed={0} error={null} resumableCursor={50} onStart={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-sync-button')).toHaveTextContent('admin.anacareHours.sync.resumeButton');
    expect(screen.getByTestId('anacare-hours-sync-resume-hint')).toBeInTheDocument();
  });

  it('POSITIVO — clicar chama onStart', () => {
    const onStart = vi.fn();
    render(<AnaCareHoursSyncButton status="idle" round={0} reservationsProcessed={0} error={null} resumableCursor={null} onStart={onStart} />);
    screen.getByTestId('anacare-hours-sync-button').click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
