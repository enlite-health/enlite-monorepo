/**
 * CompleteProfileNotice (096, decisão 19/11): cada item faltando isolado → o aviso nomeia SÓ aquele item e o botão leva à
 * aba/campo certo do perfil; dois faltando → os dois. Sem valor de dado do prestador na tela.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { MissingProfileItem } from '@domain/entities/WorkerJobByRadius';
import { CompleteProfileNotice } from './CompleteProfileNotice';
import { profileUrlFor } from './profileNoticeUrls';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));

beforeEach(() => mockNavigate.mockClear());

const ALL: MissingProfileItem[] = ['address', 'profession', 'sex', 'availability'];

describe('CompleteProfileNotice', () => {
  it.each(ALL)('só %s faltando → um item, com o texto e o botão desse item', (item) => {
    render(<CompleteProfileNotice missing={[item]} />);
    const rows = screen.getAllByTestId('profile-notice-item');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-item', item);
    expect(within(rows[0]).getByText(`profileNotice.items.${item}.label`)).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: `profileNotice.items.${item}.action` })).toBeInTheDocument();
    for (const outro of ALL.filter((i) => i !== item)) expect(screen.queryByText(`profileNotice.items.${outro}.label`)).not.toBeInTheDocument();
  });

  it('dois faltando → os dois itens, na ordem recebida', () => {
    render(<CompleteProfileNotice missing={['address', 'availability']} />);
    expect(screen.getAllByTestId('profile-notice-item').map((r) => r.getAttribute('data-item'))).toEqual(['address', 'availability']);
  });

  it.each([
    ['address', '/worker/profile?tab=address'],
    ['profession', '/worker/profile?tab=general&focus=profession'],
    ['sex', '/worker/profile?tab=general&focus=sex'],
    ['availability', '/worker/profile?tab=availability'],
  ] as const)('o botão de %s leva a %s (as rotas que a home já usa)', (item, url) => {
    expect(profileUrlFor(item)).toBe(url);
    render(<CompleteProfileNotice missing={[item]} />);
    fireEvent.click(screen.getByRole('button', { name: `profileNotice.items.${item}.action` }));
    expect(mockNavigate).toHaveBeenCalledWith(url);
  });

  it('tom de convite: nenhuma classe de vermelho/erro e nada de role=alert', () => {
    const { container } = render(<CompleteProfileNotice missing={ALL} />);
    expect(container.innerHTML).not.toMatch(/red-|#dc2626|#ef4444|role="alert"/);
  });
});
