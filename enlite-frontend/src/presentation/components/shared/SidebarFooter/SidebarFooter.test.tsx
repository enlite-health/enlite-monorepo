import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@presentation/components/features/access/GroupSimulationSelect', () => ({ GroupSimulationSelect: () => null }));

import { SidebarFooter } from './SidebarFooter';

const wrap = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('SidebarFooter', () => {
  it('admin (com profileHref): iniciais pela regra do PersonAvatar (2 letras), rótulo e aria-label no link', () => {
    wrap(<SidebarFooter userName="Usuária Exemplo" profileHref="/admin/mi-cuenta" profileLabel="Mi perfil" profileAriaLabel="Mi perfil — Usuária Exemplo" />);
    const link = screen.getByTestId('sidebar-profile-link');
    expect(link).toHaveAttribute('href', '/admin/mi-cuenta');
    expect(link).toHaveAttribute('aria-label', 'Mi perfil — Usuária Exemplo');
    expect(link).toHaveTextContent('UE');
    expect(screen.getByTestId('sidebar-profile-label')).toHaveTextContent('Mi perfil');
  });

  it('o botão de sair fica FORA do link e continua chamando onMenuClick', () => {
    const onMenuClick = vi.fn();
    wrap(<SidebarFooter userName="Usuária Exemplo" profileHref="/admin/mi-cuenta" onMenuClick={onMenuClick} />);
    const logout = screen.getByRole('button', { name: 'Logout' });
    expect(screen.getByTestId('sidebar-profile-link')).not.toContainElement(logout);
    fireEvent.click(logout);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
  });

  it('sem profileHref (app do prestador): sem link, sem rótulo e a inicial de sempre (1 letra)', () => {
    wrap(<SidebarFooter userName="Usuária Exemplo" />);
    expect(screen.queryByTestId('sidebar-profile-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-profile-label')).not.toBeInTheDocument();
    expect(screen.getByText('U')).toBeInTheDocument();
  });

  it('foto que falha ao carregar cai nas iniciais', () => {
    const { container } = wrap(<SidebarFooter userName="Usuária Exemplo" userAvatar="data:image/png;base64,AAAA" profileHref="/admin/mi-cuenta" />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByTestId('sidebar-profile-link')).toHaveTextContent('UE');
  });
});
