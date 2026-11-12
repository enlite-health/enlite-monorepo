import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InviteStepCards } from '../InviteStepCards';
import { InviteListHeader } from '../InviteListHeader';
import { InviteRow } from '../InviteRow';
import { InviteListFooter } from '../InviteListFooter';
import { buildBoardView, type BoardContext } from '../inviteBoardModel';
import type { SavedCandidate } from '../../../../../types/match';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: unknown) => (o && typeof o === 'object' ? `${k}${JSON.stringify(o)}` : k), i18n: { language: 'es' } }),
}));

const cand = (id: string, d: number | null, extra: Partial<SavedCandidate> = {}): SavedCandidate => ({
  workerId: id, workerName: `Nome ${id}`, workerPhone: null, occupation: 'AT', workZone: null, distanceKm: d, lat: -34.6, lng: -58.4,
  activeCasesCount: 0, workerStatus: null, documentStatus: 'approved', source: 'system', funnelStage: 'INVITED', replied: false,
  matchScore: null, internalNotes: null, alreadyApplied: false, messagedAt: null, ...extra,
});
const ctxOf = (candidates: SavedCandidate[], over: Partial<BoardContext> = {}): BoardContext => ({
  candidates, currentIds: new Set(candidates.map((c) => c.workerId)), docOnly: false, unselected: new Set(), operationDate: '2026-11-06', ...over,
});
const noop = () => undefined;

describe('InviteStepCards', () => {
  const cands = [cand('a', 2), cand('b', 7), cand('v', 3, { source: 'manual' })];
  it('marca o passo atual com aria-current e esconde "Ya en la vacante" sem gente', () => {
    const view = buildBoardView(ctxOf([cand('a', 2), cand('b', 7)]), 5);
    render(<InviteStepCards steps={view.steps} onSelect={noop} />);
    expect(screen.getByTestId('invite-step-5')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByTestId('invite-step-vacante')).toBeNull();
    expect(screen.getByTestId('invite-step-10')).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'admin.vacancyInvite.steps.label');
    void cands;
  });
  it('clique troca o passo e o concluído mostra "N invitados"', async () => {
    const onSelect = vi.fn();
    const view = buildBoardView(ctxOf([cand('a', 2, { messagedAt: '2026-11-03T12:00:00Z' }), cand('b', 7)]), 10);
    render(<InviteStepCards steps={view.steps} onSelect={onSelect} />);
    expect(screen.getByTestId('invite-step-5')).toHaveAttribute('data-tone', 'done');
    expect(screen.getByTestId('invite-step-5')).toHaveTextContent('"count":1');
    await userEvent.click(screen.getByTestId('invite-step-20'));
    expect(onSelect).toHaveBeenCalledWith(20);
  });
});

describe('InviteListHeader', () => {
  it('guia, nota do perfil (⚑7: escondida no vacante), contador e interruptor', async () => {
    const onDocOnly = vi.fn();
    const onToggleAll = vi.fn();
    const c = ctxOf([cand('a', 2), cand('b', 3, { documentStatus: 'pending' })]);
    const { rerender } = render(<InviteListHeader view={buildBoardView(c, 5)} docOnly={false} onSelectStep={noop} onToggleAll={onToggleAll} onDocOnly={onDocOnly} />);
    expect(screen.getByTestId('invite-profile-note')).toBeInTheDocument();
    expect(screen.getByTestId('invite-counter')).toHaveTextContent('"selected":2,"pending":2');
    expect(screen.getByTestId('invite-docs-line')).toHaveTextContent('docs.off{"complete":1,"missing":1}');
    await userEvent.click(screen.getByRole('switch'));
    expect(onDocOnly).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByTestId('invite-select-all'));
    expect(onToggleAll).toHaveBeenCalledWith(false);
    const v = ctxOf([cand('a', 2), cand('m', 3, { source: 'manual' })], { currentIds: new Set(['a']) });
    rerender(<InviteListHeader view={buildBoardView(v, 'vacante')} docOnly={false} onSelectStep={noop} onToggleAll={onToggleAll} onDocOnly={onDocOnly} />);
    expect(screen.queryByTestId('invite-profile-note')).toBeNull();
    expect(screen.getByTestId('invite-guide')).toHaveTextContent('guide.vacantePending');
  });
  it('0 pendentes: "Todos ya invitados" e caixa Todos desabilitada', () => {
    const c = ctxOf([cand('a', 2, { messagedAt: '2026-11-03T12:00:00Z' })]);
    render(<InviteListHeader view={buildBoardView(c, 5)} docOnly={false} onSelectStep={noop} onToggleAll={noop} onDocOnly={noop} />);
    expect(screen.getByTestId('invite-counter')).toHaveTextContent('selection.allInvited');
    expect(screen.getByTestId('invite-select-all')).toBeDisabled();
  });
});

