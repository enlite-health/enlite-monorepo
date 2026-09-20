/**
 * KanbanCardBlocked.test.tsx — a seção do card na coluna BLOQUEADO (D300).
 *
 * O caso que dá nome a tudo isto: a tarjeta da prestadora dizia "Worker
 * desactivado" (motivo congelado em 02/09) enquanto ela já tinha sido reativada
 * em 04/09 e o que faltava eram dois campos do cadastro. O teste do estado
 * `registration_incomplete` abaixo é exatamente essa tarjeta, com os dois campos
 * que ela precisa preencher.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCardBlocked } from '../KanbanCardBlocked';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'count' in opts ? `${key}:${opts.count}` : key,
  }),
}));

describe('KanbanCardBlocked — o card diz o motivo de HOJE', () => {
  it('registro incompleto: mostra o rótulo vermelho e QUAIS campos faltam', () => {
    render(
      <KanbanCardBlocked
        blockedReason="registration_incomplete"
        missingFields={['years_experience', 'preferred_types']}
        attemptCount={5}
      />,
    );

    expect(screen.getByTestId('blocked-badge')).toHaveTextContent('admin.kanban.blockedBadge');
    expect(screen.getByTestId('blocked-reason')).toHaveTextContent(
      'admin.blockedAttempts.reason.registration_incomplete',
    );
    const tags = screen.getByTestId('blocked-missing-fields');
    expect(tags).toHaveTextContent('admin.blockedAttempts.missingField.years_experience');
    expect(tags).toHaveTextContent('admin.blockedAttempts.missingField.preferred_types');
    expect(screen.getByTestId('blocked-attempt-count')).toHaveTextContent('5');
    // Sem botão: promover quem não é elegível seria prometer o que o gate recusa.
    expect(screen.queryByTestId('promote-button')).toBeNull();
  });

  it('worker desativado: sem lista de campos — não existem "campos faltantes" de quem está desativado', () => {
    render(<KanbanCardBlocked blockedReason="worker_disabled" missingFields={[]} attemptCount={1} />);

    expect(screen.getByTestId('blocked-reason')).toHaveTextContent(
      'admin.blockedAttempts.reason.worker_disabled',
    );
    expect(screen.queryByTestId('blocked-missing-fields')).toBeNull();
    expect(screen.queryByTestId('promote-button')).toBeNull();
  });

  it('sem tentativas registradas, o contador não aparece', () => {
    render(<KanbanCardBlocked blockedReason="worker_not_found" attemptCount={0} />);
    expect(screen.queryByTestId('blocked-attempt-count')).toBeNull();
  });

  it('sem motivo nenhum, a seção não inventa um', () => {
    render(<KanbanCardBlocked />);
    expect(screen.queryByTestId('blocked-reason')).toBeNull();
    expect(screen.getByTestId('blocked-badge')).toBeInTheDocument();
  });
});

describe('KanbanCardBlocked — elegível é a ausência de bloqueio, não um bloqueio', () => {
  it('troca o rótulo para verde e oferece a ação que resolve o card', () => {
    const onPromote = vi.fn();
    render(<KanbanCardBlocked blockedReason="eligible" attemptCount={5} onPromote={onPromote} />);

    const badge = screen.getByTestId('blocked-badge');
    expect(badge).toHaveTextContent('admin.kanban.eligibleBadge');
    // A cor não é enfeite: vermelho num card sem problema nenhum é o defeito
    // que estamos consertando, só que ao contrário.
    expect(badge.className).toContain('emerald');
    expect(badge.className).not.toContain('red');
    expect(screen.getByTestId('promote-button')).toBeEnabled();
  });

  it('clicar promove e NÃO propaga o clique ao card (o card abre/arrasta)', () => {
    const onPromote = vi.fn();
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <KanbanCardBlocked blockedReason="eligible" onPromote={onPromote} />
      </div>,
    );

    fireEvent.click(screen.getByTestId('promote-button'));

    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
  });

  it.each([['promoting'], ['promoted']] as const)(
    'botão desabilitado em %s — nada de promover duas vezes com dois cliques',
    (status) => {
      render(<KanbanCardBlocked blockedReason="eligible" onPromote={vi.fn()} promoteStatus={status} />);
      expect(screen.getByTestId('promote-button')).toBeDisabled();
    },
  );

  it('erro deixa o botão clicável de novo e mostra o motivo no card, não num banner distante', () => {
    render(
      <KanbanCardBlocked
        blockedReason="eligible"
        onPromote={vi.fn()}
        promoteStatus="error"
        promoteMessage="La vacante ya no admite candidaturas."
      />,
    );

    expect(screen.getByTestId('promote-button')).toBeEnabled();
    expect(screen.getByTestId('promote-message')).toHaveTextContent('La vacante ya no admite candidaturas.');
  });

  it('sem onPromote (sem permissão, ou card já rechazado) o rótulo aparece e o botão não', () => {
    render(<KanbanCardBlocked blockedReason="eligible" />);

    expect(screen.getByTestId('blocked-badge')).toHaveTextContent('admin.kanban.eligibleBadge');
    expect(screen.queryByTestId('promote-button')).toBeNull();
  });
});
