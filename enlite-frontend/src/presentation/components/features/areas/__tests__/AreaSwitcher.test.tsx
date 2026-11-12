import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AreaSwitcher } from '../AreaSwitcher';
import type { AreaEntry } from '@domain/entities/MyAreas';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

const writeLastArea = vi.fn();
vi.mock('@presentation/hooks/useAreaDestination', () => ({
  areaKey: (e: { area: string; role: string }) => `${e.area}:${e.role}`,
  writeLastArea: (...a: unknown[]) => writeLastArea(...a),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const BACKOFFICE: AreaEntry = { area: 'backoffice', role: 'staff', entryRoute: '/admin' };
const CARE: AreaEntry = { area: 'care', role: 'worker', entryRoute: '/' };
const LEARN_SOON: AreaEntry = { area: 'learn', role: 'learner', entryRoute: null };

function montar(areas: AreaEntry[]) {
  return render(
    <MemoryRouter>
      <AreaSwitcher areas={areas} currentArea="backoffice" uid="uid-1" />
    </MemoryRouter>,
  );
}

describe('AreaSwitcher — tira do AdminLayout, só com > 1 área navegável', () => {
  beforeEach(() => {
    writeLastArea.mockClear();
    navigate.mockClear();
  });

  it('1 área: não renderiza nada', () => {
    const { container } = montar([BACKOFFICE]);
    expect(container).toBeEmptyDOMElement();
  });

  it('2 áreas, mas só 1 navegável (a outra com entryRoute null): não renderiza', () => {
    const { container } = montar([BACKOFFICE, LEARN_SOON]);
    expect(container).toBeEmptyDOMElement();
  });

  it('0 áreas: não renderiza', () => {
    const { container } = montar([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('> 1 navegável: mostra a tira com a área atual e o menu fechado', () => {
    montar([BACKOFFICE, CARE]);
    expect(screen.getByTestId('area-switcher-strip')).toBeInTheDocument();
    expect(screen.getByTestId('area-switcher-trigger')).toHaveTextContent('backoffice · staff');
    expect(screen.queryByTestId('area-switcher-menu')).not.toBeInTheDocument();
  });

  it('trocar de área grava a última usada (por uid) e navega à entryRoute', async () => {
    montar([BACKOFFICE, CARE]);
    await userEvent.click(screen.getByTestId('area-switcher-trigger'));
    await userEvent.click(screen.getByTestId('area-switcher-option-care'));
    expect(writeLastArea).toHaveBeenCalledWith('uid-1', 'care:worker');
    expect(navigate).toHaveBeenCalledWith('/');
    expect(screen.queryByTestId('area-switcher-menu')).not.toBeInTheDocument();
  });

  it('escolher a área atual não grava nem navega', async () => {
    montar([BACKOFFICE, CARE]);
    await userEvent.click(screen.getByTestId('area-switcher-trigger'));
    await userEvent.click(screen.getByTestId('area-switcher-option-backoffice'));
    expect(writeLastArea).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('área não navegável aparece desativada com "Próximamente" e não navega', async () => {
    montar([BACKOFFICE, CARE, LEARN_SOON]);
    await userEvent.click(screen.getByTestId('area-switcher-trigger'));
    const opt = screen.getByTestId('area-switcher-option-learn');
    expect(opt).toBeDisabled();
    expect(opt).toHaveTextContent('areas.switcher.comingSoon');
    await userEvent.click(opt);
    expect(navigate).not.toHaveBeenCalled();
    expect(writeLastArea).not.toHaveBeenCalled();
  });

  it('Escape fecha o menu', async () => {
    montar([BACKOFFICE, CARE]);
    await userEvent.click(screen.getByTestId('area-switcher-trigger'));
    expect(screen.getByTestId('area-switcher-menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('area-switcher-menu')).not.toBeInTheDocument();
  });
});
