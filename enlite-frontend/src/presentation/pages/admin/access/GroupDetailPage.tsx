import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AdminPermissionsApiService,
  type CatalogCategory,
  type GroupMember,
  type PermissionGroupDetail,
} from '@infrastructure/http/AdminPermissionsApiService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { AdminUser } from '@domain/entities/AdminUser';
import { Heading, Text, Input, Textarea } from '@presentation/components/atoms';
import {
  ActionButton,
  CampoEditavel,
  PanelErrorAlert,
  MemberTransfer,
  ScreenTree,
  cellDiff,
  contaSelecionadas,
  alternaCelula,
  type TransferPerson,
} from '@presentation/components/features/access';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { AccessGate, PANEL_RESOURCE } from './AccessGate';
import { panelErrorKey } from './panelErrors';

const COUNTRIES = ['AR', 'BR'] as const;

/**
 * `/admin/access/groups/:id` — o grupo por inteiro: nome/descrição, células,
 * países, membros e o arquivamento.
 *
 * A postura vem de `useCellAccess(PANEL_RESOURCE)`: sem `:write` o lápis de
 * nome/descrição não sai, os botões de país viram texto, e as checkboxes de
 * célula viram lista (D269 — "esconder, não desabilitar").
 *
 * Nome e descrição usam `CampoEditavel` (texto + lápis) desde 05/09; o
 * `ReadOnlyField` continua para quem decide texto×input pela POSTURA.
 */
export function GroupDetailPage(): JSX.Element {
  return (
    <AccessGate>
      <GroupDetail />
    </AccessGate>
  );
}

