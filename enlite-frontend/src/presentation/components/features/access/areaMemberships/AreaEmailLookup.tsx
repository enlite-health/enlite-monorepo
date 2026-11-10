import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Label, Text } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { PanelErrorAlert } from '@presentation/components/features/access/PanelErrorAlert';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { AreaPerson } from '@domain/entities/AreaMembership';
import { AreaPersonAvatar } from './AreaPersonAvatar';
import { AreaPersonKindBadge } from './AreaPersonKindBadge';
import { BUTTON_35, DENSE_PLACEHOLDER } from './formStyles';

const K = 'admin.access.areaMemberships.lookup';

/** `null` = ainda não buscou; `'none'` = o servidor disse 404; senão, a pessoa achada. */
export type LookupResult = AreaPerson | 'none' | null;

interface AreaEmailLookupProps {
  /** O resultado vive no pai: o painel atualiza a pessoa achada depois de conceder/revogar. */
  result: LookupResult;
  onResult: (result: LookupResult) => void;
  canWrite: boolean;
  onManage: (person: AreaPerson) => void;
  onClose: () => void;
}

/** Já "tem ficha" na lista? Sem personId, ou conta de login sem nenhum vínculo, a pessoa não aparece nela. */
function isOffList(p: AreaPerson): boolean {
  return p.personId === null || (p.kind === 'account' && p.memberships.length === 0);
}

/**
 * Busca por e-mail EXATO no login (Firebase) — para quem tem conta mas nenhuma ficha nem vínculo e por isso
 * não está na lista. É GET: achar não escreve nada; criar a ficha só acontece ao conceder (por `uid`).
 */
export function AreaEmailLookup({ result, onResult, canWrite, onManage, onClose }: AreaEmailLookupProps): JSX.Element {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      onResult(await AdminApiService.findAreaPersonByEmail(value));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) onResult('none');
      else { onResult(null); setError(`${K}.error`); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="bg-white rounded-xl border border-gray-400 p-4"
      data-testid="lookup"
      onSubmit={(e) => { void submit(e); }}
    >
      <Text size="sm" weight="medium" color="primary">{t(`${K}.title`)}</Text>
      <Text size="xs" color="tertiary" className="mb-2">{t(`${K}.help`)}</Text>
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[14rem] max-w-[26rem] space-y-1">
          <Label size="compact" htmlFor="area-lookup-email">{t(`${K}.email`)}</Label>
          <Input
            id="area-lookup-email"
            data-testid="area-lookup-email"
            type="email"
            inputSize="dense"
            autoComplete="off"
            className={DENSE_PLACEHOLDER}
            placeholder={t(`${K}.placeholder`)}
            value={email}
            onChange={(e) => { setEmail(e.target.value); onResult(null); setError(null); }}
          />
        </div>
        <Button type="submit" size="compact" variant="primary" className={BUTTON_35} disabled={!email.trim() || busy} data-testid="area-lookup-submit">
          {t(`${K}.submit`)}
        </Button>
        <Button type="button" size="compact" variant="ghost" className={BUTTON_35} onClick={onClose} data-testid="area-lookup-close">
          {t(`${K}.cancel`)}
        </Button>
      </div>
      <PanelErrorAlert keyName={error} />
      {result === 'none' && (
        <Text size="sm" color="primary" role="status" className="mt-1" data-testid="lookup-none">{t(`${K}.none`)}</Text>
      )}
      {result && result !== 'none' && (
        <div
          className="mt-3 border border-gray-600 rounded-xl bg-gray-200 p-4 flex items-center justify-between gap-4 flex-wrap"
          data-testid="lookup-card"
        >
          <div className="flex items-center gap-3 min-w-0">
            <AreaPersonAvatar name={result.displayName} />
            <div className="min-w-0">
              <Text size="sm" weight="medium" color="primary">{result.displayName}</Text>
              <Text size="xs" color="tertiary">{result.email}</Text>
              <Text size="xs" color="tertiary" className="mt-0.5">{t(isOffList(result) ? `${K}.newAccount` : `${K}.inList`)}</Text>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <AreaPersonKindBadge kind={result.kind} />
            {canWrite && (
              <Button type="button" size="xs" variant="quiet" data-testid="area-lookup-manage" onClick={() => onManage(result)}>
                {t('admin.access.areaMemberships.manage')}
              </Button>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
