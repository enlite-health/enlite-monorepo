/**
 * MyProfilePage — /admin/mi-cuenta: seções na ordem, Tactiq gateado pela célula, extensão ausente = "sin información",
 * linha do Google só com provider google.com, foto da sessão (nunca do backend) e sair. i18n real (es). Dados fictícios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const api = vi.hoisted(() => ({ getOwnTactiqLink: vi.fn(), startTactiqLink: vi.fn() }));
vi.mock('@infrastructure/http/AdminAdmissionApiService', () => ({ AdminAdmissionApiService: api }));
vi.mock('@presentation/components/features/access/GroupSimulationSelect', () => ({ GroupSimulationSelect: () => null }));

import MyProfilePage from '../MyProfilePage';

const authz = (permissions: string[], enforcement: 'on' | 'off' = 'on'): AuthzContract => ({
  uid: 'u1', tenantId: 't1', status: 'ACTIVE', permissions, countries: ['AR'],
  groups: [{ id: 'g1', name: 'Equipo Ejemplo' }, { id: 'g2', name: 'Acceso Master' }], features: {}, enforcement,
});
const TACTIQ_CELLS = ['own_tactiq_link:read', 'own_tactiq_link:create'];
const link = (extra: Record<string, unknown> = {}) => ({ status: 'linked', linkedAt: '2026-10-02T14:30:00.000Z', lastCheckAt: '2026-10-11T09:05:00.000Z', statusChangedAt: null, ...extra });

const logout = vi.fn();
function seed(over: { providers?: string[]; photoUrl?: string | null; cells?: string[] } = {}) {
  useAdminAuthStore.setState({
    logout,
    user: { id: 'u1', email: 'exemplo@enlite.test', name: 'Usuária Exemplo', roles: [], createdAt: new Date(), updatedAt: new Date(), photoUrl: over.photoUrl ?? null, authProviders: over.providers ?? ['google.com'] },
    adminProfile: { firebaseUid: 'u1', email: 'exemplo@enlite.test', displayName: 'Usuária Exemplo', department: null, lastLoginAt: '2026-10-11T08:45:00.000Z', loginCount: 3, createdAt: '2026-01-10T10:00:00.000Z' },
    authz: authz(over.cells ?? TACTIQ_CELLS),
    authzStatus: 'ready',
  });
}
const renderPage = () => render(<MemoryRouter initialEntries={['/admin/mi-cuenta']}><MyProfilePage /></MemoryRouter>);

beforeEach(async () => {
  Object.values(api).forEach((m) => m.mockReset());
  logout.mockReset();
  await i18n.changeLanguage('es');
});
afterEach(() => useAdminAuthStore.setState({ user: null, adminProfile: null, authz: null, authzStatus: 'idle' }));

describe('estrutura', () => {
  it('as seções vêm na ordem Identidad · Tactiq · Idioma · Mis accesos (e o "Cerrar sesión" mora na Identidad)', async () => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link());
    renderPage();
    await screen.findByTestId('tactiq-state');
    const titulos = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titulos).toEqual(['Identidad', 'Tactiq', 'Idioma', 'Mis accesos']);
    expect(within(screen.getByTestId('profile-identity')).getByTestId('profile-logout')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-session')).not.toBeInTheDocument();
  });

  it('sem a célula own_tactiq_link:read a seção Tactiq NÃO existe e nenhuma chamada ao vínculo sai', () => {
    seed({ cells: ['patient:read'] });
    renderPage();
    expect(screen.queryByTestId('tactiq-link-page')).not.toBeInTheDocument();
    expect(api.getOwnTactiqLink).not.toHaveBeenCalled();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Identidad', 'Idioma', 'Mis accesos']);
  });

  it('Mis accesos mostra grupos e países do authz, sem lista crua de células', () => {
    seed({ cells: ['patient:read'] });
    renderPage();
    expect(screen.getByTestId('profile-group-g1')).toHaveTextContent('Equipo Ejemplo');
    expect(screen.getByTestId('profile-country-AR')).toHaveTextContent('Argentina');
    expect(document.body.textContent).not.toContain('patient:read');
  });

  it('"Cerrar sesión" chama o logout da store', async () => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link());
    renderPage();
    fireEvent.click(screen.getByTestId('profile-logout'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});

describe('extensão do Chrome (contrato do PR #685: sem_relatorio | ausente | desativada | instalada)', () => {
  it.each([
    ['instalada', 'Instalada'],
    ['ausente', 'No instalada'],
    ['desativada', 'Desactivada'],
    ['sem_relatorio', 'Sin información'],
  ])('%s → "%s"', async (state, texto) => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link({ extension: { state, reportedAt: state === 'instalada' ? '2026-10-11T09:00:00.000Z' : null } }));
    renderPage();
    expect(await screen.findByTestId('tactiq-extension-state')).toHaveTextContent(texto);
  });

  it('campo `extension` AUSENTE (back antigo) é tratado como sem relatório — a tela não quebra', async () => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link());
    renderPage();
    expect(await screen.findByTestId('tactiq-extension-state')).toHaveTextContent('Sin información');
    expect(screen.queryByTestId('tactiq-extension-reported')).not.toBeInTheDocument();
  });

  it('estado desconhecido (back mais novo que o front) também cai em sem relatório', async () => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link({ extension: { state: 'bloqueada', reportedAt: null } }));
    renderPage();
    expect(await screen.findByTestId('tactiq-extension-state')).toHaveTextContent('Sin información');
  });

  it('com relatório, "Último reporte" aparece como par rótulo/valor', async () => {
    seed();
    api.getOwnTactiqLink.mockResolvedValue(link({ extension: { state: 'instalada', reportedAt: '2026-10-11T09:00:00.000Z' } }));
    renderPage();
    expect(await screen.findByTestId('tactiq-extension-reported')).toHaveTextContent(/11 oct/i);
  });
});

describe('conta Google: linha "nombre y foto vienen de Google" e foto da sessão', () => {
  it('com provider google.com: a linha aparece, com link externo seguro para a conta Google', () => {
    seed({ cells: ['patient:read'], providers: ['google.com'] });
    renderPage();
    const a = screen.getByTestId('profile-google-link');
    expect(a).toHaveAttribute('href', 'https://myaccount.google.com/personal-info');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a).toHaveTextContent('Cambiar en Google');
  });

  it('sem provider google.com (e-mail/senha): a linha NÃO aparece', () => {
    seed({ cells: ['patient:read'], providers: ['password'] });
    renderPage();
    expect(screen.queryByTestId('profile-google-note')).not.toBeInTheDocument();
  });

  it('foto da sessão: <img> sem alt e com no-referrer; se falhar ao carregar, cai nas iniciais', () => {
    seed({ cells: ['patient:read'], photoUrl: 'data:image/png;base64,AAAA' });
    renderPage();
    const img = screen.getByTestId('profile-photo');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(img);
    expect(screen.queryByTestId('profile-photo')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-avatar')).toHaveTextContent('UE');
  });

  it('sem foto: iniciais de 2 letras', () => {
    seed({ cells: ['patient:read'] });
    renderPage();
    expect(screen.getByTestId('profile-avatar')).toHaveTextContent('UE');
  });
});