function GroupDetail(): JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canWrite } = useCellAccess(PANEL_RESOURCE);

  const [group, setGroup] = useState<PermissionGroupDetail | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [catalog, setCatalog] = useState<CatalogCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Edição local — só existe em `write`; em `read` os campos são texto.
  const [form, setForm] = useState({ name: '', description: '' });
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [candidates, setCandidates] = useState<AdminUser[]>([]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [g, m, c] = await Promise.all([
        AdminPermissionsApiService.getGroup(id),
        AdminPermissionsApiService.listMembers(id),
        AdminPermissionsApiService.getCatalog(),
      ]);
      setGroup(g);
      setMembers(m);
      setCatalog(c);
      setForm({ name: g.name, description: g.description ?? '' });
      setCells(new Set(g.cells));
    } catch (err) {
      setError(panelErrorKey(err));
    } finally {
      setIsLoading(false);
    }
  // `t` fora das deps de propósito: guardamos a CHAVE e traduzimos no render.
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // A coluna "Resto del equipo" só é buscada em `write` — em `read` ela não
  // existe (quem não pode editar não tem o que fazer com quem está fora), e
  // buscar seria uma leitura sem propósito.
  useEffect(() => {
    if (!canWrite) return;
    AdminApiService.listAdmins(200, 0)
      .then((r) => setCandidates(r.admins))
      .catch(() => setCandidates([]));
  }, [canWrite]);

  /**
   * O universo da transferência. O membro entra pelo que a API de membros sabe
   * dele; `candidates` sobrescreve porque só ela traz `displayName` — e o card
   * mostra o NOME, não o e-mail cru. Em `read`, `candidates` está vazio e
   * sobram só os membros, que é exatamente o que aquela vista mostra.
   */
  const people = useMemo<TransferPerson[]>(() => {
    const porUid = new Map<string, TransferPerson>();
    for (const m of members) {
      porUid.set(m.userId, { userId: m.userId, name: null, email: m.email ?? m.userId });
    }
    for (const u of candidates) {
      porUid.set(u.firebaseUid, { userId: u.firebaseUid, name: u.displayName, email: u.email });
    }
    return [...porUid.values()];
  }, [members, candidates]);

  const diffCelulas = useMemo(
    () => cellDiff(group?.cells ?? [], cells),
    [group?.cells, cells],
  );

  /**
   * O PUT manda nome E descrição juntos, então confirmar um campo precisa
   * mandar o outro — mas o outro vem do SERVIDOR, não do formulário.
   *
   * Antes vinha do `form`, e por isso confirmar a descrição levava junto um
   * nome que a pessoa tinha digitado no lápis e NÃO confirmado. É a mesma
   * classe do drawer clínico que apaga campo não editado — e o meu teste
   * travava esse comportamento como se fosse o correto (achado do gate, 05/09).
   */
  const salvarCampo = (campo: 'name' | 'description'): Promise<boolean> => run(
    () => AdminPermissionsApiService.updateGroup(group!.id, {
      name: campo === 'name' ? form.name.trim() : group!.name,
      description: campo === 'description'
        ? (form.description.trim() || null)
        : (group!.description ?? null),
    }),
  );

  /** Devolve se a ação DEU CERTO — quem chama precisa saber para não fechar
   *  um campo cujo save o servidor recusou. */
  async function run(acao: () => Promise<unknown>, okKey = 'admin.access.group.saved'): Promise<boolean> {
    setError(null);
    setNotice(null);
    try {
      await acao();
      setNotice(okKey);
      await load();
      return true;
    } catch (err) {
      setError(panelErrorKey(err));
      return false;
    }
  }

  if (isLoading) return <Text size="sm" color="secondary">…</Text>;
  if (!group) {
    return (
      <div className="space-y-3">
        <PanelErrorAlert keyName={error} />
        <Link to="/admin/access" className="text-blue-600 hover:underline text-sm">{t('admin.access.group.back')}</Link>
      </div>
    );
  }

  const editable = canWrite && !group.isSystem && !group.archivedAt;

  return (
    <div className="space-y-8">
      <Link to="/admin/access" className="text-blue-600 hover:underline text-sm">← {t('admin.access.group.back')}</Link>

      <PanelErrorAlert keyName={error} />
      {notice && (
        <div className="bg-green-50 border border-green-200 px-4 py-2 rounded-lg" role="status">
          <Text size="sm" color="primary">{t(notice)}</Text>
        </div>
      )}

      {/* ── Identidade ─────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-id">
        <div className="flex items-center justify-between">
          <Heading level={2} weight="semibold" color="primary">
            <span id="sec-id">{group.name}</span>
            {group.isSystem && <Text as="span" size="xs" color="secondary"> · {t('admin.access.groups.system')}</Text>}
            {group.archivedAt && <Text as="span" size="xs" color="secondary"> · {t('admin.access.groups.archived')}</Text>}
          </Heading>
          {!group.isSystem && !group.archivedAt && (
            confirmArchive ? (
              <div className="flex gap-2 items-center" data-testid="archive-confirm">
                <Text size="xs" color="primary">{t('admin.access.group.archiveConfirm')}</Text>
                <ActionButton resource={PANEL_RESOURCE} size="sm" variant="outline" onClick={() => setConfirmArchive(false)}>
                  {t('admin.access.group.archiveNo')}
                </ActionButton>
                <ActionButton
                  resource={PANEL_RESOURCE}
                  size="sm"
                  variant="primary"
                  onClick={() => run(async () => {
                    await AdminPermissionsApiService.archiveGroup(group.id);
                    navigate('/admin/access');
                  }, 'admin.access.group.archived')}
                >
                  {t('admin.access.group.archiveYes')}
                </ActionButton>
              </div>
            ) : (
              <ActionButton resource={PANEL_RESOURCE} size="sm" variant="outline" onClick={() => setConfirmArchive(true)}>
                {t('admin.access.group.archive')}
              </ActionButton>
            )
          )}
        </div>

        {/* `inputSize="compact"` (h-12, text-sm) em vez do `default` (h-[60px],
            text-[20px]): o campo de 60px com fonte de 20 dominava a seção e não
            fechava com o resto da página, que é toda `size="sm"`/`xs`. O
            `compact` é o tamanho já estabelecido na casa — 97 usos no `src`.
            O `default` NÃO muda: ele é compartilhado com o app inteiro.

            A largura também é contida: o cartão é largo porque a matriz de
            células precisa, não porque um nome de grupo precise de 1100px. */}
        {/* Texto com lápis ao lado; o input só nasce depois do clique (pedido do
            Gabriel, 05/09). Antes a tela abria com tudo em campo de formulário —
            convite a digitar onde ninguém queria mudar nada, e o dobro da altura
            para mostrar a mesma coisa. Cancelar devolve o valor salvo. */}
        <CampoEditavel
          id="g-name"
          label={t('admin.access.groups.name')}
          value={group.name}
          editable={editable}
          onConfirm={() => salvarCampo('name')}
          onCancel={() => setForm((f) => ({ ...f, name: group.name }))}
        >
          <Input id="g-name" inputSize="compact" value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </CampoEditavel>
        <CampoEditavel
          id="g-desc"
          label={t('admin.access.groups.description')}
          value={group.description}
          editable={editable}
          onConfirm={() => salvarCampo('description')}
          onCancel={() => setForm((f) => ({ ...f, description: group.description ?? '' }))}
        >
          <Textarea id="g-desc" inputSize="compact" rows={2} value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </CampoEditavel>

      </section>

      {/* ── Países ─────────────────────────────────────────────────────── */}
      {/* PRIMEIRO na página (pedido do Gabriel, 05/09). O país é o eixo mais
          largo do painel: ele decide de QUE população o grupo vê alguém, e as
          células decidem O QUE vê. Ler as células antes de saber sobre quem
          elas incidem é ler na ordem errada.

          O nome sai por EXTENSO, do dicionário `countries` que o app já tem
          (AR·BR·UY·…) — não criei um segundo mapa: uma sigla só é legível para
          quem já sabe o que ela quer dizer. */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-countries">
        <Heading level={3} weight="semibold" color="primary"><span id="sec-countries">{t('admin.access.group.countriesTitle')}</span></Heading>
        <div className="flex flex-wrap gap-3 items-center">
          {COUNTRIES.map((c) => {
            const on = group.countries.includes(c);
            const nome = t(`countries.${c}`, c);
            // O PAÍS é o botão (pedido do Gabriel, 05/09). Não há "Conceder" ao
            // lado: clicar em `Argentina` concede, clicar de novo revoga. O
            // estado é o próprio botão — marcado (✓, fundo cheio) ou não.
            //
            // Sem motivo: a mig 412 tirou a exigência das três camadas
            // (coluna, zod e a própria `iam.grant_country`). Decisão do Gabriel:
            // "ninguém faz um grupo e coloca motivo por ser de um país ou dos
            // dois" — e campo obrigatório sem conteúdo real vira "ok" e ".".
            // Quem guarda o ato é `granted_by` + `created_at` + `revoked_at`.
            // Em `read` o país é TEXTO, não botão desabilitado. `ActionButton`
            // ESCONDE quando falta a célula de escrita (D269) — e o país virando
            // botão fazia a seção inteira sumir para quem só lê, que é
            // justamente quem precisa consultar o alcance do grupo.
            if (!editable) {
              return (
                <span key={c} className="px-3 py-1 rounded border border-gray-300">
                  <Text as="span" size="sm" weight={on ? 'semibold' : 'normal'} color={on ? 'primary' : 'secondary'}>
                    {nome}{on ? ' ✓' : ''}
                  </Text>
                </span>
              );
            }
            return (
              <ActionButton
                key={c}
                resource={PANEL_RESOURCE}
                size="sm"
                variant={on ? 'primary' : 'outline'}
                aria-pressed={on}
                onClick={() => run(() => (on
                  ? AdminPermissionsApiService.revokeCountry(group.id, c)
                  : AdminPermissionsApiService.grantCountry(group.id, c)))}
              >
                {nome}{on ? ' ✓' : ''}
              </ActionButton>
            );
          })}
          {group.countries.length === 0 && !editable && <Text size="sm" color="secondary">{t('admin.access.group.noCountries')}</Text>}
        </div>

      </section>

      {/* ── Células ────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-cells">
        {/* O contador fica na linha do título, à direita (pedido do Gabriel,
            05/09). Ele conta o que a GRADE desenha marcado — é o que substitui
            o "Sin células.": numa matriz de `·`, "não dá acesso a nada" e
            "ninguém marcou ainda" desenham igual, e o número desfaz isso em
            qualquer valor, não só no zero.

            SEM catálogo ele NÃO sai. Sem catálogo a grade não desenha caixa
            nenhuma e o `CellMatrix` diz que o sync não rodou; um "0" ali seria
            uma afirmação FALSA sobre acesso — o grupo pode ter 12 células no
            banco. Painel de permissão não erra para o lado do silêncio bonito:
            quando não sei, não digo (gate `revisao-pr`, 05/09). */}
        <div className="flex items-baseline justify-between gap-3">
          <Heading level={3} weight="semibold" color="primary"><span id="sec-cells">{t('admin.access.group.cellsTitle')}</span></Heading>
          {catalog.length > 0 && (
            <Text as="span" size="xs" color="secondary" className="shrink-0">
              {t('admin.access.group.cells.selected', { total: contaSelecionadas(catalog, cells) })}
            </Text>
          )}
        </div>

        {/* D286: por TELA → container → ações (a matriz recurso × ação saiu; ver ScreenTree). */}
        <ScreenTree
          catalog={catalog}
          selected={cells}
          saved={group.cells}
          editable={editable}
          /* Quem aplica a implicação `mexer ⇒ ver` é o modelo, não a tela:
             marcar Crear y editar marca Ver junto (item 2 do Gabriel, 05/09). */
          onToggle={(key) => setCells((prev) => alternaCelula(catalog, prev, key))}
        />

        {editable && (
          <div className="flex gap-2 items-end justify-end pt-3 border-t border-gray-200">
            {/* O diff ANTES de salvar: `setGroupPermissions` manda o conjunto
                inteiro, então desmarcar sem querer era silencioso. */}
            <Text as="span" size="xs" color="secondary" className="mr-auto self-center">
              {diffCelulas.dirty
                ? t('admin.access.group.cells.pending', {
                  added: diffCelulas.added.length,
                  removed: diffCelulas.removed.length,
                  people: members.length,
                })
                : t('admin.access.group.cells.clean')}
            </Text>
            <ActionButton
              resource={PANEL_RESOURCE}
              variant="primary"
              size="sm"
              disabled={!diffCelulas.dirty}
              /* Sem motivo: o servidor o aceita nulo para células
                 (`set_group_permissions` não o exige), e um campo obrigatório
                 que ninguém preenche colhe "ok" e "." — pedido do Gabriel. */
              onClick={() => run(() => AdminPermissionsApiService.setGroupPermissions(group.id, [...cells].sort(), null))}
            >
              {t('admin.access.group.cellsSave')}
            </ActionButton>
          </div>
        )}
      </section>

      {/* ── Membros ────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-members">
        <Heading level={3} weight="semibold" color="primary"><span id="sec-members">{t('admin.access.group.membersTitle')}</span></Heading>
        <Text size="xs" color="secondary">
          {t('admin.access.group.transfer.grants', {
            count: group.cells.length,
            countries: group.countries.join(', ') || '—',
          })}
        </Text>
        {/* lex C1: e-mail de staff não pode ir à gravação de sessão do Clarity —
            a máscara vive dentro do componente, nas duas colunas e na lista. */}
        <MemberTransfer
          resource={PANEL_RESOURCE}
          memberIds={members.map((m) => m.userId)}
          people={people}
          editable={editable}
          onSave={async (add, remove) => { await run(async () => {
            // Adiciona ANTES de remover: trocar o último gestor por outro só
            // passa pelo anti-lockout do banco nessa ordem.
            for (const uid of add) await AdminPermissionsApiService.addMember(group.id, uid);
            for (const uid of remove) await AdminPermissionsApiService.removeMember(group.id, uid);
          }); }}
        />
      </section>
    </div>
  );
}
