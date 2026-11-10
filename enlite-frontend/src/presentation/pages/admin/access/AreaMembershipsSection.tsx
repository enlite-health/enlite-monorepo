import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import {
  STORED_AREAS,
  STORED_AREA_ROLES,
  type AreaMembership,
  type AreaMembershipList,
  type StoredArea,
} from '@domain/entities/AreaMembership';
import { Heading, Text, Input, Combobox, Label, Textarea, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { Gated, PanelErrorAlert } from '@presentation/components/features/access';
import { formatInstant } from '@presentation/utils/dateTimeFormat';

/** O recurso das células `area_membership:read|write` (catálogo do back, T111). */
export const AREA_MEMBERSHIP_RESOURCE = 'area_membership';

const K = 'admin.access.areaMemberships';

type LookupMode = 'personId' | 'uid';
type Phase = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Seção "Vínculos de área" da `/admin/access` (F4, T411, direção A — abaixo de Grupos). Só EXISTE
 * para quem tem `area_membership:read` (D269: sem a célula não entra na árvore); conceder e revogar
 * só existem com `area_membership:write`. O `AccessGate` da página segue intacto — esta seção só restringe.
 */
export function AreaMembershipsSection(): JSX.Element | null {
  return (
    <Gated resource={AREA_MEMBERSHIP_RESOURCE}>
      <MembershipsPanel />
    </Gated>
  );
}

function MembershipsPanel(): JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<LookupMode>('personId');
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [list, setList] = useState<AreaMembershipList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (lookup: { personId: string } | { uid: string }) => {
    setPhase('loading');
    setError(null);
    try {
      setList(await AdminApiService.listAreaMemberships(lookup));
      setPhase('ready');
    } catch (err) {
      setList(null);
      setError(listErrorKey(err));
      setPhase('error');
    }
  }, []);

  const handleSearch = (e: FormEvent): void => {
    e.preventDefault();
    const value = query.trim();
    if (!value) return;
    void load(mode === 'personId' ? { personId: value } : { uid: value });
  };

  // Depois de conceder/revogar, recarrega pela pessoa já resolvida (não pelo texto digitado).
  const reload = (personId: string): Promise<void> => load({ personId });

  return (
    <section className="space-y-4" data-testid="area-memberships-section" aria-labelledby="area-memberships-title">
      <div>
        <Heading level={2} weight="semibold" color="primary" id="area-memberships-title">{t(`${K}.title`)}</Heading>
        <Text size="sm" color="tertiary">{t(`${K}.subtitle`)}</Text>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={handleSearch} data-testid="area-memberships-search">
        <div className="space-y-1">
          <Label size="compact" htmlFor="am-mode">{t(`${K}.search.mode`)}</Label>
          <Combobox
            id="am-mode"
            value={mode}
            onChange={(v) => setMode(v as LookupMode)}
            options={[
              { value: 'personId', label: t(`${K}.search.personId`) },
              { value: 'uid', label: t(`${K}.search.uid`) },
            ]}
          />
        </div>
        <div className="space-y-1 min-w-[16rem] flex-1">
          <Label size="compact" htmlFor="am-query">{t(`${K}.search.value`)}</Label>
          <Input id="am-query" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </div>
        <Button type="submit" variant="primary" disabled={!query.trim() || phase === 'loading'}>{t(`${K}.search.submit`)}</Button>
      </form>

      <PanelErrorAlert keyName={error} />

      {phase === 'idle' && <Text size="sm" color="tertiary">{t(`${K}.prompt`)}</Text>}
      {phase === 'loading' && <Text size="sm" color="tertiary" role="status">{t(`${K}.loading`)}</Text>}
      {phase === 'ready' && list && <MembershipsResult list={list} onChanged={() => reload(list.personId)} />}
    </section>
  );
}

