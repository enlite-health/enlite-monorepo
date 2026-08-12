/**
 * workerProfileFiltersConfig.ts
 *
 * Types and constants for the worker profile filter row.
 * Kept in a separate file so react-refresh/only-export-components
 * rule is satisfied (component file exports only components).
 */

export interface WorkerProfileFilters {
  profession: string;
  preferredAgeRange: string;
  experienceType: string;
  preferredType: string;
  language: string;
  sex: string;
  state: string;
  city: string;
  days: string[];
}

export const INITIAL_PROFILE_FILTERS: WorkerProfileFilters = {
  profession: '',
  preferredAgeRange: '',
  experienceType: '',
  preferredType: '',
  language: '',
  sex: '',
  state: '',
  city: '',
  days: [],
};
