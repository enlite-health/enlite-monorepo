import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { useWorkerDetail } from '@hooks/admin/useWorkerDetail';
import { useAdminWorkerDocuments } from '@hooks/admin/useAdminWorkerDocuments';
import { useAdminAdditionalDocuments } from '@hooks/admin/useAdminAdditionalDocuments';
import { AdditionalDocumentsSection } from '@presentation/components/organisms/AdditionalDocumentsSection';
import { WorkerContactCard } from './WorkerContactCard';
import { WorkerPersonalInfoCard } from './WorkerPersonalInfoCard';
import { WorkerAddressCard } from './WorkerAddressCard';
import { WorkerProfileTabs, WorkerTab } from './WorkerProfileTabs';
import { WorkerDocumentsCard } from './WorkerDocumentsCard';
import { WorkerEncuadresCard } from './WorkerEncuadresCard';
import { WorkerProfessionalCard } from './WorkerProfessionalCard';
import { WorkerAvailabilityCard } from './WorkerAvailabilityCard';
import { WorkerTestAccountToggle } from './WorkerTestAccountToggle';

interface WorkerDetailContentProps {
  workerId: string | undefined;
  /** Rendered above the cards (e.g. back link in page, title in modal). */
  header?: React.ReactNode;
  /** Rendered when the worker fails to load (page renders a full-screen fallback). */
  renderError?: (message: string) => React.ReactNode;
}

/**
 * Reusable body of the worker detail view. Consumed by both WorkerDetailPage
 * (full page) and WorkerProfileModal (read-only overlay). Owns the data
 * fetching, tab state and card layout — read-only except for document review
 * (page) and the admin-only test-account toggle.
 */
export function WorkerDetailContent({ workerId, header, renderError }: WorkerDetailContentProps): JSX.Element {
  const { t } = useTranslation();
  const { worker, isLoading, error, patchDocuments, patchDocumentValidations } = useWorkerDetail(workerId);
  const [activeTab, setActiveTab] = useState<WorkerTab>('documents');

  const docsOptions = useMemo(
    () => ({ onDocumentsChange: patchDocuments, onValidationChange: patchDocumentValidations }),
    [patchDocuments, patchDocumentValidations],
  );
  const docs = useAdminWorkerDocuments(workerId ?? '', docsOptions);
  const additionalDocs = useAdminAdditionalDocuments(workerId ?? '');
  const { fetchDocuments: fetchAdditionalDocs } = additionalDocs;

  useEffect(() => { fetchAdditionalDocs(); }, [fetchAdditionalDocs]);

  if (isLoading) return <DetailSkeleton />;

  if (error || !worker) {
    const message = error ?? t('admin.workerDetail.notFound');
    if (renderError) return <>{renderError(message)}</>;
    return (
      <div className="flex items-center justify-center py-12">
        <Heading level={3} color="inherit" className="text-red-600">{message}</Heading>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* Row 1: Contact + Personal Info (2 columns) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <WorkerContactCard
          status={worker.status}
          firstName={worker.firstName}
          lastName={worker.lastName}
          email={worker.email}
          phone={worker.phone}
          whatsappPhone={worker.whatsappPhone}
          profilePhotoUrl={worker.profilePhotoUrl}
          documentType={worker.documentType}
          documentNumber={worker.documentNumber}
          platform={worker.platform}
          dataSources={worker.dataSources}
          createdAt={worker.createdAt}
          updatedAt={worker.updatedAt}
        />
        <WorkerPersonalInfoCard
          workerId={worker.id}
          birthDate={worker.birthDate}
          sex={worker.sex}
          gender={worker.gender}
          sexualOrientation={worker.sexualOrientation}
          race={worker.race}
          religion={worker.religion}
          languages={worker.languages}
          weightKg={worker.weightKg}
          heightCm={worker.heightCm}
          tags={worker.tags ?? []}
        />
      </div>

      {/* Admin-only: test-account toggle */}
      <WorkerTestAccountToggle workerId={worker.id} initialIsTest={worker.isTest} />

      {/* Row 2: Address (full-width) */}
      <div className="mb-6">
        <WorkerAddressCard
          serviceAreas={worker.serviceAreas}
          location={worker.location}
        />
      </div>

      {/* Row 3: Professional Data (full-width) */}
      <div className="mb-6">
        <WorkerProfessionalCard
          profession={worker.profession}
          occupation={worker.occupation}
          knowledgeLevel={worker.knowledgeLevel}
          titleCertificate={worker.titleCertificate}
          experienceTypes={worker.experienceTypes}
          yearsExperience={worker.yearsExperience}
          preferredTypes={worker.preferredTypes}
          preferredAgeRange={worker.preferredAgeRange}
          languages={worker.languages}
          linkedinUrl={worker.linkedinUrl}
        />
      </div>

      {/* Tab Navigation */}
      <div className="mb-6">
        <WorkerProfileTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab Content */}
      <div className="mb-6">
        {activeTab === 'encuadres' && (
          <WorkerEncuadresCard encuadres={worker.encuadres} />
        )}
        {activeTab === 'documents' && (
          <WorkerDocumentsCard
            documents={worker.documents}
            profession={worker.profession}
            onUpload={docs.uploadDocument}
            onDelete={docs.deleteDocument}
            onView={docs.viewDocument}
            onValidate={docs.validateDocument}
            onInvalidate={docs.invalidateDocument}
            loadingTypes={docs.loadingTypes}
            errors={docs.errors}
            documentValidations={worker.documents?.documentValidations}
          >
            <AdditionalDocumentsSection
              documents={additionalDocs.documents}
              onUpload={additionalDocs.uploadDocument}
              onDelete={additionalDocs.deleteDocument}
              onView={additionalDocs.viewDocument}
              isLoading={additionalDocs.isLoading}
            />
          </WorkerDocumentsCard>
        )}
        {activeTab === 'availability' && (
          <WorkerAvailabilityCard availability={worker.availability ?? []} />
        )}
        {activeTab === 'financial' && (
          <PlaceholderTab label={t('admin.workerDetail.tabs.financial')} />
        )}
        {activeTab === 'history' && (
          <PlaceholderTab label={t('admin.workerDetail.tabs.history')} />
        )}
      </div>
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex items-center justify-center min-h-[200px]">
      <Text size="sm" color="muted">
        {label} — {t('admin.workerDetail.comingSoon')}
      </Text>
    </div>
  );
}