function MembershipsResult({ list, onChanged }: { list: AreaMembershipList; onChanged: () => Promise<void> }): JSX.Element {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
        <Table>
          <TableHeader>
            <TableHead>{t(`${K}.columns.area`)}</TableHead>
            <TableHead>{t(`${K}.columns.role`)}</TableHead>
            <TableHead>{t(`${K}.columns.grantedBy`)}</TableHead>
            <TableHead>{t(`${K}.columns.grantedAt`)}</TableHead>
            <TableHead align="right" />
          </TableHeader>
          <TableBody>
            {list.memberships.map((m) => (
              <MembershipRow
                key={m.id}
                membership={m}
                isRevoking={revoking === m.id}
                onStartRevoke={() => setRevoking(m.id)}
                onCancelRevoke={() => setRevoking(null)}
                onChanged={async () => { setRevoking(null); await onChanged(); }}
              />
            ))}
            {list.memberships.length === 0 && (
              <TableRow>
                <TableCell unwrapped colSpan={5} className="px-6 py-8 text-center">
                  <Text as="span" size="sm" color="tertiary">{t(`${K}.empty`)}</Text>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Gated resource={AREA_MEMBERSHIP_RESOURCE} atLeast="write">
        <GrantForm personId={list.personId} onGranted={onChanged} />
      </Gated>
    </div>
  );
}

function MembershipRow({ membership: m, isRevoking, onStartRevoke, onCancelRevoke, onChanged }: {
  membership: AreaMembership;
  isRevoking: boolean;
  onStartRevoke: () => void;
  onCancelRevoke: () => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <TableRow>
        <TableCell weight="medium">{t(`areas.names.${m.area}`, { defaultValue: m.area })}</TableCell>
        <TableCell>{t(`${K}.roles.${m.role}`, { defaultValue: m.role })}</TableCell>
        <TableCell>{m.grantedBy}</TableCell>
        <TableCell>{formatInstant(m.grantedAt, { dateStyle: 'short', timeStyle: 'short' }) ?? '—'}</TableCell>
        <TableCell unwrapped align="right">
          <Gated resource={AREA_MEMBERSHIP_RESOURCE} atLeast="write">
            {!isRevoking && (
              <Button type="button" variant="outline" size="sm" onClick={onStartRevoke}>{t(`${K}.revoke.open`)}</Button>
            )}
          </Gated>
        </TableCell>
      </TableRow>
      {isRevoking && (
        <TableRow>
          <TableCell unwrapped colSpan={5} className="px-6 py-4">
            <Gated resource={AREA_MEMBERSHIP_RESOURCE} atLeast="write">
              <RevokeForm membership={m} onCancel={onCancelRevoke} onRevoked={onChanged} />
            </Gated>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function RevokeForm({ membership, onCancel, onRevoked }: {
  membership: AreaMembership;
  onCancel: () => void;
  onRevoked: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await AdminApiService.revokeAreaMembership(membership.id, trimmed);
      await onRevoked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? `${K}.errors.revokeGone` : `${K}.errors.revoke`);
      setBusy(false);
    }
  };

  const id = `am-reason-${membership.id}`;
  return (
    <form className="space-y-3" data-testid="area-membership-revoke-form" onSubmit={(e) => { void submit(e); }}>
      <PanelErrorAlert keyName={error} />
      <div className="space-y-1">
        <Label size="compact" htmlFor={id}>{t(`${K}.revoke.reason`)}</Label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>{t(`${K}.revoke.cancel`)}</Button>
        <Button type="submit" variant="primary" isLoading={busy} disabled={!reason.trim()}>{t(`${K}.revoke.confirm`)}</Button>
      </div>
    </form>
  );
}

function GrantForm({ personId, onGranted }: { personId: string; onGranted: () => Promise<void> }): JSX.Element {
  const { t } = useTranslation();
  const [area, setArea] = useState<StoredArea>(STORED_AREAS[0]);
  const [role, setRole] = useState<string>(STORED_AREA_ROLES[STORED_AREAS[0]][0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeArea = (next: StoredArea): void => {
    setArea(next);
    setRole(STORED_AREA_ROLES[next][0]);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await AdminApiService.grantAreaMembership({ personId, area, role });
      await onGranted();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422 ? `${K}.errors.grantRejected` : `${K}.errors.grant`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" data-testid="area-membership-grant-form" onSubmit={(e) => { void submit(e); }}>
      <Heading level={3} weight="semibold" color="primary">{t(`${K}.grant.title`)}</Heading>
      <PanelErrorAlert keyName={error} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label size="compact" htmlFor="am-area">{t(`${K}.grant.area`)}</Label>
          <Combobox
            id="am-area"
            value={area}
            onChange={(v) => changeArea(v as StoredArea)}
            options={STORED_AREAS.map((a) => ({ value: a, label: t(`areas.names.${a}`) }))}
          />
        </div>
        <div className="space-y-1">
          <Label size="compact" htmlFor="am-role">{t(`${K}.grant.role`)}</Label>
          <Combobox
            id="am-role"
            value={role}
            onChange={setRole}
            options={STORED_AREA_ROLES[area].map((r) => ({ value: r, label: t(`${K}.roles.${r}`) }))}
          />
        </div>
        <Button type="submit" variant="primary" isLoading={busy}>{t(`${K}.grant.submit`)}</Button>
      </div>
    </form>
  );
}

/** 404 = pessoa inexistente; 400 = identificador malformado; o resto é falha de leitura. */
function listErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return `${K}.errors.notFound`;
  if (err instanceof ApiError && err.status === 400) return `${K}.errors.invalidQuery`;
  return `${K}.errors.load`;
}
