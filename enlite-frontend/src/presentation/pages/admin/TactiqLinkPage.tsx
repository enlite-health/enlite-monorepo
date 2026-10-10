/**
 * TactiqLinkPage — /admin/mi-cuenta/tactiq, "Vincular Tactiq" (spec 049, F7; §3.0.1 passo 1).
 *
 * O operador conecta a PRÓPRIA conta do Tactiq (OAuth): é o ato único que o sistema exige para ele poder ser
 * responsável de uma agenda de admissão. A tela mostra o estado do vínculo (sem token, nunca — a API não o envia),
 * o botão que inicia o OAuth (`POST /me/tactiq-link` → `{ authorizeUrl }` → redireciona o NAVEGADOR) e o resultado
 * da volta do callback (`?tactiq=linked|error&reason=`). Gates: `own_tactiq_link:read` abre a tela (a rota) e
 * `own_tactiq_link:create` libera o botão.
 *
 * Sem PII em log: nada aqui loga. O motivo do erro (`reason`) é um código curto do servidor e não é exibido cru.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { SealChip } from '@presentation/components/features/admin/PatientDetail/admission/AdmissionSeals';
import type { SealTone } from '@presentation/components/features/admin/PatientDetail/admission/sealTones';
import { formatInstant } from '@presentation/utils/dateTimeFormat';
import {
  AdminAdmissionApiService,
  type OwnTactiqLink,
  type TactiqLinkState,
} from '@infrastructure/http/AdminAdmissionApiService';

type LoadStatus = 'loading' | 'ok' | 'error';
type ReturnBanner = { kind: 'linked' } | { kind: 'error' } | null;

const STATE_TONE: Record<TactiqLinkState, SealTone> = {
  linked: 'ok',
  missing: 'warn',
  broken: 'bad',
  wrong_account: 'bad',
  revoked: 'warn',
};

/** O callback volta com `?tactiq=linked|error`; qualquer outro valor é ignorado (nunca vira banner). */
function bannerFrom(params: URLSearchParams): ReturnBanner {
  const outcome = params.get('tactiq');
  return outcome === 'linked' || outcome === 'error' ? { kind: outcome } : null;
}

interface Props {
  /** Redireciona o navegador para o OAuth do Tactiq (injetável: o jsdom não navega). */
  redirect?: (url: string) => void;
}

export default function TactiqLinkPage({ redirect = (url) => window.location.assign(url) }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const tt = (key: string): string => t(`admin.tactiqLink.${key}`);
  const [params, setParams] = useSearchParams();
  // Lê o resultado da volta UMA vez e limpa a URL: um F5 não pode repetir "vinculado com sucesso".
  const [banner] = useState<ReturnBanner>(() => bannerFrom(params));
  const [link, setLink] = useState<OwnTactiqLink | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);

  useEffect(() => {
    if (params.has('tactiq') || params.has('reason')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na montagem: o banner já foi guardado no estado
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    try {
      setLink(await AdminAdmissionApiService.getOwnTactiqLink());
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const start = async (): Promise<void> => {
    setStarting(true);
    setStartError(false);
    try {
      const { authorizeUrl } = await AdminAdmissionApiService.startTactiqLink();
      redirect(authorizeUrl);
    } catch {
      setStartError(true);
      setStarting(false);
    }
  };

  const locale = i18n.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'es-AR';
  const when = (iso: string | null): string => (iso ? formatInstant(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, locale) ?? '—' : '—');
  const state = link?.status;

  return (
    <div className="max-w-3xl flex flex-col gap-6" data-testid="tactiq-link-page">
      <div className="flex flex-col gap-1">
        <Heading level={1} weight="semibold" color="primary">{tt('title')}</Heading>
        <Text color="inherit" size="sm" className="text-slate-600">{tt('subtitle')}</Text>
      </div>

      {banner?.kind === 'linked' && (
        <Text color="inherit" as="p" size="sm" role="status" className="rounded-lg bg-green-100 text-green-900 px-4 py-3" data-testid="tactiq-banner-linked">{tt('returnLinked')}</Text>
      )}
      {banner?.kind === 'error' && (
        <Text color="inherit" as="p" size="sm" role="alert" className="rounded-lg bg-red-100 text-red-900 px-4 py-3" data-testid="tactiq-banner-error">{tt('returnError')}</Text>
      )}

      <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-8 flex flex-col gap-5" data-testid="tactiq-link-card">
        {status === 'loading' && <Text color="inherit" size="sm" className="text-slate-600" data-testid="tactiq-loading">{tt('loading')}</Text>}
        {status === 'error' && (
          <div className="flex items-center gap-3" role="alert">
            <Text color="inherit" size="sm" className="text-red-800" data-testid="tactiq-load-error">{tt('loadError')}</Text>
            <button type="button" onClick={() => { void load(); }} className="text-primary underline text-sm" data-testid="tactiq-retry">{tt('retry')}</button>
          </div>
        )}
        {status === 'ok' && state && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Text as="span" size="2xs" color="primary" className="uppercase">{tt('stateLabel')}</Text>
              <SealChip tone={STATE_TONE[state]} testId="tactiq-state">{tt(`state.${state}`)}</SealChip>
            </div>
            <Text color="inherit" size="sm" className="text-gray-900" data-testid="tactiq-state-help">{tt(`stateHelp.${state}`)}</Text>
            {state === 'linked' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <Text as="span" size="2xs" color="primary" className="uppercase">{tt('linkedAt')}</Text>
                  <Text color="inherit" as="span" size="sm" weight="medium" className="text-gray-900" data-testid="tactiq-linked-at">{when(link.linkedAt)}</Text>
                </div>
                <div className="flex flex-col gap-1">
                  <Text as="span" size="2xs" color="primary" className="uppercase">{tt('lastCheckAt')}</Text>
                  <Text color="inherit" as="span" size="sm" weight="medium" className="text-gray-900" data-testid="tactiq-last-check-at">{when(link.lastCheckAt)}</Text>
                </div>
              </div>
            )}
            <div className="flex flex-col items-start gap-2">
              <ActionButton
                resource="own_tactiq_link"
                action="create"
                variant="primary"
                size="md"
                onClick={() => { void start(); }}
                disabled={starting}
                data-testid="tactiq-link-button"
              >
                {starting ? tt('starting') : state === 'linked' ? tt('relink') : tt('link')}
              </ActionButton>
              {startError && <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="tactiq-start-error">{tt('startError')}</Text>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
