import { TFunction } from 'i18next';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';

export const getPlatformOptions = (t: TFunction): ComboboxOption[] => [
  { value: 'talentum', label: t('admin.workers.platformOptions.talentum', 'Talentum') },
  { value: 'planilla_operativa', label: t('admin.workers.platformOptions.planillaOperativa', 'Planilla Operativa') },
  { value: 'ana_care', label: t('admin.workers.platformOptions.anaCare', 'Ana Care') },
  { value: 'talent_search', label: t('admin.workers.platformOptions.talentum', 'Talentum') },
  { value: 'enlite_app', label: t('admin.workers.platformOptions.enliteApp', 'Enlite App') },
];

export const getDocsStatusOptions = (t: TFunction): ComboboxOption[] => [
  { value: 'complete', label: t('admin.workers.docsOptions.complete', 'Completos') },
  { value: 'incomplete', label: t('admin.workers.docsOptions.incomplete', 'Incompletos') },
];

export const getValidationStatusOptions = (t: TFunction): ComboboxOption[] => [
  { value: 'all_validated', label: t('admin.workers.validationOptions.allValidated', 'Todos validados') },
  { value: 'pending_validation', label: t('admin.workers.validationOptions.pendingValidation', 'Falta validación') },
];

export const PLATFORM_LABELS: Record<string, string> = {
  talentum: 'Talentum',
  planilla_operativa: 'Planilla Operativa',
  ana_care: 'Ana Care',
  talent_search: 'Talentum',
  enlite_app: 'Enlite App',
};

export const getPlatformLabel = (t: TFunction, platform: string): string => {
  const map: Record<string, string> = {
    talentum: t('admin.workers.platformOptions.talentum', 'Talentum'),
    planilla_operativa: t('admin.workers.platformOptions.planillaOperativa', 'Planilla Operativa'),
    ana_care: t('admin.workers.platformOptions.anaCare', 'Ana Care'),
    talent_search: t('admin.workers.platformOptions.talentum', 'Talentum'),
    enlite_app: t('admin.workers.platformOptions.enliteApp', 'Enlite App'),
  };
  return map[platform] ?? platform ?? '—';
};
