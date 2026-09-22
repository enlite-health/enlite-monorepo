import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnaCareHoursSyncButton } from './AnaCareHoursSyncButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'es' },
  }),
}));

describe('AnaCareHoursSyncButton', () => {
  it('POSITIVO — idle sem cursor retomável: botão habilitado, rótulo "Sincronizar"', () => {
    render(
      <AnaCareHoursSyncButton
        status="idle"
        round={0}
        reservationsProcessed={0}
        reservationsTotal={null}
        reservationsDone={null}
        error={null}
        resumableCursor={null}
        onStart={vi.fn()}
      />,
    );
    const button = screen.getByTestId('anacare-hours-sync-button');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('admin.anacareHours.sync.button');
    expect(screen.queryByTestId('anacare-hours-sync-resume-hint')).not.toBeInTheDocument();
  });

  it('POSITIVO (Requisito 2) — running: botão DESABILITADO, rótulo PRÓPRIO (nunca só "common.loading") e progresso via round/count quando não há contagem X de Y', () => {
    render(
      <AnaCareHoursSyncButton
        status="running"
        round={2}
        reservationsProcessed={7}
        reservationsTotal={null}
        reservationsDone={null}
        error={null}
        resumableCursor={50}
        onStart={vi.fn()}
      />,
    );
    const button = screen.getByTestId('anacare-hours-sync-button');
    expect(button).toBeDisabled();
    // Requisito 2: nunca a chave genérica de loading (`common.loading`, que é o que `Button.tsx`
    // usaria com `isLoading=true`) — o rótulo é PRÓPRIO deste componente.
    expect(button).toHaveTextContent('admin.anacareHours.sync.runningLabel');
    expect(button).not.toHaveTextContent('common.loading');
    expect(screen.getByTestId('anacare-hours-sync-progress')).toHaveTextContent('admin.anacareHours.sync.progress|{"round":2,"count":7}');
  });

  it('POSITIVO (Requisito 1) — running COM reservationsTotal/reservationsDone: mostra "X de Y reservas" (progressCount), não o texto de round/processadas', () => {
    render(
      <AnaCareHoursSyncButton
        status="running"
        round={3}
        reservationsProcessed={45}
        reservationsTotal={285}
        reservationsDone={120}
        error={null}
        resumableCursor={120}
        onStart={vi.fn()}
      />,
    );
    const progress = screen.getByTestId('anacare-hours-sync-progress');
    expect(progress).toHaveTextContent('admin.anacareHours.sync.progressCount|{"done":120,"total":285}');
    expect(progress).not.toHaveTextContent('admin.anacareHours.sync.progress|');
  });

  it('POSITIVO (risco nomeado em design.md) — running com reservationsTotal presente mas reservationsDone ausente: NUNCA "undefined de undefined", cai no texto de round/processadas', () => {
    render(
      <AnaCareHoursSyncButton
        status="running"
        round={1}
        reservationsProcessed={10}
        reservationsTotal={285}
        reservationsDone={null}
        error={null}
        resumableCursor={null}
        onStart={vi.fn()}
      />,
    );
    const progress = screen.getByTestId('anacare-hours-sync-progress');
    expect(progress).not.toHaveTextContent(/undefined/i);
    expect(progress).toHaveTextContent('admin.anacareHours.sync.progress|{"round":1,"count":10}');
  });

  it('NEGATIVO — error: mensagem (já traduzida pelo hook) aparece, botão volta a ficar habilitado', () => {
    render(
      <AnaCareHoursSyncButton
        status="error"
        round={1}
        reservationsProcessed={4}
        reservationsTotal={null}
        reservationsDone={null}
        error="admin.anacareHours.error.byCode.NETWORK_ERROR"
        resumableCursor={50}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anacare-hours-sync-button')).not.toBeDisabled();
    expect(screen.getByTestId('anacare-hours-sync-error')).toHaveTextContent('admin.anacareHours.error.byCode.NETWORK_ERROR');
  });

  it('POSITIVO — idle com cursor retomável: rótulo muda para retomar e mostra a dica', () => {
    render(
      <AnaCareHoursSyncButton
        status="idle"
        round={0}
        reservationsProcessed={0}
        reservationsTotal={null}
        reservationsDone={null}
        error={null}
        resumableCursor={50}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anacare-hours-sync-button')).toHaveTextContent('admin.anacareHours.sync.resumeButton');
    expect(screen.getByTestId('anacare-hours-sync-resume-hint')).toBeInTheDocument();
  });

  it('POSITIVO — clicar chama onStart', () => {
    const onStart = vi.fn();
    render(
      <AnaCareHoursSyncButton
        status="idle"
        round={0}
        reservationsProcessed={0}
        reservationsTotal={null}
        reservationsDone={null}
        error={null}
        resumableCursor={null}
        onStart={onStart}
      />,
    );
    screen.getByTestId('anacare-hours-sync-button').click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('POSITIVO — status done: mensagem de concluído visível, botão volta a ficar habilitado', () => {
    render(
      <AnaCareHoursSyncButton
        status="done"
        round={4}
        reservationsProcessed={283}
        reservationsTotal={283}
        reservationsDone={283}
        error={null}
        resumableCursor={null}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anacare-hours-sync-done')).toHaveTextContent('admin.anacareHours.sync.done');
    expect(screen.getByTestId('anacare-hours-sync-button')).not.toBeDisabled();
  });

  it('DEDUPED (B) — status deduped: mensagem própria visível, botão volta a ficar habilitado', () => {
    render(
      <AnaCareHoursSyncButton
        status="deduped"
        round={0}
        reservationsProcessed={0}
        reservationsTotal={null}
        reservationsDone={null}
        error={null}
        resumableCursor={null}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anacare-hours-sync-deduped')).toHaveTextContent('admin.anacareHours.sync.deduped');
    expect(screen.getByTestId('anacare-hours-sync-button')).not.toBeDisabled();
  });
});
