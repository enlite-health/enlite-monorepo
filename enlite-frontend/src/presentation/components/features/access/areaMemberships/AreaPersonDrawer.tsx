import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Heading, Label, Text, Textarea } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { PanelErrorAlert } from '@presentation/components/features/access/PanelErrorAlert';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { fetchFreshAreaPerson } from '@presentation/hooks/useAreaPeople';
import {
  STORED_AREA_ROLES,
  grantTarget,
  type AreaPerson,
  type AreaPersonMembership,
  type StoredArea,
} from '@domain/entities/AreaMembership';
import { AreaGrantFields } from './AreaGrantFields';
import { GRANT_AREAS } from './grantAreas';
import { FOCUS_RING_KEYBOARD_ONLY } from './formStyles';
import { AreaMembershipChip } from './AreaMembershipChip';
import { AreaPersonAvatar } from './AreaPersonAvatar';
import { AreaPersonKindBadge } from './AreaPersonKindBadge';
import { useMembershipLabel } from './useMembershipLabel';

const K = 'admin.access.areaMemberships';

interface AreaPersonDrawerProps {
  person: AreaPerson;
  onClose: () => void;
  /** A pessoa já com o resultado do ato (revogou/concedeu) + o texto do aviso; o pai recarrega a lista. */
  onChanged: (next: AreaPerson, toastKey: string) => void;
}

/**
 * O painel lateral "Gestionar": os vínculos vivos da pessoa (cada um com "Revocar" inline e motivo
 * obrigatório) e o formulário de conceder. Só abre para quem tem `area_membership:write` — a tabela não
 * oferece o botão sem a célula, então o painel não precisa se defender (a rota também recusa).
 */
