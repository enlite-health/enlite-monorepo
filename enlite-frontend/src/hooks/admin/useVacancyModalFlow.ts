/**
 * useVacancyModalFlow
 *
 * Manages state for the VacancyModal — case selection and derived patient data.
 * When a case is selected, automatically fetches:
 *   - Patient detail (for dependencyLevel)
 *   - Patient addresses (for address selection)
 *
 * Privacy: never stores PII (firstName, lastName). Only caseNumber, patientId,
 * dependencyLevel and addresses.
 */

import { useState, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientAddressRow } from '@domain/entities/PatientAddress';

export interface CaseOption {
  caseNumber: number;
  patientId: string;
  dependencyLevel: string;
}

export interface VacancyModalFlowState {
  selectedCaseNumber: number | null;
  selectedPatientId: string | null;
  dependencyLevel: string | null;
  addresses: PatientAddressRow[];
  selectedAddressId: string | null;
  isLoadingPatient: boolean;
  patientError: string | null;
}

export interface VacancyModalFlowActions {
  /**
   * Selects a case + fetches patient/addresses. After fetch:
   *   - if `preferredAddressId` is supplied AND exists in the fetched list, it
   *     is selected (used by edit mode to honor `vacancy.patient_address_id`);
   *   - otherwise the first address is auto-selected.
   * Falls back to `null` when the patient has no addresses.
   */
  selectCase: (
    caseNumber: number,
    patientId: string,
    preferredAddressId?: string | null,
  ) => void;
  selectAddress: (addressId: string) => void;
  reset: () => void;
}

const INITIAL_STATE: VacancyModalFlowState = {
  selectedCaseNumber: null,
  selectedPatientId: null,
  dependencyLevel: null,
  addresses: [],
  selectedAddressId: null,
  isLoadingPatient: false,
  patientError: null,
};

export function useVacancyModalFlow(): VacancyModalFlowState & VacancyModalFlowActions {
  const [state, setState] = useState<VacancyModalFlowState>(INITIAL_STATE);

  const selectCase = useCallback(
    (caseNumber: number, patientId: string, preferredAddressId?: string | null) => {
      setState((prev) => ({
        ...prev,
        selectedCaseNumber: caseNumber,
        selectedPatientId: patientId,
        selectedAddressId: null,
        addresses: [],
        dependencyLevel: null,
        isLoadingPatient: true,
        patientError: null,
      }));

      Promise.all([
        AdminApiService.getPatientById(patientId),
        AdminApiService.listPatientAddresses(patientId),
      ])
        .then(([patient, addresses]) => {
          const preferred =
            preferredAddressId && addresses.some((a) => a.id === preferredAddressId)
              ? preferredAddressId
              : null;
          setState((prev) => ({
            ...prev,
            dependencyLevel: patient.dependencyLevel ?? null,
            addresses,
            selectedAddressId: preferred ?? addresses[0]?.id ?? null,
            isLoadingPatient: false,
          }));
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setState((prev) => ({
            ...prev,
            isLoadingPatient: false,
            patientError: msg,
          }));
        });
    },
    [],
  );

  const selectAddress = useCallback((addressId: string) => {
    setState((prev) => ({ ...prev, selectedAddressId: addressId }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, selectCase, selectAddress, reset };
}
