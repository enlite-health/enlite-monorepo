import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminPermissionsApiService,
  type PermissionGroupDetail,
  type PermissionHistoryEvent,
} from '@infrastructure/http/AdminPermissionsApiService';
import { Heading, Text, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Input, Label, Select } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { PanelErrorAlert, permissionCellLabel } from '@presentation/components/features/access';
import { AccessGate } from './AccessGate';

type TipoFiltro = '' | 'permission' | 'member';

/**
 * `/admin/access/audit` — histórico de mudanças de permissão. Substitui a
 * antiga "Auditoría de decisiones" (ALLOW/DENY): responde QUEM mudou uma
 * permissão, EM QUAL GRUPO, QUANDO, e QUAL foi a mudança — pergunta que a
 * trilha de decisões não respondia.
 *
 * Lista única ordenada por data desc, com DOIS tipos de linha visualmente
 * distintos pelo chip da coluna Tipo: `permission` (célula agregada/quitada
 * de um grupo) e `member` (pessoa agregada/quitada de um grupo). O rótulo da
 * célula usa a MESMA função/i18n que a tela do grupo (`permissionCellLabel`)
 * — não um mapeamento novo.
 *
 * PROIBIDO nesta tela: coluna de uid, coluna de País, coluna de Id del
 * recurso, e o campo `reason` (texto livre) — nem a rota devolve isso.
 */
export function PermissionHistoryPage(): JSX.Element {
  return (
    <AccessGate>
      <PermissionHistory />
    </AccessGate>
  );
}

function nomePessoa(displayName: string | null, email: string | null, uid: string | null): string {
  return displayName || email || uid || '—';
}

function PermissionHistory(): JSX.Element {
  const { t } = useTranslation();
  const [eventos, setEventos] = useState<PermissionHistoryEvent[]>([]);
  const [grupos, setGrupos] = useState<PermissionGroupDetail[]>([]);
  const [filtros, setFiltros] = useState<{ groupId: string; type: TipoFiltro; limit: string }>({
    groupId: '', type: '', limit: '100',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Recebe os filtros por parâmetro pelo mesmo motivo da antiga AuditPage: um
  // `useCallback` fechado sobre o estado buscaria sempre os filtros INICIAIS.
  const load = useCallback(async (f: typeof filtros) => {
    setIsLoading(true);
    setError(null);
    try {
      setEventos(await AdminPermissionsApiService.queryHistory({
        groupId: f.groupId || undefined,
        type: f.type || undefined,
        limit: Number(f.limit) || undefined,
      }));
    } catch {
      setError('admin.access.history.loadError');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    AdminPermissionsApiService.listGroups().then(setGrupos).catch(() => setGrupos([]));
    void load(filtros);
    // Carrega uma vez; depois só pelo botão — a lista não é reativa por tecla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const opcoesGrupo = [
    { value: '', label: t('admin.access.history.allGroups') },
    ...grupos.map((g) => ({ value: g.id, label: g.name })),
  ];
  const opcoesTipo = [
    { value: '', label: t('admin.access.history.type.all') },
    { value: 'permission', label: t('admin.access.history.type.permission') },
    { value: 'member', label: t('admin.access.history.type.member') },
  ];

  return (
    <div className="space-y-4">
      <Heading level={2} weight="semibold" color="primary">{t('admin.access.history.title')}</Heading>
      <Text size="xs" color="secondary">{t('admin.access.history.note')}</Text>
      <form
        className="flex gap-3 items-end flex-wrap"
        onSubmit={(e) => { e.preventDefault(); void load(filtros); }}
      >
        <div className="w-56">
          <Label htmlFor="ph-group">{t('admin.access.history.group')}</Label>
          <Select
            id="ph-group"
            inputSize="compact"
            options={opcoesGrupo}
            value={filtros.groupId}
            onValueChange={(v) => setFiltros((f) => ({ ...f, groupId: v }))}
          />
        </div>
        <div className="w-48">
          <Label htmlFor="ph-type">{t('admin.access.history.typeLabel')}</Label>
          <Select
            id="ph-type"
            inputSize="compact"
            options={opcoesTipo}
            value={filtros.type}
            onValueChange={(v) => setFiltros((f) => ({ ...f, type: v as TipoFiltro }))}
          />
        </div>
        <div className="w-28">
          <Label htmlFor="ph-limit">{t('admin.access.history.limit')}</Label>
          <Input id="ph-limit" type="number" min={1} max={1000} inputSize="compact" value={filtros.limit}
            onChange={(e) => setFiltros((f) => ({ ...f, limit: e.target.value }))} />
        </div>
        <Button type="submit" variant="outline" size="sm">{t('admin.access.history.search')}</Button>
      </form>
      <PanelErrorAlert keyName={error} />
      {isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
          {/* lex C1: nome/e-mail de pessoa não pode ir à gravação de sessão do Clarity. */}
          <Table data-clarity-mask="True">
            <TableHeader>
              <TableHead>{t('admin.access.history.type')}</TableHead>
              <TableHead>{t('admin.access.history.when')}</TableHead>
              <TableHead>{t('admin.access.history.who')}</TableHead>
              <TableHead>{t('admin.access.history.groupCol')}</TableHead>
              <TableHead>{t('admin.access.history.actionCol')}</TableHead>
              <TableHead>{t('admin.access.history.detail')}</TableHead>
            </TableHeader>
            <TableBody>
              {eventos.map((ev, i) => (
                <TableRow key={`${ev.groupId}-${ev.eventType}-${ev.op}-${ev.occurredAt}-${i}`} data-testid={`history-row-${ev.eventType}`}>
                  <TableCell unwrapped>
                    {ev.eventType === 'permission' ? (
                      <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full" data-testid="chip-permission">
                        <Text as="span" size="xs" weight="medium" color="inherit">{t('admin.access.history.type.permission')}</Text>
                      </span>
                    ) : (
                      <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full" data-testid="chip-member">
                        <Text as="span" size="xs" weight="medium" color="inherit">{t('admin.access.history.type.member')}</Text>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{new Date(ev.occurredAt).toLocaleString('es-AR')}</TableCell>
                  <TableCell>{nomePessoa(ev.actorDisplayName, ev.actorEmail, ev.actorUid)}</TableCell>
                  <TableCell>{ev.groupName}</TableCell>
                  <TableCell weight="medium">
                    {t(ev.op === 'add' ? 'admin.access.history.action.add' : 'admin.access.history.action.remove')}
                  </TableCell>
                  <TableCell>
                    {ev.eventType === 'permission' && ev.resource && ev.action
                      ? permissionCellLabel(t, ev.resource, ev.action)
                      : nomePessoa(ev.subjectDisplayName, ev.subjectEmail, ev.subjectUserId)}
                  </TableCell>
                </TableRow>
              ))}
              {eventos.length === 0 && (
                <TableRow>
                  <TableCell unwrapped colSpan={6} className="px-6 py-8 text-center">
                    <Text as="span" size="sm" color="secondary">{t('admin.access.history.empty')}</Text>
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