export function AreaPersonDrawer({ person, onClose, onChanged }: AreaPersonDrawerProps): JSX.Element {
  const { t } = useTranslation();
  const label = useMembershipLabel();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [area, setArea] = useState<StoredArea>(GRANT_AREAS[0]);
  const [role, setRole] = useState<string>(STORED_AREA_ROLES[GRANT_AREAS[0]][0]);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A concessão passou, mas a releitura falhou: o painel NÃO mostra a lista antiga como se fosse a atual.
  const [reloadFailed, setReloadFailed] = useState(false);

  // Esc fecha e o foco começa no botão de fechar (mesmo contrato do painel de ajuda das células).
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeArea = (next: StoredArea): void => {
    setArea(next);
    setRole(STORED_AREA_ROLES[next][0]);
    setGrantError(null);
  };

  const startRevoke = (m: AreaPersonMembership): void => {
    setRevoking(m.id);
    setReason('');
    setRevokeError(null);
  };

  const submitRevoke = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!revoking || !trimmed || busy) return;
    setBusy(true);
    setRevokeError(null);
    try {
      await AdminApiService.revokeAreaMembership(revoking, trimmed);
      const id = revoking;
      setRevoking(null);
      onChanged({ ...person, memberships: person.memberships.filter((m) => m.id !== id) }, `${K}.toast.revoked`);
    } catch (err) {
      setRevokeError(err instanceof ApiError && err.status === 404 ? `${K}.errors.revokeGone` : `${K}.errors.revoke`);
    } finally {
      setBusy(false);
    }
  };

  const submitGrant = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const target = grantTarget(person);
    if (!target || busy) return;
    if (person.memberships.some((m) => m.area === area && m.role === role)) {
      setGrantError(`${K}.errors.grantDuplicate`);
      return;
    }
    setBusy(true);
    setGrantError(null);
    try {
      await AdminApiService.grantAreaMembership({ ...target, area, role });
    } catch (err) {
      setGrantError(err instanceof ApiError && err.status === 422 ? `${K}.errors.grantRejected` : `${K}.errors.grant`);
      setBusy(false);
      return;
    }
    await reloadAfterGrant();
    setBusy(false);
  };

  /** Relê a pessoa (também é o "Reintentar" do erro de recarga: reler NÃO repete a concessão). */
  const reloadAfterGrant = async (): Promise<void> => {
    setReloadFailed(false);
    try {
      onChanged(await fetchFreshAreaPerson(person), `${K}.toast.granted`);
    } catch {
      setReloadFailed(true);
    }
  };

  // Portal no <body>: dentro de `space-y-*` o `margin-top` do irmão empurraria o painel `fixed` 16px para baixo.
  return createPortal(
    <>
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t(`${K}.drawer.ariaLabel`, { name: person.displayName })}
        data-testid="area-person-drawer"
        className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto bg-white shadow-xl border-l border-gray-300 p-5 space-y-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <AreaPersonAvatar name={person.displayName} />
            <div className="min-w-0">
              <Heading level={3} weight="semibold" color="primary">{person.displayName}</Heading>
              <Text size="xs" color="tertiary" className="!leading-4">{person.email}</Text>
              <AreaPersonKindBadge kind={person.kind} className="mt-1" />
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="p-1 rounded hover:bg-gray-200 text-[#374151]"
            aria-label={t('common.close')}
            data-testid="area-drawer-close"
            onClick={onClose}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <section>
          <Heading level={4} weight="semibold" color="primary" className="mb-2">{t(`${K}.drawer.current`)}</Heading>
          {reloadFailed ? (
            <div className="space-y-3" data-testid="area-drawer-reload-error">
              <PanelErrorAlert keyName={`${K}.errors.reload`} />
              <Button type="button" size="xs" variant="quiet" data-testid="area-drawer-reload-retry" onClick={() => { void reloadAfterGrant(); }}>
                {t(`${K}.retry`)}
              </Button>
            </div>
          ) : (
          <ul className="space-y-2">
              {person.memberships.length === 0 && (
                <li><Text size="sm" color="tertiary" className="!leading-5" data-testid="area-drawer-none">{t(`${K}.drawer.none`)}</Text></li>
              )}
              {person.memberships.map((m) => (
                <li key={m.id} className="border border-gray-600 rounded-lg p-3" data-testid="area-drawer-membership">
                  <div className="flex items-center justify-between gap-3">
                    <AreaMembershipChip membership={m} />
                    {revoking !== m.id && (
                      <Button
                        type="button"
                        size="xs"
                        variant="quiet"
                        data-testid="area-drawer-revoke"
                        aria-label={t(`${K}.revoke.openAria`, { vinculo: label(m), name: person.displayName })}
                        onClick={() => startRevoke(m)}
                      >
                        {t(`${K}.revoke.open`)}
                      </Button>
                    )}
                  </div>
                  {revoking === m.id && (
                    <form className="mt-3 space-y-3" data-testid="area-drawer-revoke-form" onSubmit={(e) => { void submitRevoke(e); }}>
                      <div className="space-y-1">
                        <Label size="compact" className="block !font-normal" htmlFor="area-revoke-reason">{t(`${K}.revoke.reason`)}</Label>
                        <Textarea
                          id="area-revoke-reason"
                          data-testid="area-revoke-reason"
                          inputSize="dense"
                          rows={3}
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </div>
                      <PanelErrorAlert keyName={revokeError} />
                      <div className="flex gap-2 justify-end">
                        <Button type="button" size="compact" variant="ghost" onClick={() => setRevoking(null)}>{t(`${K}.revoke.cancel`)}</Button>
                        <Button type="submit" size="compact" variant="primary" disabled={!reason.trim() || busy} data-testid="area-revoke-confirm">
                          {t(`${K}.revoke.confirm`)}
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-t border-gray-300 pt-4">
          <form data-testid="area-drawer-grant-form" onSubmit={(e) => { void submitGrant(e); }}>
            <Heading level={4} weight="semibold" color="primary" className="mb-3">{t(`${K}.grant.title`)}</Heading>
            <AreaGrantFields area={area} role={role} onArea={changeArea} onRole={(r) => { setRole(r); setGrantError(null); }} />
            {grantError && <div className="mt-3"><PanelErrorAlert keyName={grantError} /></div>}
            <div className="flex justify-end mt-4">
              <Button type="submit" size="compact" variant="primary" className={FOCUS_RING_KEYBOARD_ONLY} disabled={busy} data-testid="area-grant-submit">{t(`${K}.grant.submit`)}</Button>
            </div>
          </form>
        </section>
      </aside>
    </>,
    document.body,
  );
}
