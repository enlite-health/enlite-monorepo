import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AdminPermissionsApiService, type PermissionGroupDetail } from '@infrastructure/http/AdminPermissionsApiService';
import { Heading, Text, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Checkbox, Input, Label, Textarea } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { ActionButton, PanelErrorAlert } from '@presentation/components/features/access';
import { AccessGate, PANEL_RESOURCE } from './AccessGate';
import { panelErrorKey } from './panelErrors';

/**
 * `/admin/access` — a lista de grupos. "Novo grupo" é `ActionButton`: sem
 * `permission_management:write` ele não existe, e o formulário tampouco. Os vínculos de área
 * são a aba vizinha (`/admin/access/area-memberships`).
 */
/**
 * Desvios do desenho (protótipo "Vínculos de área", estado 01) que valem SÓ nesta lista — classes locais,
 * nunca token global: textos secundários em #374151 (o do atom é #737373, 4,7:1), rótulo do checkbox
 * centrado e sem a folga do atom.
 */
const ARCHIVED_CHECKBOX = '[&_label]:!items-center [&_label]:!min-h-0 [&_label>div]:!mt-0 [&_label>span]:!text-[#374151] [&_label>span]:!leading-4';
const HEAD = 'text-[#374151]';
const CELL = '!leading-5';
/** O `td` do desenho é 14px/20px; sem isto o strut de 16px/24px do `td` desce o texto 1px. */
const CELL_BOX = '!text-sm !leading-5';

export function AccessPage(): JSX.Element {
  return (
    <AccessGate>
      <GroupsList />
    </AccessGate>
  );
}

function GroupsList(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<PermissionGroupDetail[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setGroups(await AdminPermissionsApiService.listGroups(includeArchived));
    } catch {
      setError('admin.access.groups.loadError');
    } finally {
      setIsLoading(false);
    }
  // `t` fora das deps de propósito: a chave é guardada e traduzida no render.
  }, [includeArchived]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { groupId } = await AdminPermissionsApiService.createGroup({
        name: form.name.trim(),
        description: form.description.trim() || null,
      });
      navigate(`/admin/access/groups/${groupId}`);
    } catch (err) {
      setError(panelErrorKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* data-testid estável para o screenshot do e2e (admin-access-panel):
          a lista abaixo cresce quando outros specs @integration rodam em
          paralelo contra o mesmo Postgres — este cabeçalho não. */}
      <div className="flex items-center justify-between" data-testid="access-groups-header">
        <Heading level={2} weight="semibold" color="primary">{t('admin.access.groups.title')}</Heading>
        <div className="flex items-center gap-4">
          <Checkbox
            id="include-archived"
            label={t('admin.access.groups.includeArchived')}
            className={ARCHIVED_CHECKBOX}
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          <ActionButton resource={PANEL_RESOURCE} variant="primary" onClick={() => setCreating((v) => !v)}>
            {t('admin.access.groups.new')}
          </ActionButton>
        </div>
      </div>

      <PanelErrorAlert keyName={error} />

      {creating && (
        <form
          className="bg-white rounded-xl border border-gray-300 p-4 space-y-3"
          data-testid="create-group-form"
          onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
        >
          <div>
            <Label htmlFor="ng-name">{t('admin.access.groups.name')}</Label>
            <Input id="ng-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </div>
          <div>
            <Label htmlFor="ng-desc">{t('admin.access.groups.description')}</Label>
            <Textarea id="ng-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t('admin.access.groups.cancel')}</Button>
            <Button type="submit" variant="primary" isLoading={busy}>{t('admin.access.groups.create')}</Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
          <Table>
            <TableHeader>
              <TableHead className={HEAD}>{t('admin.access.groups.name')}</TableHead>
              <TableHead className={HEAD}>{t('admin.access.groups.cells')}</TableHead>
              <TableHead className={HEAD}>{t('admin.access.groups.countries')}</TableHead>
              <TableHead className={HEAD}>{t('admin.access.groups.members')}</TableHead>
              <TableHead align="right" className={HEAD} />
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <TableRow key={g.id}>
                  <TableCell unwrapped>
                    <Text as="span" size="sm" weight="medium" color="primary">{g.name}</Text>
                    {g.isSystem && <>{' '}<Text as="span" size="xs" color="tertiary">· {t('admin.access.groups.system')}</Text></>}
                    {g.archivedAt && <>{' '}<Text as="span" size="xs" color="tertiary">· {t('admin.access.groups.archived')}</Text></>}
                  </TableCell>
                  <TableCell unwrapped className={CELL_BOX}><Text as="span" size="sm" color="tertiary" className={CELL}>{g.cells.length}</Text></TableCell>
                  <TableCell unwrapped className={CELL_BOX}><Text as="span" size="sm" color="tertiary" className={CELL}>{g.countries.join(', ') || '—'}</Text></TableCell>
                  <TableCell unwrapped className={CELL_BOX}><Text as="span" size="sm" color="tertiary" className={CELL}>{g.memberCount}</Text></TableCell>
                  <TableCell unwrapped align="right">
                    <button type="button" className="text-blue-700 underline" onClick={() => navigate(`/admin/access/groups/${g.id}`)}>
                      <Text as="span" size="xs" color="inherit" className="!leading-4">{t('admin.access.groups.open')}</Text>
                    </button>
                  </TableCell>
                </TableRow>
              ))}
              {groups.length === 0 && (
                <TableRow>
                  <TableCell unwrapped colSpan={5} className="px-6 py-8 text-center">
                    <Text as="span" size="sm" color="secondary">{t('admin.access.groups.empty')}</Text>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
