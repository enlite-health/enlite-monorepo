/**
 * useTalentumConfig
 *
 * Orchestrates the TalentumConfigPage flow:
 *   - Fetch vacancy data on mount
 *   - Generate AI content (description + prescreening)
 *   - Save prescreening config
 *   - Publish to Talentum
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PrescreeningQuestion, FaqItem } from '@presentation/components/features/admin/TalentumConfig/PrescreeningStep';
import type { VacancySummaryData } from '@presentation/components/features/admin/TalentumConfig/VacancySummaryCard';
import type { GenerateAIButtonStatus } from '@presentation/components/features/admin/TalentumConfig/GenerateAIButton';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface UseTalentumConfigState {
  vacancyData: VacancySummaryData | null;
  isLoadingVacancy: boolean;
  vacancyError: string | null;

  description: string;
  prescreeningQuestions: PrescreeningQuestion[];
  prescreeningFaq: FaqItem[];

  generateStatus: GenerateAIButtonStatus;
  generateError: string | null;

  isSaving: boolean;
  saveError: string | null;

  isPublishing: boolean;
  publishError: string | null;
}

interface UseTalentumConfigActions {
  setDescription: (v: string) => void;
  generateAIContent: () => Promise<void>;
  savePrescreening: (data: { questions: PrescreeningQuestion[]; faq: FaqItem[] }) => Promise<void>;
  publish: () => Promise<void>;
}

export type UseTalentumConfigResult = UseTalentumConfigState & UseTalentumConfigActions;

// ---------------------------------------------------------------------------
// Mapper: raw vacancy API → VacancySummaryData
// ---------------------------------------------------------------------------

function mapVacancyToSummary(raw: any): VacancySummaryData {
  return {
    caseNumber: raw.case_number ?? null,
    vacancyNumber: raw.vacancy_number ?? null,
    patientFirstName: raw.patient_first_name ?? null,
    patientLastName: raw.patient_last_name ?? null,
    status: raw.status ?? null,
    publishedAt: raw.talentum_published_at ?? null,
    closedAt: raw.closed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface TalentumConfigPreloaded {
  description?: string;
  prescreeningQuestions?: PrescreeningQuestion[];
  prescreeningFaq?: FaqItem[];
}

export function useTalentumConfig(
  vacancyId: string,
  preloaded?: TalentumConfigPreloaded,
): UseTalentumConfigResult {
  const [vacancyData, setVacancyData] = useState<VacancySummaryData | null>(null);
  const [isLoadingVacancy, setIsLoadingVacancy] = useState(false);
  const [vacancyError, setVacancyError] = useState<string | null>(null);

  // Seed from preloaded payload (passed via navigate state from Step 1) so we
  // skip re-generating when the user just completed Step 1.
  const [description, setDescription] = useState(preloaded?.description ?? '');
  const [prescreeningQuestions, setPrescreeningQuestions] = useState<PrescreeningQuestion[]>(
    preloaded?.prescreeningQuestions ?? [],
  );
  const [prescreeningFaq, setPrescreeningFaq] = useState<FaqItem[]>(
    preloaded?.prescreeningFaq ?? [],
  );

  const [generateStatus, setGenerateStatus] = useState<GenerateAIButtonStatus>(
    preloaded?.description ? 'success' : 'idle',
  );
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Fetch vacancy on mount
  useEffect(() => {
    if (!vacancyId) return;
    let cancelled = false;

    async function fetchVacancy() {
      setIsLoadingVacancy(true);
      setVacancyError(null);
      try {
        const raw = await AdminApiService.getVacancyById(vacancyId);
        if (!cancelled) setVacancyData(mapVacancyToSummary(raw));
      } catch (err: unknown) {
        if (!cancelled) setVacancyError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoadingVacancy(false);
      }
    }

    fetchVacancy();
    return () => { cancelled = true; };
  }, [vacancyId]);

  const generateAIContent = useCallback(async () => {
    setGenerateStatus('loading');
    setGenerateError(null);
    try {
      const result = await AdminApiService.generateAIContent(vacancyId);
      setDescription(result.description);
      setPrescreeningQuestions(result.prescreening.questions);
      setPrescreeningFaq(result.prescreening.faq);
      setGenerateStatus('success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setGenerateError(msg);
      setGenerateStatus('error');
    }
  }, [vacancyId]);

  const savePrescreening = useCallback(async (data: {
    questions: PrescreeningQuestion[];
    faq: FaqItem[];
  }) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await AdminApiService.savePrescreeningConfig(vacancyId, data);
      setPrescreeningQuestions(data.questions);
      setPrescreeningFaq(data.faq);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, [vacancyId]);

  const publish = useCallback(async () => {
    setIsPublishing(true);
    setPublishError(null);
    try {
      // Auto-save the current prescreening config first — the publish
      // endpoint requires it persisted in DB and the Publish button is in
      // the page header (separate from the prescreening section's "Save"
      // button). This avoids the "No prescreening questions configured"
      // 400 when the user just reviews AI output and clicks Publish.
      await AdminApiService.savePrescreeningConfig(vacancyId, {
        questions: prescreeningQuestions,
        faq: prescreeningFaq,
      });
      await AdminApiService.publishToTalentum(vacancyId);
      // Re-fetch vacancy to get updated publishedAt
      const raw = await AdminApiService.getVacancyById(vacancyId);
      setVacancyData(mapVacancyToSummary(raw));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPublishError(msg);
      throw err;
    } finally {
      setIsPublishing(false);
    }
  }, [vacancyId, prescreeningQuestions, prescreeningFaq]);

  return {
    vacancyData,
    isLoadingVacancy,
    vacancyError,
    description,
    prescreeningQuestions,
    prescreeningFaq,
    generateStatus,
    generateError,
    isSaving,
    saveError,
    isPublishing,
    publishError,
    setDescription,
    generateAIContent,
    savePrescreening,
    publish,
  };
}
