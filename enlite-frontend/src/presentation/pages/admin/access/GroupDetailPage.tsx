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
import { Heading, Text, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Input, Textarea, Checkbox, Select, Label } from '@presentation/components/atoms';
import { ActionButton, ReadOnlyField, PanelErrorAlert } from '@presentation/components/features/access';
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
 * `ActionButton` (não existe), e as checkboxes de célula viram lista.
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
  const [reason, setReason] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [candidates, setCandidates] = useState<AdminUser[]>([]);
  const [pickedUser, setPickedUser] = useState('');

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

  // A lista de pessoas para "adicionar membro" só é buscada em `write` — em
  // `read` o select não existe, e buscar seria uma leitura sem propósito.
  useEffect(() => {
    if (!canWrite) return;
    AdminApiService.listAdmins(200, 0)
      .then((r) => setCandidates(r.admins))
      .catch(() => setCandidates([]));
  }, [canWrite]);

  const memberUids = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

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

        <ReadOnlyField id="g-name" label={t('admin.access.groups.name')} value={group.name} editable={editable}>
          <Input id="g-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </ReadOnlyField>
        <ReadOnlyField id="g-desc" label={t('admin.access.groups.description')} value={group.description} editable={editable}>
          <Textarea id="g-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
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
        <Heading level={3} weight="semibold" color="primary"><span id="sec-cells">{t('admin.access.group.cellsTitle')}</span></Heading>
        {editable ? (
          <>
            {catalog.map((cat) => (
              <fieldset key={cat.category} className="space-y-1">
                <legend className="text-xs font-semibold uppercase text-gray-500">{cat.category}</legend>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                  {cat.cells.map((c) => {
                    const key = `${c.resource}:${c.action}`;
                    return (
                      <Checkbox
                        key={key}
                        id={`cell-${key}`}
                        label={key}
                        checked={cells.has(key)}
                        onChange={(e) => setCells((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(key); else next.delete(key);
                          return next;
                        })}
                      />
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <div className="flex gap-2 items-end justify-end">
              <div className="grow max-w-md">
                <Label htmlFor="cells-reason">{t('admin.access.group.reason')}</Label>
                <Input id="cells-reason" value={reason} placeholder={t('admin.access.group.reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
              </div>
              <ActionButton
                resource={PANEL_RESOURCE}
                variant="primary"
                size="sm"
                onClick={() => run(() => AdminPermissionsApiService.setGroupPermissions(group.id, [...cells].sort(), reason.trim() || null))}
              >
                {t('admin.access.group.cellsSave')}
              </ActionButton>
            </div>
          </>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="cells-readonly">
            {group.cells.length === 0 && <Text size="sm" color="secondary">{t('admin.access.group.noCells')}</Text>}
            {group.cells.map((c) => (
              <li key={c} className="px-2 py-0.5 rounded bg-gray-100 text-xs font-mono">{c}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Países ─────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-countries">
        <Heading level={3} weight="semibold" color="primary"><span id="sec-countries">{t('admin.access.group.countriesTitle')}</span></Heading>
        <div className="flex flex-wrap gap-3 items-center">
          {COUNTRIES.map((c) => {
            const on = group.countries.includes(c);
            return (
              <div key={c} className="flex items-center gap-2 px-3 py-1 rounded border border-gray-300">
                <Text as="span" size="sm" weight={on ? 'semibold' : 'normal'} color={on ? 'primary' : 'secondary'}>{c}{on ? ' ✓' : ''}</Text>
                {editable && (
                  on ? (
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" onClick={() => run(() => AdminPermissionsApiService.revokeCountry(group.id, c))}>
                      {t('admin.access.group.revoke')}
                    </ActionButton>
                  ) : (
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" disabled={!reason.trim()} onClick={() => run(() => AdminPermissionsApiService.grantCountry(group.id, c, reason.trim()))}>
                      {t('admin.access.group.grant')}
                    </ActionButton>
                  )
                )}
              </div>
            );
          })}
          {group.countries.length === 0 && !editable && <Text size="sm" color="secondary">{t('admin.access.group.noCountries')}</Text>}
        </div>
      </section>

      {/* ── Membros ────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-300 p-4 space-y-3" aria-labelledby="sec-members">
        <div className="flex items-center justify-between">
          <Heading level={3} weight="semibold" color="primary"><span id="sec-members">{t('admin.access.group.membersTitle')}</span></Heading>
          {editable && (
            <div className="flex gap-2 items-center">
              <Select
                aria-label={t('admin.access.group.pickUser')}
                placeholder={t('admin.access.group.pickUser')}
                value={pickedUser}
                onValueChange={setPickedUser}
                options={candidates
                  .filter((u) => !memberUids.has(u.firebaseUid))
                  .map((u) => ({ value: u.firebaseUid, label: u.email }))}
              />
              <ActionButton
                resource={PANEL_RESOURCE}
                size="sm"
                variant="primary"
                disabled={!pickedUser}
                onClick={() => run(async () => {
                  await AdminPermissionsApiService.addMember(group.id, pickedUser);
                  setPickedUser('');
                })}
              >
                {t('admin.access.group.addMember')}
              </ActionButton>
            </div>
          )}
        </div>
        {/* lex C1: e-mail/papel/status de staff não podem ir à gravação de sessão do Clarity. */}
        <Table data-clarity-mask="True">
          <TableHeader>
            <TableHead>{t('admin.access.group.email')}</TableHead>
            <TableHead>{t('admin.access.group.role')}</TableHead>
            <TableHead>{t('admin.access.group.status')}</TableHead>
            <TableHead>{t('admin.access.group.since')}</TableHead>
            <TableHead align="right" />
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.userId}>
                <TableCell weight="medium">{m.email ?? m.userId}</TableCell>
                <TableCell>{m.role ?? '—'}</TableCell>
                <TableCell>{m.status ?? '—'}</TableCell>
                <TableCell>{new Date(m.assignedAt).toLocaleDateString('es-AR')}</TableCell>
                <TableCell unwrapped align="right">
                  {editable && (
                    <ActionButton resource={PANEL_RESOURCE} size="sm" variant="ghost" onClick={() => run(() => AdminPermissionsApiService.removeMember(group.id, m.userId))}>
                      {t('admin.access.group.remove')}
                    </ActionButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {members.length === 0 && (
              <TableRow>
                <TableCell unwrapped colSpan={5} className="px-6 py-6 text-center">
                  <Text as="span" size="sm" color="secondary">{t('admin.access.group.noMembers')}</Text>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
