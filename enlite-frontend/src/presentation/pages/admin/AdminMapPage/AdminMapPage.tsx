/**
 * AdminMapPage — /admin/mapa · os DOIS mapas (DEC-14): prestadores e pacientes.
 *
 * O que o recrutador faz aqui (REQ-04, Javier): vê onde estão os prestadores
 * perto de um paciente, filtra por distância, por província/localidade e por
 * "documentação completa" — INCLUINDO quem não terminou o registro — e abre
 * o perfil para convidar. A lista lateral mostra os mesmos pontos do mapa
 * (e quem não tem coordenada, que o mapa não consegue mostrar).
 *
 * Escopo sempre presente (lex C3): raio a partir de um centro, que nasce no
 * centro padrão do PAÍS (CABA para AR, São Paulo para BR) e muda por clique
 * no mapa ou escolhendo um paciente. Sem geocoding, sem endereço digitado
 * (lex C7). País é filtro de primeira classe (C4).
 *
 * Só a aba visível busca: a outra fica parada até ser aberta, e o seletor
 * "centrar en paciente" só busca depois que alguém o toca — abrir a página
 * custa UMA request, não três.
 *
 * A coluna esquerda é lida em TRÊS passos numerados — centro, filtros,
 * resultados — porque a tela não se explica sozinha: sem isso o "Centrar en
 * un paciente", que é a pergunta que a tela responde, parecia só mais um
 * dropdown no meio da pilha.
 *
 * Lista e mapa são a MESMA coisa vista de dois jeitos: o cursor na linha
 * engorda o pino, o cursor no pino acende a linha, e escolher leva a viewport
 * até o ponto. O centro tem identidade legível ("Centro: Fulano") e volta
 * atrás — um clique errado não pode apagar a referência de trabalho.
 */
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { PointsMap, type MapPoint } from '@presentation/components/molecules/PointsMap/PointsMap';
import { CenterLabel, Field, Legend, NoLocationNotice, Searching, Step } from './mapSidebar';
import { usePatientsMapPoints, useWorkersMapPoints } from '@hooks/admin/useMapPoints';
import type { MapCountry, PatientsMapFilters, WorkersMapFilters } from '@infrastructure/http/AdminMapApiService';
import { getCountryOptions } from '../patientsData';
import {
  DEFAULT_CENTER, DEFAULT_CENTER_BY_COUNTRY, DEFAULT_COUNTRY, DEFAULT_RADIUS_KM, PATIENT_STATUSES, PATIENT_STATUS_COLOR,
  PROFESSIONS, RADIUS_OPTIONS_KM, WORKER_STATUS_COLOR, distanceLabel, legendEntries, patientDetails, patientPointTitle,
  patientStatusLabel, placeLabel, professionLabel, sameCenter, workerDetails, workerPointTitle,
} from './mapPageConfig';

type Kind = 'workers' | 'patients';
type Docs = 'all' | 'complete' | 'incomplete';
interface PickedPatient { id: string; label: string; lat: number; lng: number }

/** Clicar no nome abre a ficha — sem também selecionar a linha. */
const stopRowSelect = (e: MouseEvent): void => e.stopPropagation();