describe('InviteRow', () => {
  const rowOf = (c: SavedCandidate) => buildBoardView(ctxOf([c]), 5).rows[0];
  const base = { focused: false, highlighted: false, onToggle: noop, onNameClick: noop, onHover: noop };
  it('caixa com aria-label, "Ver perfil" em nova aba, hover e clique no nome', async () => {
    const onToggle = vi.fn(); const onNameClick = vi.fn(); const onHover = vi.fn();
    render(<InviteRow {...base} row={rowOf(cand('a', 1.2, { activeCasesCount: 2 }))} onToggle={onToggle} onNameClick={onNameClick} onHover={onHover} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /row\.choose.*Nome a/ }));
    expect(onToggle).toHaveBeenCalledWith('a');
    await userEvent.click(screen.getByTestId('invite-row-name-a'));
    expect(onNameClick).toHaveBeenCalledWith('a');
    const link = screen.getByTestId('invite-row-profile-a');
    expect(link).toHaveAttribute('href', '/admin/workers/a');
    expect(link).toHaveAttribute('target', '_blank');
    await userEvent.hover(screen.getByTestId('invite-row-a'));
    expect(onHover).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('invite-row-distance-a')).toHaveTextContent('"value":"1,2"');
    expect(screen.getByTestId('invite-row-a')).toHaveTextContent('activeCases');
  });
  it('já convidado: sem caixa, selo "el dd/MM"; hoje: selo success; sem distância: "—"', () => {
    const { rerender } = render(<InviteRow {...base} row={rowOf(cand('a', 2, { messagedAt: '2026-11-03T15:00:00Z' }))} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('invite-row-badge-a')).toHaveTextContent('"date":"03/11"');
    rerender(<InviteRow {...base} row={rowOf(cand('a', 2, { messagedAt: '2026-11-06T15:00:00Z' }))} />);
    expect(screen.getByTestId('invite-row-badge-a')).toHaveTextContent('row.invitedToday');
    const noLoc = cand('n', null, { lat: null, lng: null, source: 'manual' });
    const row = buildBoardView(ctxOf([noLoc], { currentIds: new Set() }), 'vacante').rows[0];
    rerender(<InviteRow {...base} row={row} />);
    expect(screen.getByTestId('invite-row-distance-n')).toHaveTextContent('row.noDistance');
  });
  it('foco = fundo de foco; enviando e erro DF-19 aparecem no selo', () => {
    const { rerender } = render(<InviteRow {...base} focused row={rowOf(cand('a', 2))} />);
    expect(screen.getByTestId('invite-row-a').className).toContain('bg-[#ECE8F6]');
    rerender(<InviteRow {...base} row={rowOf(cand('a', 2))} send={{ kind: 'sending' }} />);
    expect(screen.getByTestId('invite-row-badge-a')).toHaveTextContent('row.sending');
    rerender(<InviteRow {...base} row={rowOf(cand('a', 2))} send={{ kind: 'error', text: 'Cooldown' }} />);
    expect(screen.getByTestId('invite-row-badge-a')).toHaveTextContent('Cooldown');
  });
});

describe('InviteListFooter', () => {
  const footerOf = (cands: SavedCandidate[], step: 5 | 'vacante' | 50 = 5, over: Partial<BoardContext> = {}) =>
    buildBoardView(ctxOf(cands, over), step).footer;
  const props = { invitedCount: 3, onInvite: noop, onMore: noop, onFinish: noop };
  it('modo invite: "Invitar a N" + secundário "buscar más lejos"; clique chama onInvite', async () => {
    const onInvite = vi.fn();
    render(<InviteListFooter {...props} onInvite={onInvite} step={5} footer={footerOf([cand('a', 2), cand('b', 3), cand('c', 8)])} />);
    expect(screen.getByTestId('invite-footer')).toHaveAttribute('data-mode', 'invite');
    expect(screen.getByTestId('invite-btn-invite')).toHaveTextContent('"count":2');
    expect(screen.getByTestId('invite-btn-more-secondary')).toHaveTextContent('"km":10,"count":1');
    expect(screen.queryByTestId('invite-btn-finish-secondary')).toBeNull();
    await userEvent.click(screen.getByTestId('invite-btn-invite'));
    expect(onInvite).toHaveBeenCalledTimes(1);
  });
  it('modo empty: Invitar desabilitado + aviso "Elegí al menos una persona"', () => {
    const f = footerOf([cand('a', 2)], 5, { unselected: new Set(['a']) });
    render(<InviteListFooter {...props} step={5} footer={f} />);
    expect(screen.getByTestId('invite-btn-invite')).toBeDisabled();
    expect(screen.getByTestId('invite-footer-hint')).toBeInTheDocument();
  });
  it('modo after: primário "buscar más lejos" + secundário Terminar; vacante usa o rótulo "cerca del servicio"', async () => {
    const onMore = vi.fn(); const onFinish = vi.fn();
    const f = footerOf([cand('a', 2, { messagedAt: '2026-11-03T12:00:00Z' }), cand('b', 7)]);
    const { rerender } = render(<InviteListFooter {...props} onMore={onMore} onFinish={onFinish} step={5} footer={f} />);
    await userEvent.click(screen.getByTestId('invite-btn-more-primary'));
    await userEvent.click(screen.getByTestId('invite-btn-finish-secondary'));
    expect(onMore).toHaveBeenCalled(); expect(onFinish).toHaveBeenCalled();
    const fv = footerOf([cand('m', 3, { source: 'manual', messagedAt: '2026-11-03T12:00:00Z' }), cand('b', 3)], 'vacante', { currentIds: new Set(['b']) });
    rerender(<InviteListFooter {...props} step="vacante" footer={fv} />);
    expect(screen.getByTestId('invite-btn-more-primary')).toHaveTextContent('footer.moreFromVacante');
  });
  it('último passo concluído: só "Terminar" primário; sem permissão de envio: Invitar desabilitado com motivo', () => {
    const last = footerOf([cand('a', 40, { messagedAt: '2026-11-03T12:00:00Z' })], 50);
    const { rerender } = render(<InviteListFooter {...props} step={50} footer={last} />);
    expect(screen.getByTestId('invite-btn-finish-primary')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-btn-more-primary')).toBeNull();
    rerender(<InviteListFooter {...props} step={5} inviteDisabledReason="sin permiso" footer={footerOf([cand('a', 2)])} />);
    expect(screen.getByTestId('invite-btn-invite')).toBeDisabled();
    expect(screen.getByTestId('invite-btn-invite')).toHaveAttribute('title', 'sin permiso');
  });
});
