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
import { Heading, Text, Input, Textarea, Label } from '@presentation/components/atoms';
import {
  ActionButton,
  ReadOnlyField,
  PanelErrorAlert,
  MemberTransfer,
  CellMatrix,
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
 * A postura vem de `useCellAccess(PANEL_RESOURCE)`: em `read` todo campo é
 * `ReadOnlyField` (texto, input nem montado), toda ação de conclusão é
 * `ActionButton` (D269 — correção do Gabriel: "esconder, não desabilitar" —
 * sem `:write` o botão SOME, `mode="hide"` default), e as checkboxes de
 * célula viram lista.
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
  // DOIS motivos, não um. Eram o mesmo estado, e o campo visível morava na
  // seção de Células — até `ebef8613` pôr Países como a PRIMEIRA seção. A partir
  // dali os botões de país ficavam mortos por causa de um campo duas seções
  // abaixo, rotulado para outra coisa. Regressão minha, achada pelo CTO (05/09).
  const [reason, setReason] = useState('');
  const [motivoPais, setMotivoPais] = useState('');
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

  async function run(acao: () => Promise<unknown>, okKey = 'admin.access.group.saved'): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await acao();
      setNotice(okKey);
      await load();
    } catch (err) {
      setError(panelErrorKey(err));
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
            return (
              <div key={c} className="flex items-center gap-2 px-3 py-1 rounded border border-gray-300">
                <Text as="span" size="sm" weight={on ? 'semibold' : 'normal'} color={on ? 'primary' : 'secondary'}>{nome}{on ? ' ✓' : ''}</Text>
                {editable && (
                  on ? (
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" onClick={() => run(() => AdminPermissionsApiService.revokeCountry(group.id, c))}>
                      {t('admin.access.group.revoke')}
                    </ActionButton>
                  ) : (
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" disabled={!motivoPais.trim()} onClick={() => run(async () => {
                      await AdminPermissionsApiService.grantCountry(group.id, c, motivoPais.trim());
                      setMotivoPais('');
                    })}>
                      {t('admin.access.group.grant')}
                    </ActionButton>
                  )
                )}
              </div>
            );
          })}
          {group.countries.length === 0 && !editable && <Text size="sm" color="secondary">{t('admin.access.group.noCountries')}</Text>}
        </div>
        {/* O motivo do país mora AQUI, ao lado dos botões que ele destrava — não
            numa seção abaixo. Ele é obrigatório em três camadas do servidor
            (zod, `assertValidReason` e a função `iam.grant_country`, que levanta
            23502 sozinha), então esconder o campo não remove a exigência: só
            deixa o botão morto sem dizer por quê. Revogar não pede motivo, e a
            assimetria está certa — revogar reduz alcance. */}
        {editable && (
          <div className="max-w-sm">
            {/* rótulo PRÓPRIO: dois campos chamados "Motivo" na mesma tela é a
                mesma ambiguidade de duas caixas com o mesmo nome acessível */}
            <Label htmlFor="country-reason">{t('admin.access.group.reasonCountry')}</Label>
            <Input
              id="country-reason"
              inputSize="compact"
              value={motivoPais}
              placeholder={t('admin.access.group.reasonCountryPlaceholder')}
              onChange={(e) => setMotivoPais(e.target.value)}
            />
          </div>
        )}
      </section>

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
        <ReadOnlyField id="g-name" label={t('admin.access.groups.name')} value={group.name} editable={editable} className="max-w-xl">
          <Input id="g-name" inputSize="compact" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </ReadOnlyField>
        <ReadOnlyField id="g-desc" label={t('admin.access.groups.description')} value={group.description} editable={editable} className="max-w-xl">
          <Textarea id="g-desc" inputSize="compact" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </ReadOnlyField>
        {editable && (
          <div className="flex justify-end">
            <ActionButton
              resource={PANEL_RESOURCE}
              variant="primary"
              size="sm"
              onClick={() => run(() => AdminPermissionsApiService.updateGroup(group.id, {
                name: form.name.trim(),
                description: form.description.trim() || null,
              }))}
            >
              {t('admin.access.group.save')}
            </ActionButton>
          </div>
        )}
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

        <CellMatrix
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
            <div className="w-full max-w-xs">
              <Label htmlFor="cells-reason">{t('admin.access.group.reasonCells')}</Label>
              <Input id="cells-reason" inputSize="compact" value={reason} placeholder={t('admin.access.group.reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
            </div>
            <ActionButton
              resource={PANEL_RESOURCE}
              variant="primary"
              size="sm"
              disabled={!diffCelulas.dirty}
              onClick={() => run(() => AdminPermissionsApiService.setGroupPermissions(group.id, [...cells].sort(), reason.trim() || null))}
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
          onSave={(add, remove) => run(async () => {
            // Adiciona ANTES de remover: trocar o último gestor por outro só
            // passa pelo anti-lockout do banco nessa ordem.
            for (const uid of add) await AdminPermissionsApiService.addMember(group.id, uid);
            for (const uid of remove) await AdminPermissionsApiService.removeMember(group.id, uid);
          })}
        />
      </section>
    </div>
  );
}
