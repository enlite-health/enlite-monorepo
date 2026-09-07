/**
 * AdminMapPage — /admin/mapa · os DOIS mapas (DEC-14): prestadores e pacientes.
 *
 * O que o recrutador faz aqui (REQ-04, Javier): vê onde estão os prestadores
 * perto de um paciente, filtra por distância e por "documentação completa" —
 * INCLUINDO quem não terminou o registro — e abre o perfil para convidar.
 *
 * A tela é lida em TRÊS passos, e o passo 1 é um PORTÃO: ela responde "quem
 * está perto de quem", e proximidade precisa de dois lados. Sem a ÂNCORA
 * escolhida (um paciente na aba de prestadores, um prestador na de pacientes)
 * os passos 2 e 3 e o mapa não existem — antes disso a tela desenhava todo
 * mundo em volta do Obelisco, que não é resposta de nada e ainda é leitura em
 * massa de domicílio. Portão fechado = ZERO request ao abrir a página.
 *
 * Escopo sempre presente (lex C3): raio a partir de um centro, que nasce na
 * âncora e muda por clique no mapa (a âncora FICA, como referência de volta e
 * como destino das rotas). Sem geocoding, sem endereço digitado (lex C7).
 * País é filtro de primeira classe (C4) e vive no passo 1, porque é ele que
 * escopa o próprio seletor da âncora.
 *
 * Lista e mapa são a MESMA coisa vista de dois jeitos — literalmente o mesmo
 * `ResultRow[]`: o cursor na linha engorda o pino, o cursor no pino acende a
 * linha, e escolher leva a viewport até o ponto.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Select } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import { PointsMap } from '@presentation/components/molecules/PointsMap/PointsMap';
import { CenterLabel, Field, Legend, NoLocationNotice, Step } from './mapSidebar';
import { AnchorEmptyState, AnchorPicker, type MapAnchor } from './mapAnchor';
import { ANCHOR_SEARCH_MIN_CHARS, pointIdOf, useAnchorCandidates } from './useAnchorCandidates';
import { MapCounts, MapResultsList, type ResultRow } from './mapResults';
import { CorridorPanel } from './CorridorPanel';
import { corridorPairFor } from '@hooks/admin/useCorridor';
import { usePatientsMapPoints, useWorkersMapPoints } from '@hooks/admin/useMapPoints';
import type { MapCountry, PatientsMapFilters, RouteLeg, WorkersMapFilters } from '@infrastructure/http/AdminMapApiService';
import {
  DEFAULT_CENTER, DEFAULT_CENTER_BY_COUNTRY, DEFAULT_COUNTRY, DEFAULT_RADIUS_KM,
  anchorTextsFor, buildResultRows, corridorLabelsFor, filterOptionsFor, legendEntries, sameCenter,
} from './mapPageConfig';

type Kind = 'workers' | 'patients';
type Docs = 'all' | 'complete' | 'incomplete';

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
  // Uma âncora POR ABA: trocar de aba não pode apagar a referência da outra.
  const [patientAnchor, setPatientAnchor] = useState<MapAnchor | null>(null);
  const [workerAnchor, setWorkerAnchor] = useState<MapAnchor | null>(null);
  const [touchedPatients, setTouchedPatients] = useState(false);
  const [touchedWorkers, setTouchedWorkers] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Menor pai comum do balão (que sabe a opção aberta) e do mapa que desenha.
  const [drawnLegs, setDrawnLegs] = useState<RouteLeg[] | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const anchor = kind === 'workers' ? patientAnchor : workerAnchor;

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

  // O portão: sem âncora, NADA busca. Abrir a página custa zero request, e o
  // seletor só vai ao servidor quando alguém o toca.
  const workers = useWorkersMapPoints(workersFilters, kind === 'workers' && patientAnchor !== null);
  const patients = usePatientsMapPoints(patientsFilters, kind === 'patients' && workerAnchor !== null);

  /** Quem pode virar âncora — por raio de 50 km, ou por NOME quando se digita. */
  const anchorPicker = useAnchorCandidates({ kind, country, touchedPatients, touchedWorkers });

  const active = kind === 'workers' ? workers : patients;

  const onCenterChange = useCallback((c: { lat: number; lng: number }) => {
    setCenter(c);        // a âncora FICA: é o caminho de volta e o destino das rotas
    setSelectedId(null);
    setHoveredId(null);
  }, []);

  const onCountryChange = (v: string): void => {
    const next = v as MapCountry;
    setCountry(next);
    // As âncoras eram do país anterior — e com elas o portão fecha de novo.
    setPatientAnchor(null);
    setWorkerAnchor(null);
    onCenterChange(DEFAULT_CENTER_BY_COUNTRY[next]);
  };

  const onSwitchTab = (k: Kind): void => {
    setKind(k);
    const next = k === 'workers' ? patientAnchor : workerAnchor;
    setCenter(next ? { lat: next.lat, lng: next.lng } : DEFAULT_CENTER_BY_COUNTRY[country]);
    setSelectedId(null);
    setHoveredId(null);
  };

  const { labels: anchorLabels, ui: anchorUi } = anchorTextsFor(t, kind);

  /**
   * A lista vazia tem TRÊS causas e uma mensagem só seria mentira em duas
   * delas: quem digitou 1 letra precisa saber que falta digitar, e quem
   * digitou um nome que não existe precisa saber que a busca foi ao servidor
   * — antes, "Sin resultados" queria dizer só "não está nos 50 km".
   */
  const anchorEmptyMessage = anchorPicker.searchText.trim().length === 0
    ? undefined
    : anchorPicker.isSearching
      ? t('admin.map.anchorNoMatch', 'Sin resultados para ese nombre')
      : t('admin.map.anchorTypeMore', { defaultValue: 'Escribí al menos {{n}} letras', n: ANCHOR_SEARCH_MIN_CHARS });

  /**
   * Um caminho só: sem correspondência — que é o caso da opção vazia
   * ("Centrar en un paciente…") — a âncora é LIMPA e o portão fecha de novo.
   * Antes essa opção era um controle visível e morto: quem quisesse recomeçar
   * clicava e a tela ignorava.
   */
  const onPickAnchor = (id: string): void => {
    const found = anchorPicker.candidates.find((x) => pointIdOf(x) === id);
    const next: MapAnchor | null = found
      ? { id, personId: found.id, name: found.name, lat: found.lat, lng: found.lng }
      : null;
    if (kind === 'workers') setPatientAnchor(next); else setWorkerAnchor(next);
    setCenter(next ? { lat: next.lat, lng: next.lng } : DEFAULT_CENTER_BY_COUNTRY[country]);
    setSelectedId(null);
  };

  // "Centrar aquí" do balão: mesma coisa que clicar no mapa naquele ponto — com
  // o mapa cheio de pinos, o clique que queria ser "aqui" acerta uma pessoa.
  const onCenterHere = useCallback((p: { lat: number | null; lng: number | null }) => {
    if (p.lat === null || p.lng === null) return;
    onCenterChange({ lat: p.lat, lng: p.lng });
  }, [onCenterChange]);

  const atAnchor = !!anchor && sameCenter(center, { lat: anchor.lat, lng: anchor.lng });
  // Só existe quando há âncora — e é assim, e não com um `if (!anchor) return`
  // dentro, que o TypeScript estreita o tipo sem deixar um ramo morto atrás.
  const onBackToAnchor = anchor
    ? (): void => { setCenter({ lat: anchor.lat, lng: anchor.lng }); setSelectedId(null); }
    : undefined;

  /** A fonte ÚNICA da lista e dos pinos. */
  const rows = useMemo<ResultRow[]>(
    () => buildResultRows(t, kind, workers.points, patients.points),
    [kind, workers.points, patients.points, t],
  );

  /**
   * O par do corredor sai do pino ABERTO cruzado com a âncora. `null` enquanto
   * nada está aberto — e quem busca é o PAINEL, que só monta quando o balão
   * abre: sem balão (mapa indisponível) não se gasta a cota de 60/min.
   */
  const corridorPair = useMemo(
    () => corridorPairFor(kind, country, anchor?.id ?? null, rows.find((r) => r.id === selectedId)),
    [kind, country, anchor, rows, selectedId],
  );
  const corridorLabels = corridorLabelsFor(t);

  // Escolher quem NÃO tem coordenada não pode ser silêncio: o mapa não muda e
  // o balão não abre, e sem aviso isso se lê como tela travada.
  const selectedWithoutLocation = useMemo<string | null>(() => {
    if (!selectedId) return null;
    const r = rows.find((x) => x.id === selectedId);
    return r && r.lat === null ? r.title : null;
  }, [selectedId, rows]);

  const { radiusOptions, countryOptions, docsOptions, professionOptions, patientStatusOptions } = filterOptionsFor(t);

  const tabClass = (k: Kind): string =>
    `px-4 py-2 rounded-t-md border-b-2 ${kind === k ? 'border-primary text-primary' : 'border-transparent text-gray-600 hover:text-gray-900'}`;

  /** Já havia resultado na tela e uma busca nova está em voo. Na PRIMEIRA carga
   *  não vale: ali o "Cargando…" do contador já é o único conteúdo. */
  const searchingAgain = active.isLoading && active.points.length > 0;

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Heading level={1}>{t('admin.map.title', 'Mapa')}</Heading>
          <Text size="sm" color="secondary">
            {t('admin.map.subtitle', 'Quién está cerca de quién: buscá prestadores alrededor de un paciente para invitarlos, o mirá dónde están los pacientes.')}
          </Text>
        </div>
        {anchor && (
          <Button variant="outline" onClick={() => active.refetch()} data-testid="map-refresh" aria-label={t('admin.map.refresh', 'Actualizar')}>
            <RefreshCw size={16} />
          </Button>
        )}
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'workers'} className={tabClass('workers')} data-testid="map-tab-workers" onClick={() => onSwitchTab('workers')}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.workers', 'Prestadores')}</Text>
        </button>
        <button type="button" role="tab" aria-selected={kind === 'patients'} className={tabClass('patients')} data-testid="map-tab-patients" onClick={() => onSwitchTab('patients')}>
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('admin.map.tabs.patients', 'Pacientes')}</Text>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <aside className="flex flex-col gap-4 min-w-0">
          <section className="flex flex-col gap-2 rounded-md border border-gray-200 bg-white px-3 py-3" data-testid="map-center-block">
            <Step n={1} title={anchorUi.step} />
            <Field id="map-country" label={t('admin.map.country', 'País')}>
              <Select data-testid="map-country" id="map-country" inputSize="compact" options={countryOptions} value={country} onValueChange={onCountryChange} />
            </Field>
            {/* Um seletor só: as duas abas diferem no TEXTO e em qual âncora
                guardam, não no comportamento. O `key` força remontar ao trocar
                de aba, senão o combobox carregaria a busca digitada da outra. */}
            <AnchorPicker
              key={anchorUi.id}
              id={anchorUi.id}
              label={anchorUi.label}
              placeholder={anchorUi.placeholder}
              searchPlaceholder={anchorUi.searchPlaceholder}
              options={anchorPicker.options}
              value={anchor?.id ?? ''}
              onChange={onPickAnchor}
              onTouch={() => (kind === 'workers' ? setTouchedPatients(true) : setTouchedWorkers(true))}
              status={anchorPicker.status}
              labels={anchorLabels}
              onSearchChange={kind === 'workers' ? anchorPicker.onSearchChange : undefined}
              emptyMessage={kind === 'workers' ? anchorEmptyMessage : undefined}
            />
            {anchor && (
              <>
                <CenterLabel
                  text={t('admin.map.center.current', { defaultValue: 'Centro: {{label}}', label: atAnchor ? anchor.name : t('admin.map.center.marked', 'punto marcado en el mapa') })}
                  backLabel={!atAnchor ? t('admin.map.center.backToAnchor', { defaultValue: 'Volver a {{name}}', name: anchor.name }) : undefined}
                  onBack={!atAnchor ? onBackToAnchor : undefined}
                />
                <Text as="div" size="xs" color="muted">
                  {t('admin.map.centerHint', 'O hacé clic en el mapa para mover el centro del radio.')}
                </Text>
              </>
            )}
          </section>

          {anchor && (
            <>
              <section className="flex flex-col gap-2" data-testid="map-filters-block">
                <Step n={2} title={t('admin.map.steps.filters', 'Filtros')} />
                <Field id="map-radius" label={t('admin.map.radius', 'Radio')}>
                  <Select data-testid="map-radius" id="map-radius" inputSize="compact" options={radiusOptions} value={String(radiusKm)} onValueChange={(v) => setRadiusKm(Number(v))} />
                </Field>

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
              <MapCounts
                state={{ ...active, shown: active.points.length }}
                radiusKm={radiusKm}
                labels={{
                  loading: t('admin.map.loading', 'Cargando…'),
                  inRadius: (km) => t('admin.map.inRadius', { defaultValue: 'en {{km}} km', km }),
                  withoutCoordinates: (count) => t('admin.map.withoutCoordinates', { defaultValue: '{{count}} sin ubicación', count }),
                  showingFirst: (shown, total) => t('admin.map.showingFirst', { defaultValue: 'mostrando los primeros {{shown}} de {{total}} — achicá el radio', shown, total }),
                }}
              />
              <MapResultsList
                rows={rows}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                isSearching={searchingAgain}
                showEmpty={!active.isLoading && !active.error && rows.length === 0}
                emptyLabel={t('admin.map.empty', 'Nadie en este radio. Probá un radio mayor o mové el centro.')}
                searchingLabel={t('admin.map.searching', 'Buscando…')}
              />
            </>
          )}
        </aside>

        {/* `data-clarity-mask` — o Clarity está VIVO em PRD (main.tsx) e o modo
            Balanced mascara só número e e-mail: nome + estado de paciente iriam
            para a gravação de sessão. O wrapper cobre o balão e o `title` dos
            marcadores, que são DOM do Google e não dá para marcar de outro jeito
            (lex 01/09, condição 1). */}
        <div className="flex flex-col gap-2 min-w-0" data-clarity-mask="True">
          {anchor ? (
            <>
              <PointsMap
                points={rows}
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
                /* O corredor é buscado DENTRO do painel, que só monta com o balão
                   aberto: na página, gastava a cota de 60/min mesmo sem mapa
                   (sem chave do Google o balão nunca aparece). */
                routeLegs={drawnLegs}
                renderExtra={(p) => (p.id === selectedId && corridorPair
                  ? <CorridorPanel pair={corridorPair} labels={corridorLabels} onRouteOpen={setDrawnLegs} />
                  : null)}
                placeholderText={t('admin.map.unavailable', 'El mapa no está disponible (sin clave de Google Maps). La lista sigue funcionando.')}
              />
              {selectedWithoutLocation && (
                <NoLocationNotice text={t('admin.map.selectedNoLocation', { defaultValue: '{{name}} no tiene ubicación registrada — no aparece en el mapa.', name: selectedWithoutLocation })} />
              )}
              <Legend label={t('admin.map.legend', 'Referencias:')} entries={legendEntries(t, kind)} />
            </>
          ) : (
            <AnchorEmptyState title={anchorUi.emptyTitle} hint={anchorUi.emptyHint} />
          )}
        </div>
      </div>
    </PageContainer>
  );
}
