/**
 * TalentumConfigPage
 *
 * Tela 2 do fluxo de criação de vaga:
 *   - Revisar conteúdo gerado pela IA
 *   - Configurar prescreening
 *   - Publicar no Talentum
 *
 * Rota: /admin/vacancies/:id/talentum
 */

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useTalentumConfig } from '@hooks/admin/useTalentumConfig';
import { Stepper } from '@presentation/components/molecules/Stepper';
import { VacancySummaryCard } from '@presentation/components/features/admin/TalentumConfig/VacancySummaryCard';
import { AIDescriptionEditor } from '@presentation/components/features/admin/TalentumConfig/AIDescriptionEditor';
import { PrescreeningStep } from '@presentation/components/features/admin/TalentumConfig/PrescreeningStep';
import { VacancySocialLinksCard } from '@presentation/components/features/admin/VacancyDetail/VacancySocialLinksCard';

export default function TalentumConfigPage(): JSX.Element {
  const { id: vacancyId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.talentumConfig.${k}`);
  const v = (k: string) => t(`admin.createVacancyV2.${k}`);

  // Step 1 navigates here with pre-generated AI content in location.state to skip
  // an extra generate call. Keep memoized so the hook only seeds once.
  const preloaded = useMemo(() => {
    const s = (location.state ?? {}) as Record<string, unknown>;
    if (!s || typeof s !== 'object') return undefined;
    return {
      description: typeof s.description === 'string' ? s.description : undefined,
      prescreeningQuestions: Array.isArray(s.prescreeningQuestions)
        ? (s.prescreeningQuestions as any)
        : undefined,
      prescreeningFaq: Array.isArray(s.prescreeningFaq)
        ? (s.prescreeningFaq as any)
        : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    vacancyData,
    isLoadingVacancy,
    vacancyError,
    description,
    prescreeningQuestions,
    prescreeningFaq,
    generateStatus,
    generateError,
    isPublishing,
    publishError,
    setDescription,
    generateAIContent,
    savePrescreening,
    publish,
  } = useTalentumConfig(vacancyId, preloaded);

  // Auto-generate AI content on mount when there's nothing yet (handles direct
  // navigation/refresh on Step 2 — Step 1 normally pre-loads via location.state).
  const hasGeneratedContent = description.trim().length > 0;
  useEffect(() => {
    if (!isLoadingVacancy && !vacancyError && !hasGeneratedContent && generateStatus === 'idle') {
      generateAIContent();
    }
  }, [isLoadingVacancy, vacancyError, hasGeneratedContent, generateStatus, generateAIContent]);

  const handlePrescreeningNext = async (data: {
    questions: typeof prescreeningQuestions;
    faq: typeof prescreeningFaq;
  }) => {
    await savePrescreening(data);
  };

  const handlePublish = async () => {
    try {
      await publish();
      navigate(`/admin/vacancies/${vacancyId}`);
    } catch {
      // publishError is stored in hook state
    }
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoadingVacancy) {
    return (
      <div className="w-full min-h-screen bg-[#FFF9FC] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#180149]" />
      </div>
    );
  }

  // ── Vacancy fetch error ────────────────────────────────────────────────────
  if (vacancyError) {
    return (
      <div className="w-full min-h-screen bg-[#FFF9FC] flex items-center justify-center px-6">
        <div className="bg-red-50 border border-red-200 rounded-[10px] px-6 py-4 max-w-md text-center">
          <Text size="sm" color="inherit" className="text-red-600">
            {vacancyError}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-[#FFF9FC] py-10 px-6">
      <div className="max-w-[1296px] mx-auto flex flex-col gap-6">

        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Heading level={1} weight="semibold">
              {tc('pageTitle')}
            </Heading>
            <Text size="base" weight="medium" color="secondary">
              {tc('pageSubtitle')}
            </Text>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            {publishError && (
              <Text as="span" size="sm" color="inherit" className="text-red-600 text-right max-w-[260px]">
                {publishError}
              </Text>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handlePublish}
              disabled={isPublishing}
              className="h-10 w-[200px] rounded-full bg-[#180149] text-white font-['Poppins'] font-semibold text-[16px] hover:bg-[#180149]/90 active:bg-[#180149]/80 flex items-center justify-center gap-2"
            >
              {isPublishing && <Loader2 className="w-4 h-4 animate-spin" />}
              {isPublishing ? tc('publishing') : tc('publishButton')}
            </Button>
          </div>
        </div>

        {/* ── Stepper ─────────────────────────────────────────────────────── */}
        <Stepper
          currentStep={2}
          steps={[
            { label: v('steps.vacancyData') },
            { label: v('steps.talentumConfig') },
            { label: v('steps.vacancyDetail') },
          ]}
        />

        {/* ── Section 1: Vacancy summary ──────────────────────────────────── */}
        {vacancyData && <VacancySummaryCard data={vacancyData} />}

        {/* ── Section 2: AI-generated content ─────────────────────────────── */}
        <div className="flex flex-col gap-6">
          <Heading level={2} weight="semibold" className="border-b border-[#d9d9d9] pb-2">
            {tc('aiSectionTitle')}
          </Heading>

          {/* Generation status banner — replaces the manual "Generate" button */}
          {generateStatus === 'loading' && (
            <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              <Text as="span" size="sm" color="inherit" className="text-blue-700">{tc('generatingAI')}</Text>
            </div>
          )}
          {generateStatus === 'error' && generateError && (
            <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <Text as="span" size="sm" color="inherit" className="text-red-600">{generateError}</Text>
              <Button variant="outline" size="sm" onClick={generateAIContent}>
                {tc('retryGenerate')}
              </Button>
            </div>
          )}

          <AIDescriptionEditor value={description} onChange={setDescription} />

          {/* Prescreening */}
          <Heading level={3} weight="semibold">
            {tc('prescreeningSectionTitle')}
          </Heading>

          <PrescreeningStep
            initialQuestions={prescreeningQuestions}
            initialFaq={prescreeningFaq}
            onNext={handlePrescreeningNext}
            onBack={() => navigate(`/admin/vacancies/new`)}
            isProcessing={false}
          />
        </div>

        {/* ── Section 3: Social links ──────────────────────────────────────── */}
        <div className="flex flex-col gap-6">
          <Heading level={2} weight="semibold" className="border-b border-[#d9d9d9] pb-2">
            {tc('socialSectionTitle')}
          </Heading>

          <VacancySocialLinksCard
            vacancyId={vacancyId}
            caseNumber={vacancyData?.caseNumber ?? null}
            vacancyNumber={vacancyData?.vacancyNumber ?? null}
            socialShortLinks={null}
            onRefresh={() => {}}
          />
        </div>

      </div>
    </div>
  );
}
