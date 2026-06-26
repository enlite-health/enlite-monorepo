import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@presentation/hooks/useAuth';
import {
  useWorkerRegistrationStore,
  getWorkerStorageKey,
} from '@presentation/stores/workerRegistrationStore';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { AppLayout } from '@presentation/components/templates/DashboardLayout';
import { useWorkerNavItems } from '@presentation/config/workerNavigation';
import { GeneralInfoTab } from './tabs/GeneralInfoTab';
import { ServiceAddressTab } from './tabs/ServiceAddressTab';
import { AvailabilityTab } from './tabs/AvailabilityTab';
import { DocumentsTab } from './tabs/DocumentsTab';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { TabId } from '@presentation/utils/incompleteFieldDestinations';

const VALID_TABS: TabId[] = ['general', 'address', 'availability', 'documents'];

/** Classe de highlight transitório aplicado ao alvo do focus */
const HIGHLIGHT_CLASS = 'ring-2 ring-primary ring-offset-2 rounded';
/** Duração do highlight em ms */
const HIGHLIGHT_DURATION_MS = 2000;

function isValidTab(value: string | null): value is TabId {
  return VALID_TABS.includes(value as TabId);
}

export function WorkerProfilePage(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navItems = useWorkerNavItems();
  const { getProgress, initWorker } = useWorkerApi();
  const [searchParams] = useSearchParams();

  // Use individual selectors to prevent re-renders
  const setMode = useWorkerRegistrationStore((state) => state.setMode);
  const updateGeneralInfo = useWorkerRegistrationStore((state) => state.updateGeneralInfo);
  const setReadonlyFields = useWorkerRegistrationStore((state) => state.setReadonlyFields);
  const hydrateFromServer = useWorkerRegistrationStore((state) => state.hydrateFromServer);
  const profilePhoto = useWorkerRegistrationStore((state) => state.data.generalInfo.profilePhoto);

  const tabParam = searchParams.get('tab');
  const focusParam = searchParams.get('focus');

  const [activeTab, setActiveTab] = useState<TabId>(
    isValidTab(tabParam) ? tabParam : 'general',
  );
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const didRekey = useRef(false);
  useEffect(() => {
    if (!user || didRekey.current) return;
    didRekey.current = true;
    const storageKey = getWorkerStorageKey(user.id);
    const previousRaw = localStorage.getItem('worker-registration-anonymous');
    if (previousRaw && !localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, previousRaw);
      localStorage.removeItem('worker-registration-anonymous');
    }
  }, [user]);

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;

    const init = async () => {
      setIsInitializing(true);
      setInitError(null);
      setMode('self');

      try {
        const progress = await getProgress();
        if (!cancelled) {
          hydrateFromServer(progress);
          setReadonlyFields(['email', 'fullName']);
        }
      } catch {
        try {
          const initResponse = await initWorker({});
          // Onda 2: initWorker returns { status: 'ok', worker } or { status: 'claim_pending', ... }
          // WorkerProfilePage only proceeds if status is 'ok'.
          const newWorker = initResponse.status === 'ok' ? initResponse.worker : null;
          if (!cancelled && newWorker) {
            hydrateFromServer(newWorker);
            updateGeneralInfo({
              email: user.email,
              fullName: user.name || '',
            });
            setReadonlyFields(['email']);
          }
        } catch (err) {
          if (!cancelled) {
            setInitError(
              err instanceof Error ? err.message : t('workerRegistration.errorInit'),
            );
          }
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    };

    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Sync tab from searchParams when they change (e.g., deep link from modal)
  useEffect(() => {
    if (isValidTab(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  // Scroll and highlight the focus target after tab renders
  useEffect(() => {
    if (isInitializing || !focusParam) return;

    // Small delay to let the tab content render
    const timer = setTimeout(() => {
      let target: Element | null = null;

      if (activeTab === 'documents') {
        target = document.querySelector(`[data-testid="doc-slot-${focusParam}"]`);
      } else {
        target = document.getElementById(focusParam);
      }

      if (!target) return;

      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Apply transitional highlight
      target.classList.add(...HIGHLIGHT_CLASS.split(' '));
      const removeHighlight = setTimeout(() => {
        target?.classList.remove(...HIGHLIGHT_CLASS.split(' '));
      }, HIGHLIGHT_DURATION_MS);

      return () => clearTimeout(removeHighlight);
    }, 150);

    return () => clearTimeout(timer);
  }, [activeTab, focusParam, isInitializing]);

  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: t('profile.tabs.general', 'Informações Gerais') },
    { id: 'address', label: t('profile.tabs.address', 'Endereço de Atendimento') },
    { id: 'availability', label: t('profile.tabs.availability', 'Disponibilidade') },
    { id: 'documents', label: t('profile.tabs.documents', 'Documentos') },
  ];

  const currentTabIndex = tabs.findIndex((tab) => tab.id === activeTab);

  const goToPrevTab = (): void => {
    if (currentTabIndex > 0) setActiveTab(tabs[currentTabIndex - 1].id);
  };

  const goToNextTab = (): void => {
    if (currentTabIndex < tabs.length - 1) setActiveTab(tabs[currentTabIndex + 1].id);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralInfoTab />;
      case 'address':
        return <ServiceAddressTab />;
      case 'availability':
        return <AvailabilityTab />;
      case 'documents':
        return <DocumentsTab />;
      default:
        return <GeneralInfoTab />;
    }
  };

  return (
    <AppLayout navItems={navItems} userName={user?.name || t('common.userFallback')} userAvatar={profilePhoto || undefined}>
      <div className="max-w-4xl mx-auto">
        <Heading level={1} weight="semibold" color="secondary" className="mb-6">
          {t('profile.title', 'Meu Perfil')}
        </Heading>

        {initError && (
          <div className="mb-6 p-4 rounded-lg bg-red-100 border border-red-400 text-red-700">
            {initError}
            <button
              onClick={() => window.location.reload()}
              className="ml-4 underline font-semibold"
            >
              {t('workerRegistration.retry')}
            </button>
          </div>
        )}

        {isInitializing ? (
          <div className="animate-pulse space-y-4">
            <div className="h-10 bg-gray-200 rounded-lg w-full" />
            <div className="h-64 bg-gray-200 rounded-lg w-full" />
          </div>
        ) : (
          <>
            {/* Mobile: carousel de navegação entre tabs */}
            <div
              data-testid="tab-mobile-nav"
              className="flex items-center justify-between mb-6 md:hidden"
            >
              <button
                onClick={goToPrevTab}
                disabled={currentTabIndex === 0}
                data-testid="tab-prev"
                aria-label={t('common.previous', 'Anterior')}
                className="p-2 rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-5 h-5 text-primary" />
              </button>

              <span data-testid="tab-current-label" className="text-center flex-1 px-2">
                <Text as="span" size="sm" weight="semibold" color="primary">
                  {tabs[currentTabIndex].label}
                </Text>
              </span>

              <button
                onClick={goToNextTab}
                disabled={currentTabIndex === tabs.length - 1}
                data-testid="tab-next"
                aria-label={t('common.next', 'Siguiente')}
                className="p-2 rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-5 h-5 text-primary" />
              </button>
            </div>

            {/* Desktop: barra horizontal de tabs */}
            <div
              data-testid="tab-desktop-nav"
              className="hidden md:block border-b border-gray-200 mb-6"
            >
              <nav className="flex space-x-8" aria-label="Tabs">
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      data-testid={`tab-btn-${tab.id}`}
                      onClick={() => setActiveTab(tab.id)}
                      className={`
                        py-4 px-1 border-b-2 whitespace-nowrap transition-colors
                        ${isActive
                          ? 'border-primary'
                          : 'border-transparent hover:border-gray-300'
                        }
                      `}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <Text
                        as="span"
                        size="sm"
                        weight="medium"
                        color={isActive ? 'primary' : 'secondary'}
                      >
                        {tab.label}
                      </Text>
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Tab Content */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              {renderTabContent()}
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