export function AdminMapPage(): JSX.Element {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('workers');
  const [country, setCountry] = useState<MapCountry>(DEFAULT_COUNTRY);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [docs, setDocs] = useState<Docs>('all');
  const [profession, setProfession] = useState<string>('');
  const [patientStatus, setPatientStatus] = useState<string>('');
  const [onlyOpenVacancies, setOnlyOpenVacancies] = useState(false);
  const [centerPatientId, setCenterPatientId] = useState<string>('');
  const [pickerTouched, setPickerTouched] = useState(false);
  const [lastPatient, setLastPatient] = useState<PickedPatient | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const workersFilters = useMemo<WorkersMapFilters>(() => ({
    country,
    center,
    radius_km: radiusKm,
    ...(docs !== 'all' ? { docs_complete: docs } : {}),
    ...(profession ? { profession: [profession] } : {}),
  }), [country, center, radiusKm, docs, profession]);

  const patientsFilters = useMemo<PatientsMapFilters>(() => ({
    country,
    center,
    radius_km: radiusKm,
    ...(patientStatus ? { status: [patientStatus] } : {}),
    ...(onlyOpenVacancies ? { with_open_vacancies: true } : {}),
  }), [country, center, radiusKm, patientStatus, onlyOpenVacancies]);

  // Seletor "centrar en paciente" (aba de prestadores): os pacientes do MESMO
  // centro e raio que o mapa mostra — o que o recrutador vê é o que ele pode
  // escolher. Escopo obrigatório, então nunca "todos".
  const pickerFilters = useMemo<PatientsMapFilters>(() => ({ country, center, radius_km: radiusKm }), [country, center, radiusKm]);

  const workers = useWorkersMapPoints(workersFilters, kind === 'workers');
  const patients = usePatientsMapPoints(patientsFilters, kind === 'patients');
  const picker = usePatientsMapPoints(pickerFilters, kind === 'workers' && pickerTouched);

  const active = kind === 'workers' ? workers : patients;

  const onCenterChange = useCallback((c: { lat: number; lng: number }) => {
    setCenter(c);
    setCenterPatientId('');   // o seletor deixa de refletir o centro...
    setSelectedId(null);
    setHoveredId(null);
  }, []);                     // ...mas `lastPatient` FICA, senão não há como voltar.

  const onCountryChange = (v: string): void => {
    const next = v as MapCountry;
    setCountry(next);
    // Cada país tem o seu centro: BR não pode nascer em Buenos Aires.
    onCenterChange(DEFAULT_CENTER_BY_COUNTRY[next]);
    setLastPatient(null);     // o paciente de referência era do país anterior
  };

  const onPickPatient = (id: string): void => {
    setCenterPatientId(id);
    const p = picker.points.find((x) => x.id === id || x.addressId === id);
    if (p && p.lat !== null && p.lng !== null) {
      setCenter({ lat: p.lat, lng: p.lng });
      setLastPatient({ id, label: p.name, lat: p.lat, lng: p.lng });
      setSelectedId(null);
    }
  };

  // "Centrar aquí" do balão: mesma coisa que clicar no mapa naquele ponto — com
  // o mapa cheio de pinos, o clique que queria ser "aqui" acerta uma pessoa.
  const onCenterHere = useCallback((p: MapPoint) => {
    if (p.lat === null || p.lng === null) return;
    onCenterChange({ lat: p.lat, lng: p.lng });
  }, [onCenterChange]);

  const atCountryCenter = sameCenter(center, DEFAULT_CENTER_BY_COUNTRY[country]);
  const atLastPatient = !!lastPatient && sameCenter(center, { lat: lastPatient.lat, lng: lastPatient.lng });
  const centerLabel = atLastPatient && lastPatient
    ? lastPatient.label
    : atCountryCenter
      ? t('admin.map.center.initial', 'punto inicial')
      : t('admin.map.center.marked', 'punto marcado en el mapa');

  const onBack = (): void => {
    if (lastPatient) {
      setCenter({ lat: lastPatient.lat, lng: lastPatient.lng });
      setCenterPatientId(lastPatient.id);
    } else {
      setCenter(DEFAULT_CENTER_BY_COUNTRY[country]);
    }
    setSelectedId(null);
  };

  const mapPoints = useMemo<MapPoint[]>(() => {
    if (kind === 'workers') {
      return workers.points.map((p) => ({
        id: p.id, lat: p.lat, lng: p.lng, title: p.name, details: workerDetails(t, p),
        distance: distanceLabel(p.distanceKm) || null, tooltip: workerPointTitle(t, p),
        color: WORKER_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/workers/${p.id}`,
      }));
    }
    return patients.points.map((p) => ({
      id: p.addressId ?? p.id, lat: p.lat, lng: p.lng, title: p.name, details: patientDetails(t, p),
      distance: distanceLabel(p.distanceKm) || null, tooltip: patientPointTitle(t, p),
      color: PATIENT_STATUS_COLOR[p.status] ?? '#6b7280', href: `/admin/patients/${p.id}`,
    }));
  }, [kind, workers.points, patients.points, t]);

  // Escolher quem NÃO tem coordenada não pode ser silêncio: o mapa não muda e
  // o balão não abre, e sem aviso isso se lê como tela travada.
  const selectedWithoutLocation = useMemo<string | null>(() => {
    if (!selectedId) return null;
    const p = mapPoints.find((x) => x.id === selectedId);
    return p && p.lat === null ? p.title : null;
  }, [selectedId, mapPoints]);

  const radiusOptions: SelectOption[] = RADIUS_OPTIONS_KM.map((km) => ({ value: String(km), label: `${km} km` }));
  const countryOptions: SelectOption[] = getCountryOptions(t);
  const docsOptions: SelectOption[] = [
    { value: 'all', label: t('admin.map.docs.all', 'Todos') },
    { value: 'complete', label: t('admin.map.docs.complete', 'Documentación completa') },
    { value: 'incomplete', label: t('admin.map.docs.incomplete', 'Registro incompleto') },
  ];
  const professionOptions: SelectOption[] = [{ value: '', label: t('admin.map.profession.all', 'Todas las profesiones') }, ...PROFESSIONS.map((p) => ({ value: p, label: professionLabel(t, p) }))];
  const patientStatusOptions: SelectOption[] = [{ value: '', label: t('admin.map.patientStatus.all', 'Todos los estados') }, ...PATIENT_STATUSES.map((s) => ({ value: s, label: patientStatusLabel(t, s) }))];
  // Só quem tem coordenada COMPLETA pode virar centro.
  const patientPickerOptions = picker.points.filter((p) => p.lat !== null && p.lng !== null).map((p) => {
    const place = placeLabel(p);
    return { value: p.addressId ?? p.id, label: place ? `${p.name} · ${place}` : p.name };
  });

  const tabClass = (k: Kind): string =>
    `px-4 py-2 rounded-t-md border-b-2 ${kind === k ? 'border-primary text-primary' : 'border-transparent text-gray-600 hover:text-gray-900'}`;

  /** Já havia resultado na tela e uma busca nova está em voo. Na PRIMEIRA carga
   *  não vale: ali o "Cargando…" do contador já é o único conteúdo. */
  const buscandoDeNovo = active.isLoading && active.points.length > 0;

  const rowClass = (id: string): string =>
    `px-3 py-2 cursor-pointer ${selectedId === id ? 'bg-blue-50' : hoveredId === id ? 'bg-gray-100' : 'hover:bg-gray-50'}`;

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Heading level={1}>{t('admin.map.title', 'Mapa')}</Heading>
          <Text size="sm" color="secondary">
            {t('admin.map.subtitle', 'Quién está cerca de quién: buscá prestadores alrededor de un paciente para invitarlos, o mirá dónde están los pacientes.')}
          </Text>
        </div>
        <Button variant="outline" onClick={() => active.refetch()} data-testid="map-refresh" aria-label={t('admin.map.refresh', 'Actualizar')}>
          <RefreshCw size={16} />
        </Button>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'workers'} className={tabClass('workers')} data-testid="map-tab-workers" onClick={() => { setKind('workers'); setSelectedId(null); setHoveredId(null); }}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.workers', 'Prestadores')}</Text>
        </button>
        <button type="button" role="tab" aria-selected={kind === 'patients'} className={tabClass('patients')} data-testid="map-tab-patients" onClick={() => { setKind('patients'); setSelectedId(null); setHoveredId(null); }}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.patients', 'Pacientes')}</Text>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <aside className="flex flex-col gap-4 min-w-0">
          <section className="flex flex-col gap-2 rounded-md border border-gray-200 bg-white px-3 py-3" data-testid="map-center-block">
            <Step n={1} title={t('admin.map.steps.center', 'Desde dónde')} />
            {kind === 'workers' && (
              <Field id="map-center-patient" label={t('admin.map.centerOnPatient.label', 'Centrar en paciente')} group>
                {/* o `onFocusCapture`/`onClick` no wrapper preserva a busca preguiçosa:
                    o seletor só vai ao servidor depois que alguém o toca. */}
                {/* mascarado como as demais: as opções são "nome · bairro" de
                    paciente, e o `SearchableSelect` não usa portal (lex 02/09, C-1
                    — furo da lista de 4 superfícies do parecer de 01/09). */}
                <div data-testid="map-center-patient" data-clarity-mask="True" onFocusCapture={() => setPickerTouched(true)} onClick={() => setPickerTouched(true)}>
                  <SearchableSelect
                    options={patientPickerOptions}
                    value={centerPatientId}
                    onChange={onPickPatient}
                    placeholder={t('admin.map.centerOnPatient.placeholder', 'Centrar en un paciente…')}
                    searchPlaceholder={t('admin.map.centerOnPatient.search', 'Buscar paciente…')}
                  />
                </div>
              </Field>
            )}
            <CenterLabel
              text={t('admin.map.center.current', { defaultValue: 'Centro: {{label}}', label: centerLabel })}
              backLabel={!atCountryCenter && !atLastPatient
                ? (lastPatient
                  ? t('admin.map.center.backToPatient', { defaultValue: 'Volver a {{name}}', name: lastPatient.label })
                  : t('admin.map.center.backToInitial', 'Volver al punto inicial'))
                : undefined}
              onBack={!atCountryCenter && !atLastPatient ? onBack : undefined}
            />
            <Text as="div" size="xs" color="muted">
              {t('admin.map.centerHint', 'O hacé clic en el mapa para mover el centro del radio.')}
            </Text>
          </section>

          <section className="flex flex-col gap-2" data-testid="map-filters-block">
            <Step n={2} title={t('admin.map.steps.filters', 'Filtros')} />
            <div className="grid grid-cols-2 gap-2">
              <Field id="map-country" label={t('admin.map.country', 'País')}>
                <Select data-testid="map-country" id="map-country" inputSize="compact" options={countryOptions} value={country} onValueChange={onCountryChange} />
              </Field>
              <Field id="map-radius" label={t('admin.map.radius', 'Radio')}>
                <Select data-testid="map-radius" id="map-radius" inputSize="compact" options={radiusOptions} value={String(radiusKm)} onValueChange={(v) => setRadiusKm(Number(v))} />
              </Field>
            </div>

            {kind === 'workers' ? (
              <>
                <Field id="map-docs" label={t('admin.map.docs.label', 'Documentación')}>
                  <Select data-testid="map-docs" id="map-docs" inputSize="compact" options={docsOptions} value={docs} onValueChange={(v) => setDocs(v as Docs)} />
                </Field>
                <Field id="map-profession" label={t('admin.map.profession.label', 'Profesión')}>
                  <Select data-testid="map-profession" id="map-profession" inputSize="compact" options={professionOptions} value={profession} onValueChange={setProfession} />
                </Field>
              </>
            ) : (
              <>
                <Field id="map-patient-status" label={t('admin.map.patientStatus.label', 'Estado')}>
                  <Select data-testid="map-patient-status" id="map-patient-status" inputSize="compact" options={patientStatusOptions} value={patientStatus} onValueChange={setPatientStatus} />
                </Field>
                <Checkbox
                  id="map-open-vacancies"
                  data-testid="map-open-vacancies"
                  className="mt-1"
                  checked={onlyOpenVacancies}
                  onChange={(e) => setOnlyOpenVacancies(e.target.checked)}
                  label={t('admin.map.onlyOpenVacancies', 'Solo con vacantes abiertas')}
                />
              </>
            )}
          </section>

          <Step n={3} title={t('admin.map.steps.results', 'Resultados')} />
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2" data-testid="map-counts">
          <Text as="div" size="sm" color="primary">
            {active.isLoading ? (
              <span data-testid="map-loading">{t('admin.map.loading', 'Cargando…')}</span>
            ) : active.error ? (
              <span className="text-red-600" data-testid="map-error">{active.error}</span>
            ) : (
              <>
                <strong data-testid="map-total">{active.total}</strong>{' '}
                {t('admin.map.inRadius', { defaultValue: 'en {{km}} km', km: radiusKm })}
                {active.withoutCoordinates > 0 && (
                  <span className="text-amber-700" data-testid="map-without-coords">
                    {' · '}{t('admin.map.withoutCoordinates', { defaultValue: '{{count}} sin ubicación', count: active.withoutCoordinates })}
                  </span>
                )}
                {/* `total` é o do banco (COUNT(*) OVER()), `points.length` é o
                    que o teto de 500 deixou passar: quando diferem, a tela diz
                    quantos está mostrando de quantos existem — nunca finge que
                    o tamanho da página é o tamanho do filtro. */}
                {active.truncated && (
                  <span className="text-red-600" data-testid="map-truncated">
                    {' · '}
                    {t('admin.map.showingFirst', { defaultValue: 'mostrando los primeros {{shown}} de {{total}} — achicá el radio', shown: active.points.length, total: active.total })}
                  </span>
                )}
              </>
            )}
          </Text>
          </div>

          {/* A lista é a maior massa visual da tela. Enquanto a busca não voltava
              ela ficava IDÊNTICA, e só um texto pequeno virava "Cargando…" — daí
              a leitura de que o clique não tinha feito nada. */}
          <div className="relative">
          <ul className={`divide-y divide-gray-100 border border-gray-200 rounded-md max-h-[440px] overflow-y-auto ${buscandoDeNovo ? 'opacity-40' : ''}`} data-testid="map-list" data-clarity-mask="True" onMouseLeave={() => setHoveredId(null)}>
            {kind === 'workers'
              ? workers.points.map((p) => (
                <li key={p.id} data-testid="map-list-item" data-point-id={p.id} data-has-coords={p.lat !== null} className={rowClass(p.id)} onMouseEnter={() => setHoveredId(p.id)} onClick={() => setSelectedId(p.id)}>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: WORKER_STATUS_COLOR[p.status] ?? '#6b7280' }} />
                    <Link to={`/admin/workers/${p.id}`} className="hover:underline truncate" onClick={stopRowSelect}><Text as="span" size="sm" weight="medium" color="primary">{p.name}</Text></Link>
                    {p.distanceKm !== null && <Text as="span" size="xs" color="secondary" className="ml-auto shrink-0">{distanceLabel(p.distanceKm)}</Text>}
                  </div>
                  <Text as="div" size="xs" color="secondary" className="truncate">
                    {workerDetails(t, p)}
                  </Text>
                </li>
              ))
              : patients.points.map((p) => {
                // Um ponto por ENDEREÇO: o id da linha, do pino e da seleção é o mesmo.
                const pointId = p.addressId ?? p.id;
                return (
                  <li key={pointId} data-testid="map-list-item" data-point-id={pointId} data-patient-id={p.id} data-has-coords={p.lat !== null} className={rowClass(pointId)} onMouseEnter={() => setHoveredId(pointId)} onClick={() => setSelectedId(pointId)}>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PATIENT_STATUS_COLOR[p.status] ?? '#6b7280' }} />
                      <Link to={`/admin/patients/${p.id}`} className="hover:underline truncate" onClick={stopRowSelect}><Text as="span" size="sm" weight="medium" color="primary">{p.name}</Text></Link>
                      {p.distanceKm !== null && <Text as="span" size="xs" color="secondary" className="ml-auto shrink-0">{distanceLabel(p.distanceKm)}</Text>}
                    </div>
                    <Text as="div" size="xs" color="secondary" className="truncate">
                      {patientDetails(t, p)}
                    </Text>
                  </li>
                );
              })}
            {!active.isLoading && !active.error && active.points.length === 0 && (
              <li className="px-3 py-4" data-testid="map-empty"><Text size="sm" color="secondary">{t('admin.map.empty', 'Nadie en este radio. Probá un radio mayor o mové el centro.')}</Text></li>
            )}
          </ul>
          {buscandoDeNovo && <Searching label={t('admin.map.searching', 'Buscando…')} />}
          </div>
        </aside>

        {/* `data-clarity-mask` — o Clarity está VIVO em PRD (main.tsx) e o modo
            Balanced mascara só número e e-mail: nome + estado de paciente iriam
            para a gravação de sessão. O wrapper cobre o balão e o `title` dos
            marcadores, que são DOM do Google e não dá para marcar de outro jeito
            (lex 01/09, condição 1). */}
        <div className="flex flex-col gap-2 min-w-0" data-clarity-mask="True">
          <PointsMap
            points={mapPoints}
            center={center}
            radiusKm={radiusKm}
            onCenterChange={onCenterChange}
            selectedId={selectedId}
            onSelect={setSelectedId}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            linkLabel={kind === 'workers' ? t('admin.map.viewWorker', 'Ver perfil') : t('admin.map.viewPatient', 'Ver ficha')}
            closeLabel={t('admin.map.closePopup', 'Cerrar')}
            centerHereLabel={t('admin.map.centerHere', 'Centrar aquí')}
            onCenterHere={onCenterHere}
            placeholderText={t('admin.map.unavailable', 'El mapa no está disponible (sin clave de Google Maps). La lista sigue funcionando.')}
          />
          {selectedWithoutLocation && (
            <NoLocationNotice text={t('admin.map.selectedNoLocation', { defaultValue: '{{name}} no tiene ubicación registrada — no aparece en el mapa.', name: selectedWithoutLocation })} />
          )}
          <Legend label={t('admin.map.legend', 'Referencias:')} entries={legendEntries(t, kind)} />
        </div>
      </div>
    </PageContainer>
  );
}
