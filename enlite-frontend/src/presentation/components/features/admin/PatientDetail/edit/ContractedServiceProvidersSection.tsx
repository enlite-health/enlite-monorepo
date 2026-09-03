import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientContractedServiceProvider } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';

export interface WorkerHit {
  id: string;
  name: string;
}

export interface AssociateProviderDeps {
  patientId: string;
  serviceId: string;
  weeklyHours: string;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  errorMessage: string;
  onSuccess: () => void;
}

/**
 * Associa o worker selecionado ao serviço — extraída da closure do componente e EXPORTADA só
 * para teste direto (QA-caça #4): o botão que chama isto tem `disabled={!selected}`, e o React
 * NUNCA despacha o evento click de um elemento nativo disabled (verificado empiricamente — nem
 * forçar `disabled=false` direto no DOM ajuda, o React confere a prop `disabled` da própria
 * fiber, não o atributo do nó). O guarda `if (!selected) return` abaixo é por isso INALCANÇÁVEL
 * por qualquer clique simulado. Chamar esta função diretamente com `selected=null` é o único
 * jeito de exercitar essa branch.
 */
// eslint-disable-next-line react-refresh/only-export-components -- exportado só para teste direto (QA-caça #4), ver docblock acima.
export async function runAssociateProvider(selected: WorkerHit | null, deps: AssociateProviderDeps): Promise<void> {
  if (!selected) return;
  deps.setError(null);
  deps.setBusy(true);
  try {
    await AdminContractedServicesApiService.associateProvider(deps.patientId, deps.serviceId, {
      workerId: selected.id,
      weeklyHours: deps.weeklyHours.trim() ? Number(deps.weeklyHours) : null,
    });
    deps.onSuccess();
  } catch {
    deps.setError(deps.errorMessage);
  } finally {
    deps.setBusy(false);
  }
}

interface Props {
  patientId: string;
  serviceId: string;
  providers: PatientContractedServiceProvider[];
  onChanged: () => void;
}

/**
 * Prestadores alocados num serviço contratado (spec 013, bloco C, lex C-e). Associa worker
 * EXISTENTE por busca (reusa `GET /api/admin/workers?search=`, mesmo endpoint do resto do
 * painel — sem rota nova). Sem DELETE: baixa é `PATCH { active:false }` (C-e.2).
 */
export function ContractedServiceProvidersSection({ patientId, serviceId, providers, onChanged }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<WorkerHit[]>([]);
  const [selected, setSelected] = useState<WorkerHit | null>(null);
  const [weeklyHours, setWeeklyHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (term: string): Promise<void> => {
    setSearch(term);
    setSelected(null);
    if (term.trim().length < 2) {
      setHits([]);
      return;
    }
    const { data } = await AdminApiService.listWorkers({ search: term, limit: '5' });
    setHits(
      (data as Array<{ id: string; worker?: { name?: string }; name?: string }>).map((w) => ({
        id: w.id,
        name: w.worker?.name ?? w.name ?? w.id,
      })),
    );
  };

  const associate = (): Promise<void> =>
    runAssociateProvider(selected, {
      patientId,
      serviceId,
      weeklyHours,
      setBusy,
      setError,
      errorMessage: te('associateProviderError'),
      onSuccess: () => {
        setSearch('');
        setHits([]);
        setSelected(null);
        setWeeklyHours('');
        onChanged();
      },
    });

  const deactivate = async (providerId: string): Promise<void> => {
    setBusy(true);
    try {
      await AdminContractedServicesApiService.updateProvider(patientId, serviceId, providerId, { active: false });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-slate-100" data-testid={`providers-section-${serviceId}`}>
      <Text size="sm" weight="semibold" color="secondary">{te('providersTitle')}</Text>

      {providers.length === 0 ? (
        <Text size="sm" color="muted" data-testid={`providers-empty-${serviceId}`}>{te('noProviders')}</Text>
      ) : (
        <ul className="flex flex-col gap-2">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 text-sm" data-testid={`provider-row-${p.id}`}>
              <Text as="span" size="sm">
                {p.workerName ?? p.workerId} · {p.weeklyHours ?? '—'}h/sem ·{' '}
                {p.active ? te('providerActive') : te('providerInactive')}
              </Text>
              {p.active && (
                <button
                  type="button"
                  onClick={() => deactivate(p.id)}
                  aria-label={te('deactivateProvider')}
                  data-testid={`provider-deactivate-${p.id}`}
                  className="text-red-400 hover:text-red-600 transition-colors p-1 rounded"
                  disabled={busy}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
        {/* `InputWithIcon` tem raiz `w-full`: sem `min-w-0` aqui e sem uma caixa de largura
            fixa em volta do campo de horas, o campo de horas toma a linha inteira e a busca
            fica com 0px (medido no Playwright de 03/09: input "not visible"). */}
        <div className="flex-1 min-w-0 relative">
          <InputWithIcon
            inputSize="compact"
            placeholder={te('searchWorkerPlaceholder')}
            value={selected ? selected.name : search}
            onChange={(e) => runSearch(e.target.value)}
            data-testid={`provider-search-${serviceId}`}
          />
          {hits.length > 0 && !selected && (
            <ul className="absolute z-10 bg-white border border-slate-200 rounded-lg shadow-md w-full mt-1 max-h-40 overflow-y-auto">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
                    onClick={() => { setSelected(h); setHits([]); }}
                    data-testid={`provider-hit-${h.id}`}
                  >
                    {h.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="w-28 shrink-0">
          <InputWithIcon
            inputSize="compact"
            type="number"
            placeholder={te('weeklyHours')}
            value={weeklyHours}
            onChange={(e) => setWeeklyHours(e.target.value)}
            data-testid={`provider-weekly-hours-${serviceId}`}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={associate}
          isLoading={busy}
          disabled={!selected}
          data-testid={`provider-associate-${serviceId}`}
        >
          {te('associateProvider')}
        </Button>
      </div>
      {error && <Text size="sm" className="text-red-600">{error}</Text>}
    </div>
  );
}
