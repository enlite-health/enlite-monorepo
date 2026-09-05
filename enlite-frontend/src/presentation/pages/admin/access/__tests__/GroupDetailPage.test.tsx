import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupDetailPage } from '../GroupDetailPage';
import { ApiError } from '@infrastructure/http/ApiError';
import { postura, renderRota, GRUPO, MEMBRO, CATALOGO } from './helpers';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

// o mock devolve a CHAVE; quando há interpolação, cola os valores no fim — é o
// que torna o contador de células verificável pelo NÚMERO, não pela chave.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: unknown) => (o !== null && typeof o === 'object'
      ? `${k} ${Object.values(o as Record<string, unknown>).map(String).join(' ')}`
      : k),
  }),
}));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = {
  getGroup: vi.fn(), listMembers: vi.fn(), getCatalog: vi.fn(), updateGroup: vi.fn(), archiveGroup: vi.fn(),
  setGroupPermissions: vi.fn(), grantCountry: vi.fn(), revokeCountry: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(),
};
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, ReturnType<typeof vi.fn>>)[k](...a) }),
}));
const listAdmins = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { listAdmins: (...a: unknown[]) => listAdmins(...a) } }));

/** `.at(-1)` não existe no `lib` deste tsconfig. */
const ultimo = <T,>(xs: T[]): T => xs[xs.length - 1];

/** O nome/descrição só viram input depois do clique no lápis (pedido do Gabriel). */
const abrirLapis = async (id: 'g-name' | 'g-desc'): Promise<HTMLElement> => {
  await userEvent.click(await screen.findByTestId(`${id}-editar`));
  return screen.getByLabelText(id === 'g-name' ? 'admin.access.groups.name' : 'admin.access.groups.description');
};

const ROTA = `/admin/access/groups/${GRUPO.id}`;
const PATTERN = '/admin/access/groups/:id';

