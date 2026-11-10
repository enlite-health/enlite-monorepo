import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AreaSwitcherSlot } from '../AreaSwitcherSlot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ user: { id: 'uid-1' } }) }));
vi.mock('@presentation/hooks/useAreaDestination', () => ({
  areaKey: (e: { area: string; role: string }) => `${e.area}:${e.role}`,
  writeLastArea: vi.fn(),
}));
// Função simples (não `vi.fn`) como implementação: o spy do vitest re-lança a rejeição no ramo que ele mesmo
// observa, e isso vira "unhandled error" mesmo com o `.catch` do componente.
let chamadas = 0;
let impl: () => Promise<unknown> = async () => ({ areas: [], tokenRefreshRequired: false });
const getMyAreas = { calls: () => chamadas };
vi.mock('@infrastructure/http/AreasApiService', () => ({
  AreasApiService: { getMyAreas: () => { chamadas += 1; return impl(); } },
}));

const montar = () => render(<MemoryRouter><AreaSwitcherSlot /></MemoryRouter>);

describe('AreaSwitcherSlot', () => {
  beforeEach(() => { chamadas = 0; });

  it('> 1 área navegável: a tira aparece depois da carga', async () => {
    impl = async () => ({
      areas: [
        { area: 'backoffice', role: 'staff', entryRoute: '/admin' },
        { area: 'care', role: 'worker', entryRoute: '/' },
      ],
      tokenRefreshRequired: false,
    });
    montar();
    expect(await screen.findByTestId('area-switcher-strip')).toBeInTheDocument();
  });

  it('1 área: nada aparece', async () => {
    impl = async () => ({ areas: [{ area: 'backoffice', role: 'staff', entryRoute: '/admin' }], tokenRefreshRequired: false });
    montar();
    await waitFor(() => expect(getMyAreas.calls()).toBe(1));
    expect(screen.queryByTestId('area-switcher-strip')).not.toBeInTheDocument();
  });

  it('a chamada falha: nada aparece e nada quebra', async () => {
    impl = async () => { throw new Error('HTTP 500'); };
    montar();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getMyAreas.calls()).toBe(1);
    expect(screen.queryByTestId('area-switcher-strip')).not.toBeInTheDocument();
  });
});
