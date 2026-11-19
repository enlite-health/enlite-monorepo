import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PointsMap, type MapRing } from '@presentation/components/molecules/PointsMap/PointsMap';
import type { JobRadiusKm } from '@domain/entities/WorkerJobByRadius';
import type { WorkerJobsByRadiusState } from '@presentation/hooks/useWorkerJobsByRadius';
import { groupByRegion, itemsWithin, nextRadius } from './radiusScope';
import { RadiusSlider } from './RadiusSlider';
import { useInView } from './useInView';

interface JobsRadiusMapProps {
  state: WorkerJobsByRadiusState;
  radiusKm: JobRadiusKm;
  onRadiusChange: (radiusKm: JobRadiusKm) => void;
}

const RING = (radiusKm: number): MapRing => ({
  radiusKm, stroke: '#180149', strokeWeight: 2, fill: '#180149', fillOpacity: 0.08, label: '', labelTone: 'current',
});

/**
 * JobsRadiusMap — mapa com o círculo do raio em volta do endereço do PRÓPRIO prestador, contagem por região em chips e o
 * controle de raio (spec 096). Sem marcador por vaga/região (DD-5: seria o endereço do paciente). Sem geocodificação nem
 * autocomplete: só o `PointsMap`, com o script carregado quando a seção entra na viewport (DD-8). O mapa é visualização: sem
 * chave, o placeholder assume e chips/contagem/lista seguem.
 */
export function JobsRadiusMap({ state, radiusKm, onRadiusChange }: JobsRadiusMapProps): JSX.Element | null {
  const { t } = useTranslation();
  const { ref, inView } = useInView<HTMLDivElement>();
  const data = state.status === 'ok' ? state.data : null;
  const inRadius = useMemo(() => (data ? itemsWithin(data.items, radiusKm) : []), [data, radiusKm]);
  const regions = useMemo(() => groupByRegion(inRadius), [inRadius]);
  const rings = useMemo(() => [RING(radiusKm)], [radiusKm]);

  if (state.status === 'loading') {
    return <div data-testid="radius-loading" className="mb-6 h-24 animate-pulse rounded-[20px] bg-gray-100" />;
  }

  const card = (testId: string, text: string): JSX.Element => (
    <div data-testid={testId} className="mb-6 rounded-[20px] border border-[#d9d9d9] bg-white p-6 font-lexend">
      <p className="text-sm font-medium text-[#180149]">{text}</p>
    </div>
  );

  // 'incomplete' e 'idle' não desenham o mapa: quem decide é a home (aviso de cadastro / lista de sempre).
  if (state.status === 'incomplete' || state.status === 'idle') return null;
  if (state.status === 'inactive') return card('radius-inactive', t('jobsRadius.inactive'));
  if (state.status === 'error' || !data) return card('radius-error', t('jobsRadius.error'));

  const next = nextRadius(radiusKm);
  return (
    <section data-testid="jobs-radius-section" aria-label={t('jobsRadius.title')} className="mb-6 rounded-[20px] border border-[#d9d9d9] bg-white p-4 md:p-6">
      <h2 className="mb-4 font-lexend text-xl font-semibold text-[#180149]">{t('jobsRadius.title')}</h2>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div ref={ref} data-testid="radius-map-box" className="min-w-0">
          {inView ? (
            <PointsMap
              points={[]}
              center={data.center}
              radiusKm={null}
              rings={rings}
              fitRadiusKm={radiusKm}
              centerIcon="house"
              centerLabel={t('jobsRadius.centerLabel')}
              placeholderText={t('jobsRadius.mapUnavailable')}
              height={320}
            />
          ) : (
            <div className="h-[320px] rounded-[10px] bg-gray-100" data-testid="radius-map-pending" />
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <RadiusSlider value={radiusKm} count={inRadius.length} onChange={onRadiusChange} />
          {inRadius.length === 0 ? (
            <div data-testid="radius-empty" className="font-lexend text-sm text-[#180149]">
              <p className="font-medium">{t('jobsRadius.empty', { n: radiusKm })}</p>
              {next !== null && (
                <button
                  type="button"
                  onClick={() => onRadiusChange(next)}
                  data-testid="radius-widen"
                  className="mt-2 rounded-full border border-[#180149] px-4 py-1.5 text-sm font-medium text-[#180149] hover:bg-[#180149] hover:text-white"
                >
                  {t('jobsRadius.widen', { n: next })}
                </button>
              )}
            </div>
          ) : (
            <ul data-testid="radius-regions" className="flex flex-wrap gap-2">
              {regions.map((r) => (
                <li key={r.key || 'sin-barrio'} data-testid="radius-region" className="rounded-full bg-[#f3f0fa] px-3 py-1 font-lexend text-xs font-medium text-[#180149]">
                  {r.label || t('jobsRadius.noNeighborhood')} · {r.count}
                </li>
              ))}
            </ul>
          )}
          {!data.applied.schedule && (
            <p data-testid="radius-availability-hint" className="font-lexend text-xs text-[#737373]">{t('jobsRadius.completeAvailability')}</p>
          )}
          <p className="font-lexend text-xs text-[#737373]">{t('jobsRadius.privacyFooter')}</p>
        </div>
      </div>
    </section>
  );
}