describe('GroupDetailPage — a regra por componente', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset();
    api.getGroup.mockResolvedValue(GRUPO);
    api.listMembers.mockResolvedValue([MEMBRO]);
    api.getCatalog.mockResolvedValue(CATALOGO);
    listAdmins.mockReset().mockResolvedValue({ admins: [
      { firebaseUid: 'uid-maria', email: 'maria@enlite.health' },
      { firebaseUid: 'uid-joao', email: 'joao@enlite.health' },
    ], total: 2 });
  });

  it('🔴 hidden: nem carrega o grupo — redireciona', async () => {
    postura('hidden');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(api.getGroup).not.toHaveBeenCalled();
  });

  it('read: campos são TEXTO (sem input), células são lista, e NENHUM botão de conclusão existe', async () => {
    postura('read');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // a lista de chips virou MATRIZ recurso × ação: a célula existe como coluna
    // marcada na linha do recurso, com a descrição no rótulo acessível.
    expect(screen.getByTestId('cell-matrix')).toBeInTheDocument();
    expect(screen.getByLabelText(/^worker:read/)).toHaveTextContent('✓');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    for (const nome of ['admin.access.group.archive', 'admin.access.group.cellsSave',
      'admin.access.group.addMember', 'admin.access.group.remove', 'admin.access.group.grant', 'admin.access.group.revoke']) {
      expect(screen.queryByRole('button', { name: nome })).not.toBeInTheDocument();
    }
    // e a lista de candidatos a membro nem foi buscada
    expect(listAdmins).not.toHaveBeenCalled();
    // o membro aparece (leitura), com e-mail
    expect(screen.getByText('maria@enlite.health')).toBeInTheDocument();
  });

  it('write: o lápis existe, checkboxes por célula, e cada ação de conclusão existe', async () => {
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    // em `write` o campo é texto COM lápis; o input só nasce ao clicar nele
    expect(await screen.findByTestId('g-name-readonly')).toHaveTextContent('Recrutadores AR');
    expect(screen.getByTestId('g-name-editar')).toBeInTheDocument();
    // o único textbox da tela é o motivo do país; o nome só vira input no lápis
    expect(document.querySelector('#g-name')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /^worker:read/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^worker:write/ })).not.toBeChecked();
    for (const nome of ['admin.access.group.archive', 'admin.access.group.cellsSave']) {
      expect(screen.getByRole('button', { name: nome })).toBeInTheDocument();
    }
    // Membros: as duas setas existem e nascem MORTAS — sem ninguém marcado,
    // nenhuma das duas tem o que mover.
    for (const seta of ['admin.access.group.transfer.toMembers', 'admin.access.group.transfer.toRest']) {
      expect(screen.getByRole('button', { name: seta })).toBeDisabled();
    }
    // e `Guardar` não existe em repouso: o da transferência só nasce com
    // mudança pendente, e o da identidade só existe com o campo aberto no lápis
    expect(screen.queryByRole('button', { name: 'admin.access.group.save' })).not.toBeInTheDocument();
  });

  it('write: salvar células manda o conjunto INTEIRO, ordenado, com o motivo', async () => {
    postura('write');
    api.setGroupPermissions.mockResolvedValue({ cells: 3 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:write/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.cellsSave' }));
    await waitFor(() => expect(api.setGroupPermissions).toHaveBeenCalledWith(GRUPO.id, ['funnel:read', 'worker:read', 'worker:write'], null));
  });

  it('write: arquivar pede confirmação, e só então chama a API e volta à lista', async () => {
    postura('write');
    api.archiveGroup.mockResolvedValue({ affectedMembers: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archive' }));
    expect(api.archiveGroup).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByTestId('archive-confirm')).getByRole('button', { name: 'admin.access.group.archiveYes' }));
    await waitFor(() => expect(api.archiveGroup).toHaveBeenCalledWith(GRUPO.id));
    expect(await screen.findByTestId('access-home')).toBeInTheDocument();
  });

  it('🔴 409 last_manager vira a mensagem específica — não um erro genérico', async () => {
    postura('write');
    api.removeMember.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'last_manager' }, 409));
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    const membros = screen.getByRole('listbox', { name: 'admin.access.group.membersTitle' });
    await userEvent.click(within(membros).getByRole('option', { name: /maria@enlite\.health/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.transfer.toRest' }));
    await userEvent.click(ultimo(screen.getAllByRole('button', { name: 'admin.access.group.save' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.lastManager');
  });

  it('write: adicionar membro oferece só quem ainda não é membro', async () => {
    postura('write');
    api.addMember.mockResolvedValue({ membershipId: 'm2' });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    const resto = await screen.findByRole('listbox', { name: 'admin.access.group.transfer.rest' });
    const fora = within(resto).getAllByRole('option').map((o) => o.textContent);
    expect(fora.join(' ')).toContain('joao@enlite.health');
    expect(fora.join(' ')).not.toContain('maria@enlite.health');
    // maria está do outro lado, e só do outro lado
    const membros = screen.getByRole('listbox', { name: 'admin.access.group.membersTitle' });
    expect(within(membros).getAllByRole('option').map((o) => o.textContent).join(' ')).toContain('maria@enlite.health');

    await userEvent.click(within(resto).getByRole('option', { name: /joao@enlite\.health/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.transfer.toMembers' }));
    await userEvent.click(ultimo(screen.getAllByRole('button', { name: 'admin.access.group.save' })));
    await waitFor(() => expect(api.addMember).toHaveBeenCalledWith(GRUPO.id, 'uid-joao'));
  });

  it('grupo de SISTEMA: mesmo em write, nome/descrição são texto e não há arquivar', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, isSystem: true });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('button', { name: 'admin.access.group.archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.access.group.save' })).not.toBeInTheDocument();
  });

  it('404: diz que não achou e oferece voltar', async () => {
    postura('read');
    api.getGroup.mockRejectedValue(new ApiError({ success: false, error: 'Not found' }, 404));
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.group.notFound');
  });

  it('lex C1: o e-mail de staff vive DENTRO de `data-clarity-mask` — nas duas posturas', async () => {
    // A régua não é "existe um elemento mascarado", é "o e-mail está dentro de
    // um". A tabela virou colunas; o que não pode mudar é a máscara em volta.
    for (const nivel of ['read', 'write'] as const) {
      postura(nivel);
      const { unmount } = renderRota(<GroupDetailPage />, ROTA, PATTERN);
      const email = await screen.findByText('maria@enlite.health');
      expect(email.closest('[data-clarity-mask="True"]')).not.toBeNull();
      unmount();
    }
  });

  it('write: salvar identidade manda nome/descrição aparados; descrição vazia vira null', async () => {
    postura('write');
    api.updateGroup.mockResolvedValue(undefined);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    const nome = await abrirLapis('g-name');
    await userEvent.clear(nome); await userEvent.type(nome, '  Novo nome ');
    const desc = await abrirLapis('g-desc');
    await userEvent.clear(desc);
    // cada campo confirma o SEU — não há mais um Guardar global da identidade
    await userEvent.click(screen.getByTestId('g-desc-confirmar'));
    await waitFor(() => expect(api.updateGroup).toHaveBeenCalledWith(GRUPO.id, { name: 'Novo nome', description: null }));
    expect(await screen.findByRole('status')).toHaveTextContent('admin.access.group.saved');
  });

  it('🔒 o PAÍS é o botão — sem "Conceder" ao lado; clicar concede, clicar de novo revoga', async () => {
    // pedido do Gabriel (05/09). O estado é o próprio botão: `aria-pressed`
    // diz se o grupo alcança aquele país, e não há um segundo controle.
    postura('write');
    api.grantCountry.mockResolvedValue({ scopeId: 's' });
    api.revokeCountry.mockResolvedValue({ revoked: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('button', { name: 'admin.access.group.grant' })).not.toBeInTheDocument();

    const br = screen.getByRole('button', { name: /^countries\.BR/ });
    const ar = screen.getByRole('button', { name: /^countries\.AR/ });
    expect(br).toHaveAttribute('aria-pressed', 'false');
    expect(ar).toHaveAttribute('aria-pressed', 'true');
    // os dois respondem ao clique: não há mais motivo a preencher antes
    expect(br).toBeEnabled();
    expect(ar).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /^countries\.BR/ }));
    await waitFor(() => expect(api.grantCountry).toHaveBeenCalledWith(GRUPO.id, 'BR'));
    await userEvent.click(screen.getByRole('button', { name: /^countries\.AR/ }));
    await waitFor(() => expect(api.revokeCountry).toHaveBeenCalledWith(GRUPO.id, 'AR'));
  });

  it('write: "Não" no arquivamento fecha a confirmação sem chamar a API', async () => {
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archive' }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.archiveNo' }));
    expect(screen.queryByTestId('archive-confirm')).not.toBeInTheDocument();
    expect(api.archiveGroup).not.toHaveBeenCalled();
  });

  it('sem membros, sem células e sem países: os três vazios aparecem em read', async () => {
    postura('read');
    api.getGroup.mockResolvedValue({ ...GRUPO, cells: [], countries: [] });
    api.listMembers.mockResolvedValue([]);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByText('admin.access.group.noMembers')).toBeInTheDocument();
    // o vazio de células virou o contador em zero, na linha do título
    expect(screen.getByText('admin.access.group.cells.selected 0')).toBeInTheDocument();
    expect(screen.getByText('admin.access.group.noCountries')).toBeInTheDocument();
  });

  it('🔒 NENHUM campo de motivo sobrou na tela', async () => {
    // "Motivo del cambio ainda existe? PRA QUE?" e "não faz sentido o Motivo do
    // país. Ninguém faz um grupo e coloca motivo por ser apenas de um país ou
    // dos dois" (Gabriel, 05/09). O das células o servidor já aceitava nulo; o
    // do país saiu com a mig 412, que tirou a exigência das três camadas.
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(document.querySelector('#cells-reason')).toBeNull();
    expect(document.querySelector('#country-reason')).toBeNull();
    // e nas duas seções que tinham motivo não sobrou campo de texto nenhum
    // (o filtro de membros continua, e é legítimo — não é motivo)
    for (const sec of ['sec-countries', 'sec-cells']) {
      const secao = document.querySelector(`section[aria-labelledby="${sec}"]`);
      expect(secao?.querySelector('input[type="text"], input:not([type]), textarea')).toBeNull();
    }
  });

  it('🔒 Países vem DEPOIS das informações do grupo, e o nome sai por extenso', async () => {
    // correção do Gabriel (05/09): eu tinha posto Países em primeiro, e ele
    // aparecia ACIMA do nome do grupo — não dava para saber de que grupo era.
    postura('read');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    const secoes = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby'));
    // Países vem DEPOIS das informações do grupo (correção do Gabriel, 05/09):
    // antes ele aparecia acima do nome, e não dava para saber de que grupo era.
    expect(secoes[0]).toBe('sec-id');
    expect(secoes[1]).toBe('sec-countries');
    // GRUPO tem countries: ['AR'] — o mock de i18n devolve a chave, então o
    // extenso se prova pela CHAVE consultada, não pela sigla crua
    // em `read` o país é TEXTO — botão desabilitado sumiria (ActionButton esconde)
    expect(screen.getByText(/^countries\.AR ✓$/)).toBeInTheDocument();
  });

  it('🔒 os campos desta tela são `compact`, não o default de 60px', async () => {
    // pedido do Gabriel (05/09): os inputs dominavam a página. O `default`
    // (h-[60px]/text-[20px]) é compartilhado com o app inteiro e NÃO muda —
    // quem muda é esta tela, para o tamanho já estabelecido na casa.
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    const nome = await abrirLapis('g-name');
    expect(nome).toHaveClass('h-12');
    expect(nome).not.toHaveClass('h-[60px]');
  });

  it('🔒 o lápis abre, o Cancelar descarta o rascunho e o Esc fecha', async () => {
    // pedido do Gabriel (05/09): texto com lápis ao lado; só quem clica vê input.
    postura('write');
    api.updateGroup.mockResolvedValue(undefined);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');

    const nome = await abrirLapis('g-name');
    await userEvent.clear(nome);
    await userEvent.type(nome, 'rascunho jogado fora');
    await userEvent.click(screen.getByTestId('g-name-cancelar'));
    // fechou, NÃO salvou, e o texto voltou ao valor do servidor
    expect(document.querySelector('#g-name')).toBeNull();
    expect(api.updateGroup).not.toHaveBeenCalled();
    expect(screen.getByTestId('g-name-readonly')).toHaveTextContent('Recrutadores AR');

    // e o Esc faz o mesmo — quem abriu pelo teclado precisa sair por ele
    await abrirLapis('g-name');
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('#g-name')).toBeNull();

    // a descrição descarta igual: cada campo tem o seu rascunho
    const desc = await abrirLapis('g-desc');
    await userEvent.type(desc, 'também jogado fora');
    await userEvent.click(screen.getByTestId('g-desc-cancelar'));
    expect(document.querySelector('#g-desc')).toBeNull();
    expect(api.updateGroup).not.toHaveBeenCalled();
    expect(screen.getByTestId('g-desc-readonly')).toHaveTextContent('Quem recruta na Argentina');
  });

  it('🔒 Enter confirma no nome, mas NÃO na descrição — lá ele é quebra de linha', async () => {
    postura('write');
    api.updateGroup.mockResolvedValue(undefined);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');

    const nome = await abrirLapis('g-name');
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Nome pelo teclado{Enter}');
    await waitFor(() => expect(api.updateGroup).toHaveBeenCalledWith(GRUPO.id, expect.objectContaining({ name: 'Nome pelo teclado' })));

    api.updateGroup.mockClear();
    const desc = await abrirLapis('g-desc');
    await userEvent.type(desc, 'linha 1{Enter}linha 2');
    // Enter no textarea escreve, não salva — senão descrição de várias linhas
    // seria impossível
    expect(api.updateGroup).not.toHaveBeenCalled();
    expect((desc as HTMLTextAreaElement).value).toContain('linha 1\nlinha 2');
  });

  it('grupo com descrição NULA: o campo abre vazio e o texto digitado é salvo', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, description: null });
    api.updateGroup.mockResolvedValue(undefined);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByTestId('g-desc-readonly')).toHaveTextContent('—');
    // cancelar com descrição NULA volta para vazio, não para "null"
    let desc = await abrirLapis('g-desc');
    expect(desc).toHaveValue('');
    await userEvent.type(desc, 'rascunho');
    await userEvent.click(screen.getByTestId('g-desc-cancelar'));
    desc = await abrirLapis('g-desc');
    expect(desc).toHaveValue('');
    await userEvent.type(desc, 'agora tem');
    await userEvent.click(screen.getByTestId('g-desc-confirmar'));
    await waitFor(() => expect(api.updateGroup).toHaveBeenCalledWith(GRUPO.id, { name: 'Recrutadores AR', description: 'agora tem' }));
  });

  it('🔒 SEM catálogo o contador não sai — "0" ali seria mentira sobre acesso', async () => {
    // o grupo TEM células no banco; o que falta é o catálogo. Dizer
    // "Seleccionadas: 0" logo acima de "o sync não rodou" afirmaria que este
    // grupo não dá acesso a nada. (gate `revisao-pr`, 05/09)
    postura('write');
    api.getCatalog.mockResolvedValue([]);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByText('admin.access.group.cells.empty')).toBeInTheDocument();
    expect(screen.queryByText(/^admin\.access\.group\.cells\.selected/)).not.toBeInTheDocument();
  });

  it('🔒 o contador da linha do título conta as células marcadas, e acompanha o clique', async () => {
    postura('write');
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    // GRUPO tem worker:read e funnel:read, ambos no catálogo
    expect(await screen.findByText('admin.access.group.cells.selected 2')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/^worker:write/));
    expect(screen.getByText('admin.access.group.cells.selected 3')).toBeInTheDocument();
    // `Ver` agora está TRAVADA por `Crear y editar` — o clique não passa
    await userEvent.click(screen.getByLabelText(/^worker:read/));
    expect(screen.getByText('admin.access.group.cells.selected 3')).toBeInTheDocument();
    // tirando quem exigia, ela solta e volta a responder
    await userEvent.click(screen.getByLabelText(/^worker:write/));
    await userEvent.click(screen.getByLabelText(/^worker:read/));
    expect(screen.getByText('admin.access.group.cells.selected 1')).toBeInTheDocument();
  });

  it('🔒 marcar Crear y editar marca Ver junto, e trava com o motivo à mostra', async () => {
    // item 2 do Gabriel (05/09): "se eu tenho Crear y editar também preciso ter
    // ver". A trava não pode ser muda — caixa que não responde ao clique lê como
    // "marcada e proibida" (NN/g), então ela DIZ quem a exige.
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, cells: [] });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    const ver = await screen.findByLabelText(/^worker:read/);
    expect(ver).not.toBeChecked();
    await userEvent.click(screen.getByLabelText(/^worker:write/));
    expect(screen.getByLabelText(/^worker:read/)).toBeChecked();
    // lê o LOCALE REAL: procurar pela chave casaria com a chave crua, que é
    // exatamente o defeito (a string estava gravada noutro caminho e o teste
    // aprovava o tooltip quebrado). Achado do gate, 05/09.
    // OS DOIS locales: o gate provou que guardar só o es.json deixava o mesmo
    // defeito passar verde no pt-BR — meia régua não é régua.
    for (const loc of [es, ptBR]) expect(loc.admin.access.group.cells.lockedBy).toBeTruthy();
    expect(screen.getByLabelText(/admin\.access\.group\.cells\.lockedBy/)).toBeDisabled();
  });

  it('grupo ARQUIVADO: mesmo em write vira só leitura, e a lista de candidatos ainda é buscada só por write', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, archivedAt: '2026-08-01T00:00:00Z' });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(screen.queryByRole('button', { name: 'admin.access.group.archive' })).not.toBeInTheDocument();
    expect(screen.getByText(/admin.access.groups.archived/)).toBeInTheDocument();
  });

  it('membro sem e-mail/papel/status mostra o uid e travessões', async () => {
    postura('read');
    api.listMembers.mockResolvedValue([{ ...MEMBRO, email: null, role: null, status: null }]);
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    expect(await screen.findByText('uid-maria')).toBeInTheDocument();
  });

  it('write: descrição nula vira campo vazio; desmarcar célula tira do conjunto; motivo vazio vira null', async () => {
    postura('write');
    api.getGroup.mockResolvedValue({ ...GRUPO, description: null });
    api.setGroupPermissions.mockResolvedValue({ cells: 1 });
    renderRota(<GroupDetailPage />, ROTA, PATTERN);
    await screen.findByTestId('g-name-readonly');
    expect(await abrirLapis('g-desc')).toHaveValue('');
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:read/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.cellsSave' }));
    await waitFor(() => expect(api.setGroupPermissions).toHaveBeenCalledWith(GRUPO.id, ['funnel:read'], null));
  });
});
