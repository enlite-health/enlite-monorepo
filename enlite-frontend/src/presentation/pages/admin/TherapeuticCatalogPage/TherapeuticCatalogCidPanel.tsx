/**
 * Painel de CIDs (spec 091, §9.7/DD-2/DD-16/DD-20): drawer lateral com as categorias CID-11 de um
 * objetivo ou de uma atividade. Objetivo: busca em `icd-categories`; atividade: só as categorias do
 * objetivo ainda não ligadas. Remover categoria de objetivo com `activityLinks>0` pede confirmação.
 * Sem `canWrite` (célula `:update`) o painel é só leitura. A porta `TherapeuticCatalogGateway` entra por
 * prop (default = adaptador HTTP); o teste usa um fake dela.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';
import type { CategoryLink, IcdCategory } from '@domain/entities/TherapeuticProject';

export type CidPanelKind = 'objective' | 'activity';

/** Strategy por kind: de onde vem a lista, como adiciona/remove e de onde saem os candidatos. */
interface CidLinkSource {
  list(): Promise<{ total: number; items: CategoryLink[] }>;
  add(code: string): Promise<unknown>;
  remove(code: string): Promise<unknown>;
  /** Candidatos a "Agregar", já sem os ligados. `null` = o kind não tem busca (usa o select). */
  searchCandidates?(q: string): Promise<IcdCategory[]>;
  selectCandidates?(): Promise<IcdCategory[]>;
}

class ObjectiveLinkSource implements CidLinkSource {
  constructor(private readonly gw: TherapeuticCatalogGateway, private readonly id: string) {}
  list() { return this.gw.listObjectiveCategories(this.id); }
  add(code: string) { return this.gw.addObjectiveCategory(this.id, code); }
  remove(code: string) { return this.gw.removeObjectiveCategory(this.id, code); }
  searchCandidates(q: string) { return this.gw.searchIcdCategories(q); }
}

class ActivityLinkSource implements CidLinkSource {
  constructor(private readonly gw: TherapeuticCatalogGateway, private readonly id: string, private readonly objectiveId: string) {}
  list() { return this.gw.listActivityCategories(this.id); }
  add(code: string) { return this.gw.addActivityCategory(this.id, code); }
  remove(code: string) { return this.gw.removeActivityCategory(this.id, code); }
  async selectCandidates() {
    const { items } = await this.gw.listObjectiveCategories(this.objectiveId);
    return items.map((c) => ({ code: c.code, title: c.title ?? '' }));
  }
}

const SOURCE_BY_KIND: Record<CidPanelKind, (p: Props, gw: TherapeuticCatalogGateway) => CidLinkSource> = {
  objective: (p, gw) => new ObjectiveLinkSource(gw, p.itemId),
  activity: (p, gw) => new ActivityLinkSource(gw, p.itemId, p.objectiveId ?? ''),
};

interface Props {
  kind: CidPanelKind;
  /** Id do objetivo ou da atividade. */
  itemId: string;
  itemLabel: string;
  /** Só `activity`: objetivo dono, de onde saem as categorias elegíveis. */
  objectiveId?: string;
  isOpen: boolean;
  onClose: () => void;
  /** `false` = sem `:update`: sem Agregar/Quitar. */
  canWrite: boolean;
  /** Avisa a tela que a contagem mudou (recarregar a lista). */
  onChanged?: (total: number) => void;
  gateway?: TherapeuticCatalogGateway;
}

const MIN_QUERY = 2;

