import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { useAreaPeople } from '@presentation/hooks/useAreaPeople';
import { AreaEmailLookup, type LookupResult } from '@presentation/components/features/access/areaMemberships/AreaEmailLookup';
import { AreaPeoplePagination } from '@presentation/components/features/access/areaMemberships/AreaPeoplePagination';
import { AreaPeopleSkeleton } from '@presentation/components/features/access/areaMemberships/AreaPeopleSkeleton';
import { AreaPeopleTable } from '@presentation/components/features/access/areaMemberships/AreaPeopleTable';
import { AreaPeopleToolbar } from '@presentation/components/features/access/areaMemberships/AreaPeopleToolbar';
import { AreaPersonDrawer } from '@presentation/components/features/access/areaMemberships/AreaPersonDrawer';
import { sameAreaPerson, type AreaPerson } from '@domain/entities/AreaMembership';
import { AREA_MEMBERSHIP_RESOURCE } from './AccessGate';

const K = 'admin.access.areaMemberships';
const TOAST_MS = 3500;

/** O conteúdo da aba: cabeçalho, filtros, lista paginada, busca por e-mail exato e o painel "Gestionar". */
export function AreaMembershipsTab(): JSX.Element {
  const { t } = useTranslation();
  const canWrite = useCellAccess(AREA_MEMBERSHIP_RESOURCE).canWrite;
  const people = useAreaPeople();
  const [selected, setSelected] = useState<AreaPerson | null>(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookup, setLookup] = useState<LookupResult>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const closeDrawer = useCallback(() => setSelected(null), []);

  const changed = (next: AreaPerson, toastKey: string): void => {
    setSelected(next);
    setToast(toastKey);
    if (lookup && lookup !== 'none' && sameAreaPerson(lookup, next)) setLookup(next);
    people.reload();
  };

  const closeLookup = (): void => { setLookupOpen(false); setLookup(null); };

  const initialLoading = people.phase === 'loading';
  const failed = people.phase === 'error';
  const toolbarOff = initialLoading || failed;
  const items = people.data?.items ?? [];
  const total = people.data?.total ?? 0;
  const searching = people.appliedSearch !== '';

  const lookupLink = !lookupOpen && (
    <button type="button" className="underline" data-testid="area-lookup-open-link" onClick={() => setLookupOpen(true)}>
      <Text as="span" size="xs" color="primary" className="!leading-4">{t(`${K}.lookup.open`)}</Text>
    </button>
  );

  let content: JSX.Element;
  if (initialLoading) content = <AreaPeopleSkeleton />;
  else if (failed) {
    content = (
      <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg flex items-center justify-between gap-3" role="alert" data-testid="area-people-error">
        <Text size="sm" color="primary">{t(`${K}.errors.load`)}</Text>
        <Button type="button" size="xs" variant="quiet" data-testid="area-people-retry" onClick={people.reload}>{t(`${K}.retry`)}</Button>
      </div>
    );
  } else if (total === 0) {
    content = (
      <div className="bg-white rounded-xl border border-gray-400 px-6 py-10 text-center space-y-3" data-testid="empty">
        <Text size="sm" color="primary" className="!leading-5">
          {searching ? t(`${K}.emptySearch`, { term: people.appliedSearch }) : t(`${K}.emptyFilters`)}
        </Text>
        {!lookupOpen && (
          <Button type="button" size="compact" variant="primary" data-testid="area-lookup-open" onClick={() => setLookupOpen(true)}>
            {t(`${K}.lookup.open`)}
          </Button>
        )}
      </div>
    );
  } else {
    content = (
      <>
        <AreaPeopleTable people={items} canWrite={canWrite} onManage={setSelected} />
        <AreaPeoplePagination
          page={people.page}
          perPage={people.perPage}
          total={total}
          onPrev={people.prevPage}
          onNext={people.nextPage}
          onPerPage={people.setPerPage}
        />
        {!lookupOpen && (
          <Text size="xs" color="tertiary" className="text-right !leading-4">{t(`${K}.lookup.hint`)} {lookupLink}</Text>
        )}
      </>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="area-memberships-title" data-testid="area-memberships-section">
      <div>
        <Heading level={2} weight="semibold" color="primary" id="area-memberships-title">{t(`${K}.title`)}</Heading>
        <Text size="sm" color="tertiary">
          {t(`${K}.subtitle`)}{' '}
          {people.onlyWithMembership ? (
            <>
              <Text as="span" size="sm" weight="medium" color="inherit">{t(`${K}.auditLabel`)}</Text> {t(`${K}.auditText`)}
            </>
          ) : t(`${K}.subtitleSearch`)}
        </Text>
      </div>
      <AreaPeopleToolbar
        search={people.search}
        searchTooShort={people.searchTooShort}
        type={people.type}
        onlyWithMembership={people.onlyWithMembership}
        disabled={toolbarOff}
        onSearch={people.setSearch}
        onType={people.setType}
        onToggleOnly={() => people.setOnlyWithMembership(!people.onlyWithMembership)}
      />
      {content}
      {lookupOpen && !initialLoading && !failed && (
        <AreaEmailLookup result={lookup} onResult={setLookup} canWrite={canWrite} onManage={setSelected} onClose={closeLookup} />
      )}
      {selected && canWrite && <AreaPersonDrawer person={selected} onClose={closeDrawer} onChanged={changed} />}
      {toast && createPortal(
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-primary text-white leading-5 px-4 py-2 rounded-lg shadow-medium"
          role="status"
          data-testid="area-toast"
        >
          <Text as="span" size="sm" color="white" className="!leading-5">{t(toast)}</Text>
        </div>,
        document.body,
      )}
    </section>
  );
}
