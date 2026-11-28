/**
 * PresenceReviewPage — `/admin/presencia/revision` (emenda 077 §6): a fila de revisão de presença da coordenação. Atrás da célula
 * `presence_exception:review` (o Acesso Master a recebe pelo sync do catálogo). Molde: `PedidosIaPage` (gate por célula, estados carregando/erro,
 * filtros em Combobox). Sem a célula, a tela diz "Sin acceso" (não redireciona) e NÃO chama a API; a API também responde 403 (e a página cai no mesmo aviso).
 * O ESTADO (pendente/decidido) é do attendance: a tela não recalcula nada — depois de decidir, RELÊ a fila (read-back).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCellAccess, useHasCell } from '@presentation/hooks/useCellAccess';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { Combobox } from '@presentation/components/atoms/Combobox';
import {
  AdminPresenceReviewApiService,
  REVIEW_KINDS,
  type PresenceDecision,
  type PresenceReviewItem,
  type ResolutionCode,
  type ReviewKind,
} from '@infrastructure/http/AdminPresenceReviewApiService';
import { PresenceReviewTable } from './PresenceReviewTable';
import { ResolutionDialog } from './ResolutionDialog';
import { isForbidden, presenceReviewErrorKey } from './presenceReviewErrors';

// Tinta AAA (>= 7:1 sobre branco) dos filtros: o gatilho padrao do Combobox (#737373) da 4,74:1.
const FILTRO_VALOR = 'text-[#262626]';
const FILTRO_PLACEHOLDER = 'text-[#404040]';

export function PresenceReviewPage(): JSX.Element {
  const { t } = useTranslation();
  const access = useCellAccess('presence_exception');
  const hasCell = useHasCell('presence_exception', 'review');
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);

  const [items, setItems] = useState<PresenceReviewItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [country, setCountry] = useState('');
  const [countries, setCountries] = useState<string[]>([]);
  const [kind, setKind] = useState<ReviewKind | ''>('');
  const [carga, setCarga] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [ocupado, setOcupado] = useState(false);
  const [modal, setModal] = useState<{ item: PresenceReviewItem; decision: PresenceDecision } | null>(null);
  const [modalErro, setModalErro] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  // Com o engine do front LIGADO, sem a célula a tela nem tenta; com ele desligado, quem decide é a API (403 → "Sin acceso").
  const semAcesso = access.status === 'ready' && enforcement === 'on' && !hasCell;
  const pronto = access.status === 'ready' && !semAcesso;

  useEffect(() => {
    if (!pronto) return;
    let vivo = true;
    setCarga('loading');
    AdminPresenceReviewApiService.getQueue({ country: country || undefined, kind: kind || undefined })
      .then((page) => {
        if (!vivo) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setCountries(page.countries);
        setCarga('ready');
      })
      .catch((err) => vivo && setCarga(isForbidden(err) ? 'forbidden' : 'error'));
    return () => {
      vivo = false;
    };
  }, [pronto, country, kind, recarga]);

  const carregarMais = useCallback(async () => {
    if (!nextCursor) return;
    setOcupado(true);
    try {
      const page = await AdminPresenceReviewApiService.getQueue({ country: country || undefined, kind: kind || undefined, cursor: nextCursor });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setCarga(isForbidden(err) ? 'forbidden' : 'error');
    } finally {
      setOcupado(false);
    }
  }, [nextCursor, country, kind]);

  const confirmar = async (code: ResolutionCode) => {
    if (!modal) return;
    setModalErro(null);
    setOcupado(true);
    try {
      await AdminPresenceReviewApiService.decide(modal.item.id, modal.decision, code);
      setModal(null);
      setRecarga((n) => n + 1); // read-back: a fila vem de novo do attendance, a tela não tira o item sozinha
    } catch (err) {
      if (isForbidden(err)) {
        setModal(null);
        setCarga('forbidden');
      } else {
        const key = presenceReviewErrorKey(err);
        setModalErro(key);
        if (key === 'admin.presenceReview.errors.alreadyDecided') setRecarga((n) => n + 1); // a fila já mudou: relê
      }
    } finally {
      setOcupado(false);
    }
  };

  if (access.status === 'idle' || access.status === 'loading') {
    return <p className="text-sm text-[#404040]">{t('admin.presenceReview.loading')}</p>;
  }
  if (access.status === 'error') {
    return <div role="alert" className="text-sm font-medium text-[#7A0C0C]">{t('admin.presenceReview.authzError')}</div>;
  }
  if (semAcesso || carga === 'forbidden') {
    return (
      <div data-testid="presence-no-access" role="alert" className="mx-auto w-full max-w-4xl space-y-1">
        <h1 className="text-2xl font-semibold text-[#1A1A1A]">{t('admin.presenceReview.noAccess.title')}</h1>
        <p className="text-sm text-[#404040]">{t('admin.presenceReview.noAccess.message')}</p>
      </div>
    );
  }

  return (
    <div data-testid="presence-review-page" className="mx-auto w-full max-w-6xl space-y-4 overflow-x-hidden">
      <div>
        <h1 className="text-2xl font-semibold text-[#1A1A1A]">{t('admin.presenceReview.title')}</h1>
        <p className="text-sm text-[#404040]">{t('admin.presenceReview.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm font-medium text-[#262626]">
          <label htmlFor="presence-filter-kind">{t('admin.presenceReview.filters.kind')}</label>
          <Combobox
            valueClassName={FILTRO_VALOR}
            placeholderClassName={FILTRO_PLACEHOLDER}
            id="presence-filter-kind"
            data-testid="presence-filter-kind"
            options={REVIEW_KINDS.map((k) => ({ value: k, label: t(`admin.presenceReview.kinds.${k}`) }))}
            value={kind}
            onChange={(v) => setKind(v as ReviewKind | '')}
            placeholder={t('admin.presenceReview.filters.allKinds')}
            clearLabel={t('admin.presenceReview.filters.allKinds')}
          />
        </div>
        {countries.length > 1 && (
          <div className="flex flex-col gap-1 text-sm font-medium text-[#262626]">
            <label htmlFor="presence-filter-country">{t('admin.presenceReview.filters.country')}</label>
            <Combobox
              valueClassName={FILTRO_VALOR}
              placeholderClassName={FILTRO_PLACEHOLDER}
              id="presence-filter-country"
              data-testid="presence-filter-country"
              options={countries.map((c) => ({ value: c, label: c }))}
              value={country || countries[0]}
              onChange={setCountry}
            />
          </div>
        )}
      </div>

      {carga === 'loading' && <p className="text-sm text-[#404040]">{t('admin.presenceReview.loading')}</p>}
      {carga === 'error' && (
        <div role="alert" data-testid="presence-error" className="text-sm font-medium text-[#7A0C0C]">{t('admin.presenceReview.errors.load')}</div>
      )}
      {carga === 'ready' && items.length === 0 && (
        <p data-testid="presence-empty" className="text-sm text-[#404040]">{t('admin.presenceReview.empty')}</p>
      )}
      {carga === 'ready' && items.length > 0 && (
        <PresenceReviewTable items={items} ocupado={ocupado} onDecidir={(item, decision) => { setModalErro(null); setModal({ item, decision }); }} />
      )}
      {carga === 'ready' && nextCursor && (
        <button type="button" data-testid="presence-load-more" disabled={ocupado} onClick={() => void carregarMais()} className="min-h-[44px] rounded-lg border-2 border-[#262626] bg-white px-4 text-sm font-semibold text-[#262626] disabled:opacity-60">
          {t('admin.presenceReview.loadMore')}
        </button>
      )}

      {modal && (
        <ResolutionDialog decision={modal.decision} enviando={ocupado} erroKey={modalErro} onConfirmar={(c) => void confirmar(c)} onCancelar={() => setModal(null)} />
      )}
    </div>
  );
}