export function TherapeuticCatalogCidPanel(props: Props): JSX.Element {
  const { kind, itemId, itemLabel, isOpen, onClose, canWrite, onChanged, gateway = AdminTherapeuticProjectsApiService } = props;
  const { t } = useTranslation();
  const tr = (k: string, fallback: string, o?: Record<string, unknown>) =>
    t(`admin.therapeuticCatalog.${k}`, { defaultValue: fallback, ...(o ?? {}) });

  const source = useMemo(() => SOURCE_BY_KIND[kind](props, gateway), [kind, itemId, props.objectiveId, gateway]); // eslint-disable-line react-hooks/exhaustive-deps
  const [links, setLinks] = useState<CategoryLink[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<IcdCategory[]>([]);
  const [eligible, setEligible] = useState<IcdCategory[]>([]);
  const [pendingRemove, setPendingRemove] = useState<CategoryLink | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const r = await source.list();
    setLinks(r.items);
    setTotal(r.total);
    return r.total;
  }, [source]);

  useEffect(() => {
    if (!isOpen) return;
    setPendingRemove(null); setFilter(''); setQuery(''); setFound([]); setFailed(false);
    reload().catch(() => setFailed(true));
    source.selectCandidates?.().then(setEligible).catch(() => setFailed(true));
  }, [isOpen, source, reload]);

  useEffect(() => {
    if (!source.searchCandidates || query.trim().length < MIN_QUERY) { setFound([]); return; }
    let live = true;
    source.searchCandidates(query.trim()).then((r) => { if (live) setFound(r); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [query, source]);

  const linkedCodes = useMemo(() => new Set(links.map((l) => l.code)), [links]);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return links;
    return links.filter((l) => l.code.toLowerCase().includes(f) || (l.title ?? '').toLowerCase().includes(f));
  }, [links, filter]);
  const addable = useMemo(
    () => (source.searchCandidates ? found : eligible).filter((c) => !linkedCodes.has(c.code)),
    [source, found, eligible, linkedCodes],
  );

  const apply = async (op: () => Promise<unknown>) => {
    setFailed(false);
    try { await op(); const n = await reload(); onChanged?.(n); } catch { setFailed(true); }
  };
  const add = (code: string) => { setQuery(''); setFound([]); return apply(() => source.add(code)); };
  const doRemove = (code: string) => { setPendingRemove(null); return apply(() => source.remove(code)); };
  const askRemove = (l: CategoryLink) => ((l.activityLinks ?? 0) > 0 ? setPendingRemove(l) : doRemove(l.code));

  return (
    <SlideOverPanel isOpen={isOpen} onClose={onClose} modal ariaLabel={tr('icdPanelTitle', 'Diagnósticos CIE-11 donde aparece')}
      closeAriaLabel={t('common.close')} testId="therapeutic-catalog-cid-panel" widthClassName="max-w-lg">
      <div className="flex flex-col h-full p-6 gap-4 overflow-y-auto">
        <header>
          <h2 className="text-lg font-semibold">{tr('icdPanelTitle', 'Diagnósticos CIE-11 donde aparece')}</h2>
          <p className="text-sm text-gray-600" data-testid="cid-panel-item">{itemLabel}</p>
          <p className="text-sm font-medium" data-testid="cid-panel-count">{tr('icdCount', '{{count}} categorías', { count: total })}</p>
        </header>

        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="cid-panel-filter"
          aria-label={tr('icdSearch', 'Buscar código o diagnóstico')} placeholder={tr('icdSearch', 'Buscar código o diagnóstico')}
          className="border rounded px-3 py-2 text-sm" />

        {failed && <p role="alert" className="text-sm text-red-600" data-testid="cid-panel-error">{tr('icdError', 'No se pudo completar la operación.')}</p>}

        <ul className="divide-y" data-testid="cid-panel-list">
          {visible.map((l) => (
            <li key={l.code} className="py-2 flex items-center justify-between gap-2" data-testid={`cid-panel-row-${l.code}`}>
              <span className="text-sm">{l.code} — {l.title ?? tr('icdNotInRelease', 'No está en la versión CIE-11 vigente')}</span>
              {canWrite && (
                <button type="button" className="text-sm text-red-600 underline" data-testid={`cid-panel-remove-${l.code}`}
                  onClick={() => askRemove(l)}>{tr('icdRemove', 'Quitar')}</button>
              )}
            </li>
          ))}
        </ul>

        {pendingRemove && (
          <div role="alertdialog" className="border border-amber-400 bg-amber-50 rounded p-3 text-sm" data-testid="cid-panel-confirm">
            <p>{tr('icdRemoveCascade', 'Se quitarán también {{count}} vínculos de actividades', { count: pendingRemove.activityLinks })}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" data-testid="cid-panel-confirm-yes" className="text-red-700 underline" onClick={() => doRemove(pendingRemove.code)}>
                {tr('icdRemove', 'Quitar')} {pendingRemove.code}
              </button>
              <button type="button" data-testid="cid-panel-confirm-no" className="underline" onClick={() => setPendingRemove(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {canWrite && (
          <section data-testid="cid-panel-add" className="border-t pt-3 flex flex-col gap-2">
            <h3 className="text-sm font-medium">{tr('icdAdd', 'Agregar')}</h3>
            {source.searchCandidates && (
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="cid-panel-add-search"
                aria-label={tr('icdSearch', 'Buscar código o diagnóstico')} placeholder={tr('icdSearch', 'Buscar código o diagnóstico')}
                className="border rounded px-3 py-2 text-sm" />
            )}
            {source.searchCandidates ? (
              <ul>
                {addable.map((c) => (
                  <li key={c.code} className="py-1 flex items-center justify-between gap-2" data-testid={`cid-panel-candidate-${c.code}`}>
                    <span className="text-sm">{c.code} — {c.title}</span>
                    <button type="button" className="text-sm underline" data-testid={`cid-panel-add-${c.code}`} onClick={() => add(c.code)}>
                      {tr('icdAdd', 'Agregar')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Combobox value="" data-testid="cid-panel-add-select" aria-label={tr('icdAdd', 'Agregar')}
                placeholder={tr('icdAdd', 'Agregar')} onChange={(v) => v && add(v)}
                options={addable.map((c) => ({ value: c.code, label: `${c.code} — ${c.title}` }))} />
            )}
          </section>
        )}
      </div>
    </SlideOverPanel>
  );
}
