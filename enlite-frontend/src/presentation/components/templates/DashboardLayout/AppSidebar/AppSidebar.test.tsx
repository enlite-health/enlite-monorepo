/**
 * AppSidebar.test.tsx
 *
 * Cobre o comportamento do campo opcional `sectionStart` em AppSidebarNavItem:
 *  - Renderiza separador + rótulo quando item tem sectionStart (expandido)
 *  - NÃO renderiza separador quando nenhum item tem sectionStart
 *  - No modo collapsed mostra só o divisor (sem texto)
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppSidebar, type AppSidebarNavItem } from './AppSidebar';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ICON = <svg data-testid="icon" />;

function renderSidebar(
  navItems: AppSidebarNavItem[],
  options: { defaultCollapsed?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AppSidebar
        navItems={navItems}
        userName="Test User"
        defaultCollapsed={options.defaultCollapsed ?? false}
      />
    </MemoryRouter>,
  );
}

// ── Item fixtures ─────────────────────────────────────────────────────────────

const ITEM_BASE: AppSidebarNavItem = {
  icon: ICON,
  label: 'Base Item',
  href: '/base',
};

const ITEM_WITH_SECTION: AppSidebarNavItem = {
  icon: ICON,
  label: 'Admin Item',
  href: '/admin/tags',
  sectionStart: 'Administración',
};

const ITEM_SECOND_ADMIN: AppSidebarNavItem = {
  icon: ICON,
  label: 'Second Admin Item',
  href: '/admin/dedup',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AppSidebar — sectionStart', () => {
  describe('modo EXPANDIDO', () => {
    it('renderiza o rótulo de seção quando um item tem sectionStart', () => {
      renderSidebar([ITEM_BASE, ITEM_WITH_SECTION]);

      // Rótulo da seção deve estar visível
      expect(screen.getByText('Administración')).toBeInTheDocument();
    });

    it('o separador tem role="separator" com o aria-label correto', () => {
      renderSidebar([ITEM_BASE, ITEM_WITH_SECTION]);

      const separator = screen.getByRole('separator');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveAttribute('aria-label', 'Administración');
    });

    it('o rótulo de seção é aria-hidden (decorativo)', () => {
      renderSidebar([ITEM_BASE, ITEM_WITH_SECTION]);

      // O texto do rótulo está dentro de um <span aria-hidden="true">
      const label = screen.getByText('Administración');
      // O próprio elemento ou o pai imediato é aria-hidden
      const ariaHiddenEl = label.closest('[aria-hidden="true"]');
      expect(ariaHiddenEl).toBeInTheDocument();
    });

    it('renderiza múltiplos itens admin SEM separador extra no segundo', () => {
      renderSidebar([ITEM_BASE, ITEM_WITH_SECTION, ITEM_SECOND_ADMIN]);

      // Só 1 separador (só o primeiro admin item tem sectionStart)
      const separators = screen.getAllByRole('separator');
      expect(separators).toHaveLength(1);

      // Ambos os itens admin devem aparecer
      expect(screen.getByText('Admin Item')).toBeInTheDocument();
      expect(screen.getByText('Second Admin Item')).toBeInTheDocument();
    });

    it('NÃO renderiza nenhum separador quando nenhum item tem sectionStart', () => {
      renderSidebar([ITEM_BASE, ITEM_SECOND_ADMIN]);

      // Nenhum role="separator" deve existir
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });

    it('NÃO renderiza texto de seção quando sectionStart é undefined', () => {
      renderSidebar([ITEM_BASE]);

      expect(screen.queryByText('Administración')).not.toBeInTheDocument();
    });
  });

  describe('modo COLLAPSED (defaultCollapsed=true)', () => {
    it('renderiza o separador (divisor) mas NÃO o texto do rótulo', () => {
      renderSidebar([ITEM_BASE, ITEM_WITH_SECTION], { defaultCollapsed: true });

      // O separador (container com role="separator") deve existir
      const separator = screen.getByRole('separator');
      expect(separator).toBeInTheDocument();

      // Mas o texto não deve aparecer no DOM (está condicionado a !isCollapsed)
      expect(screen.queryByText('Administración')).not.toBeInTheDocument();
    });

    it('NÃO renderiza separador quando nenhum item tem sectionStart (collapsed)', () => {
      renderSidebar([ITEM_BASE, ITEM_SECOND_ADMIN], { defaultCollapsed: true });

      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });
  });
});

describe('AppSidebar — sino de notificações (item 4, change 022-ux-mencao-e-notificacao)', () => {
  it('expandida: o sino aparece ANTES de qualquer item de navItems', () => {
    renderSidebar([ITEM_BASE]);

    const bell = screen.getByTestId('notification-bell-btn');
    const navItem = screen.getByText('Base Item');
    // `compareDocumentPosition` bit 4 (DOCUMENT_POSITION_FOLLOWING) = navItem vem DEPOIS do sino.
    const position = bell.compareDocumentPosition(navItem);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('recolhida: o sino continua visível (ícone + botão), mesmo sem nenhum navItem visível como texto', () => {
    renderSidebar([ITEM_BASE], { defaultCollapsed: true });

    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
  });

  it('recolhida: o sino NUNCA desmonta — antes o poll parava ao recolher (F17); aqui o botão nunca some entre os dois modos', () => {
    const { rerender } = renderSidebar([ITEM_BASE], { defaultCollapsed: false });
    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <AppSidebar navItems={[ITEM_BASE]} userName="Test User" defaultCollapsed />
      </MemoryRouter>,
    );
    // `defaultCollapsed` só afeta o estado INICIAL (o componente tem seu próprio `isCollapsed`
    // interno) — o que este teste prova é que o mesmo `<button>` (mesmo testid) segue montado,
    // não que o toggle interno reage a prop; a prova de toggle real é o botão de expandir/recolher.
    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
  });

  it('clicar no toggle de recolher NÃO desmonta o sino (prova real do F17, via o próprio toggle da sidebar)', () => {
    renderSidebar([ITEM_BASE]);
    const bellBefore = screen.getByTestId('notification-bell-btn');
    expect(bellBefore).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Recolher menu'));

    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
  });
});
