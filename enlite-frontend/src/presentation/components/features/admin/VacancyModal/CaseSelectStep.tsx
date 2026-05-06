import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, MapPin } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { CaseOption, VacancyModalFlowState, VacancyModalFlowActions } from '@hooks/admin/useVacancyModalFlow';

interface CaseSelectStepProps
  extends Pick<VacancyModalFlowState, 'selectedCaseNumber' | 'selectedPatientId' | 'dependencyLevel' | 'addresses' | 'selectedAddressId' | 'isLoadingPatient' | 'patientError'>
  , Pick<VacancyModalFlowActions, 'selectCase' | 'selectAddress'> {}

export function CaseSelectStep({
  selectedCaseNumber,
  selectedPatientId,
  dependencyLevel,
  addresses,
  selectedAddressId,
  isLoadingPatient,
  patientError,
  selectCase,
  selectAddress,
}: CaseSelectStepProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.vacancyModal.caseSelectStep.${k}`);

  const [cases, setCases] = useState<CaseOption[]>([]);
  const [isLoadingCases, setIsLoadingCases] = useState(true);
  const [casesError, setCasesError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoadingCases(true);
    AdminApiService.getCasesForSelect()
      .then(setCases)
      .catch((err: unknown) => setCasesError(err instanceof Error ? err.message : String(err)))
      .finally(() => setIsLoadingCases(false));
  }, []);

  const handleCaseChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) return;
    const found = cases.find((c) => c.caseNumber === Number(val));
    if (found) selectCase(found.caseNumber, found.patientId);
  };

  const inputCls =
    'border border-[#D9D9D9] rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white w-full';

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold text-[#1B1B4B]/50 uppercase tracking-widest mb-3">
          {tp('sectionTitle')}
        </p>

        {/* Case select */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-600">{tp('caseLabel')} *</label>
          {isLoadingCases ? (
            <div className="flex items-center gap-2 py-2 text-slate-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {tp('loadingCases')}
            </div>
          ) : casesError ? (
            <p className="text-red-500 text-sm">{casesError}</p>
          ) : (
            <select
              className={inputCls}
              value={selectedCaseNumber ?? ''}
              onChange={handleCaseChange}
              data-testid="case-select"
            >
              <option value="">{tp('casePlaceholder')}</option>
              {cases.map((c) => (
                <option key={c.caseNumber} value={c.caseNumber}>
                  {t('admin.vacancyModal.caseSelectStep.caseOptionLabel', {
                    caseNumber: c.caseNumber,
                    dependencyLevel: c.dependencyLevel || '—',
                  })}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Derived patient info */}
      {selectedPatientId && (
        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 space-y-3">
          {isLoadingPatient ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {tp('loadingPatient')}
            </div>
          ) : patientError ? (
            <p className="text-red-500 text-sm">{patientError}</p>
          ) : (
            <>
              {dependencyLevel && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">
                    {tp('dependencyLevelLabel')}
                  </span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                    dependencyLevel === 'VERY_SEVERE' ? 'bg-red-50 text-red-700 border-red-200' :
                    dependencyLevel === 'SEVERE'      ? 'bg-orange-50 text-orange-700 border-orange-200' :
                    dependencyLevel === 'MODERATE'    ? 'bg-amber-50 text-amber-700 border-amber-200' :
                    dependencyLevel === 'MILD'        ? 'bg-green-50 text-green-700 border-green-200' :
                                                        'bg-blue-50 text-blue-700 border-blue-200'
                  }`}>
                    {dependencyLevel}
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">
                  {tp('selectAddressLabel')} *
                </span>
                {addresses.length === 0 ? (
                  <p className="text-slate-500 text-sm">{tp('noAddresses')}</p>
                ) : (
                  <div className="space-y-2">
                    {addresses.map((addr) => (
                      <button
                        key={addr.id}
                        type="button"
                        onClick={() => selectAddress(addr.id)}
                        className={[
                          'w-full text-left p-3 rounded-lg border transition-colors flex items-start gap-2',
                          selectedAddressId === addr.id
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                            : 'border-slate-200 bg-white hover:border-slate-300',
                        ].join(' ')}
                        data-testid={`address-option-${addr.id}`}
                      >
                        <MapPin className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-slate-700 text-sm font-medium truncate">{addr.address_formatted || addr.address_raw || '—'}</p>
                          {addr.address_type && (
                            <p className="text-slate-500 text-xs mt-0.5">{addr.address_type}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
