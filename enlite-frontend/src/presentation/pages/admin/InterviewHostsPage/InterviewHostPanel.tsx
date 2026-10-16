/**
 * InterviewHostPanel — Agregar/Editar entrevistador. Molde: CreateEnquadreEventDrawer (spec 052): `SlideOverPanel` modal `max-w-lg`,
 * rótulos de seção `Text 2xs primary uppercase`, opções como cartões selecionáveis, helpers `text-slate-600`, erros `text-red-800`,
 * footer `outline sm` + `primary sm`. Só se escolhe usuário staff ativo vindo da busca: não há campo de e-mail livre (R1, spec 055).
 * Os avisos "Elegí al menos un…" só aparecem DEPOIS da primeira interação com o grupo (não gritam num formulário recém-aberto).
 */
import { useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { CountryChips } from '@presentation/components/molecules/CountryChips';
import { AdminInterviewHostApiService } from '@infrastructure/http/AdminInterviewHostApiService';
import {
  INTERVIEW_HOST_COUNTRIES,
  type InterviewHost,
  type InterviewHostCandidate,
  type InterviewHostCountry,
  type InterviewHostInput,
} from '@domain/entities/InterviewHost';
import { interviewHostErrorMessage } from './interviewHostErrors';

interface Props {
  /** Modo edição: usuário fixo, países e fluxos preenchidos. */
  editing?: InterviewHost | null;
  /** Salva (POST no agregar, PATCH no editar); quem chama atualiza a lista. Rejeitar mostra o erro no painel. */
  onSubmit: (data: InterviewHostInput & { user: InterviewHostCandidate }) => Promise<void>;
  onClose: () => void;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;
const SECTION_LABEL = 'text-[11px] uppercase text-primary font-lexend';
const optionClass = (checked: boolean) =>
  `flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer hover:border-primary ${checked ? 'border-primary bg-gray-200' : 'border-gray-600 bg-white'}`;

type SearchStatus = 'idle' | 'loading' | 'ok' | 'error';

export function InterviewHostPanel({ editing = null, onSubmit, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<InterviewHostCandidate | null>(
    editing ? { uid: editing.userUid ?? editing.id, displayName: editing.displayName, email: editing.email } : null,
  );
  const [countries, setCountries] = useState<InterviewHostCountry[]>(editing?.countries ?? ['AR']);
  const [doesEnquadre, setDoesEnquadre] = useState(editing?.doesEnquadre ?? false);
  const [doesAdmission, setDoesAdmission] = useState(editing?.doesAdmission ?? false);
  // Só depois de mexer no grupo é que o aviso dele pode aparecer.
  const [touchedCountries, setTouchedCountries] = useState(false);
  const [touchedFlows, setTouchedFlows] = useState(false);
  const [results, setResults] = useState<InterviewHostCandidate[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const q = query.trim();
  useEffect(() => {
    if (picked || q.length < MIN_QUERY) {
      setStatus('idle');
      setResults([]);
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    const timer = setTimeout(() => {
      AdminInterviewHostApiService.searchCandidates(q)
        .then((rows) => {
          if (cancelled) return;
          setResults(rows);
          setStatus('ok');
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, picked]);

  const noFlow = !doesEnquadre && !doesAdmission;
  const canSave = picked !== null && countries.length > 0 && !noFlow && !saving;
  const title = editing ? t('admin.interviewHosts.panel.titleEdit') : t('admin.interviewHosts.panel.titleAdd');
  const nameOf = (u: InterviewHostCandidate) => u.displayName ?? u.email;
  const showList = !picked && q.length >= MIN_QUERY;

  const flows = [
    { id: 'ih-enquadre', label: t('admin.interviewHosts.panel.encuadre'), checked: doesEnquadre, set: setDoesEnquadre },
    { id: 'ih-admision', label: t('admin.interviewHosts.panel.admission'), checked: doesAdmission, set: setDoesAdmission },
  ];

  async function save() {
    if (!picked) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSubmit({ user: picked, countries, doesEnquadre, doesAdmission });
    } catch (err) {
      setSaveError(interviewHostErrorMessage(err, t));
      setSaving(false);
    }
  }

  return (
    <SlideOverPanel isOpen modal onClose={onClose} ariaLabel={title} widthClassName="max-w-lg" testId="interview-host-panel" closeAriaLabel={t('admin.interviewHosts.panel.close')}>
      <div className="px-6 pt-6 pb-4 border-b border-gray-600 shrink-0">
        <Heading level={2} weight="semibold" color="primary">{title}</Heading>
      </div>

      <div className="px-6 py-5 flex flex-col gap-5 overflow-y-auto flex-1">
        {/* Usuario */}
        <div className="flex flex-col gap-2">
          {picked ? (
            <>
              <Text as="span" size="2xs" color="primary" className="uppercase">{t('admin.interviewHosts.panel.user')}</Text>
              <div className={`${optionClass(true)} items-center justify-between cursor-default`} data-testid="picked-user">
                <span className="flex flex-col min-w-0">
                  <Text as="span" size="sm" weight="medium" color="inherit" className="truncate text-gray-900">{nameOf(picked)}</Text>
                  <Text as="span" size="xs" color="inherit" className="truncate text-slate-600">{picked.email}</Text>
                </span>
                {!editing && (
                  <Button variant="outline" size="xs" onClick={() => { setPicked(null); setQuery(''); }}>{t('admin.interviewHosts.panel.change')}</Button>
                )}
              </div>
            </>
          ) : (
            <>
              <label htmlFor="ih-user" className={SECTION_LABEL}>{t('admin.interviewHosts.panel.user')}</label>
              <Input
                id="ih-user"
                inputSize="compact"
                type="text"
                role="combobox"
                aria-expanded={showList}
                aria-controls="ih-user-list"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('admin.interviewHosts.panel.searchPlaceholder')}
              />
              {showList && status === 'loading' && (
                <Text size="sm" color="secondary">{t('admin.interviewHosts.panel.searching')}</Text>
              )}
              {showList && status === 'error' && (
                <Text size="sm" color="inherit" role="alert" className="text-red-800" data-testid="search-error">{t('admin.interviewHosts.panel.searchError')}</Text>
              )}
              {showList && status === 'ok' && (
                <ul id="ih-user-list" role="listbox" className="flex flex-col gap-2">
                  {results.length === 0 ? (
                    <li>
                      <Text size="sm" color="secondary" data-testid="no-results">
                        {t('admin.interviewHosts.panel.noResults', { query: q })}
                      </Text>
                    </li>
                  ) : (
                    results.map((c) => (
                      <li key={c.uid} role="option" aria-selected={false}>
                        <button
                          type="button"
                          onClick={() => { setPicked(c); setQuery(''); }}
                          className={`${optionClass(false)} w-full text-left`}
                          data-testid={`candidate-${c.uid}`}
                        >
                          <span className="flex flex-col min-w-0">
                            <Text as="span" size="sm" weight="medium" color="inherit" className="truncate text-gray-900">{nameOf(c)}</Text>
                            <Text as="span" size="xs" color="inherit" className="truncate text-slate-600">{c.email}</Text>
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
              <Text color="inherit" size="xs" className="text-slate-600">{t('admin.interviewHosts.panel.onlyActive')}</Text>
            </>
          )}
        </div>

        {/* Países */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1"><Text as="span" size="2xs" color="primary" className="uppercase">{t('admin.interviewHosts.panel.countries')}</Text></legend>
          <CountryChips
            countries={INTERVIEW_HOST_COUNTRIES}
            selected={countries}
            onToggle={(c, next) => {
              setTouchedCountries(true);
              setCountries((cur) => (next ? [...cur, c as InterviewHostCountry] : cur.filter((x) => x !== c)));
            }}
          />
          {touchedCountries && countries.length === 0 && (
            <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="no-country-help">{t('admin.interviewHosts.panel.countriesRequired')}</Text>
          )}
        </fieldset>

        {/* Atiende */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1"><Text as="span" size="2xs" color="primary" className="uppercase">{t('admin.interviewHosts.panel.attends')}</Text></legend>
          {flows.map((f) => (
            <label key={f.id} className={optionClass(f.checked)}>
              <input
                id={f.id}
                type="checkbox"
                checked={f.checked}
                onChange={(e) => { setTouchedFlows(true); f.set(e.target.checked); }}
                className="mt-1"
              />
              <Text as="span" size="sm" weight="medium" color="inherit" className="text-gray-900">{f.label}</Text>
            </label>
          ))}
          {touchedFlows && noFlow && (
            <Text color="inherit" size="xs" className="text-slate-600" data-testid="no-flow-help">{t('admin.interviewHosts.panel.flowRequired')}</Text>
          )}
        </fieldset>

        {saveError && (
          <Text color="inherit" size="sm" role="alert" className="text-red-800" data-testid="save-error">{saveError}</Text>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-600 shrink-0">
        <Button variant="outline" size="sm" onClick={onClose}>{t('admin.interviewHosts.panel.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={save} data-testid="panel-save">
          {editing ? t('admin.interviewHosts.panel.save') : t('admin.interviewHosts.panel.add')}
        </Button>
      </div>
    </SlideOverPanel>
  );
}
