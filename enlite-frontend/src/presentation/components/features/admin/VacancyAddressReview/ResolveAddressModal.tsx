import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, MapPin, PlusCircle, X, Loader2 } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { AdminVacancyAddressApiService, type ResolveAddressBody } from '@infrastructure/http/AdminVacancyAddressApiService';
import type { PendingAddressReviewItem, PatientAddressRow } from '@domain/entities/PatientAddress';

export interface ResolveAddressModalProps {
  item: PendingAddressReviewItem;
  onConfirm: (body: ResolveAddressBody) => Promise<void>;
  onClose: () => void;
  isLoading: boolean;
}

export function ResolveAddressModal({
  item,
  onConfirm,
  onClose,
  isLoading,
}: ResolveAddressModalProps) {
  const { t } = useTranslation();
  const s = (k: string) => t(`admin.pendingAddressReview.resolveModal.${k}`);

  const [existingAddresses, setExistingAddresses] = useState<PatientAddressRow[]>([]);
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);

  // Create new address inline form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newAddressFormatted, setNewAddressFormatted] = useState('');
  const [newAddressRaw, setNewAddressRaw] = useState('');

  useEffect(() => {
    if (!item.patient_id) return;
    setLoadingAddresses(true);
    AdminVacancyAddressApiService.listPatientAddresses(item.patient_id)
      .then(addrs => setExistingAddresses(addrs))
      .catch(() => setExistingAddresses([]))
      .finally(() => setLoadingAddresses(false));
  }, [item.patient_id]);

  const canConfirm =
    (!showCreateForm && selectedAddressId !== null) ||
    (showCreateForm && newAddressFormatted.trim().length > 0);

  // Sem guarda de `canConfirm` aqui: o único chamador é o botão "Confirmar", que já vem
  // `disabled` sempre que `canConfirm` é false — um segundo guard interno é código morto
  // (inalcançável por clique real ou simulado; disabled suprime o próprio evento).
  const handleConfirm = async () => {
    let body: ResolveAddressBody;
    if (showCreateForm) {
      body = {
        createAddress: {
          address_formatted: newAddressFormatted.trim(),
          ...(newAddressRaw.trim() ? { address_raw: newAddressRaw.trim() } : {}),
        },
      };
    } else {
      body = { patient_address_id: selectedAddressId! };
    }
    await onConfirm(body);
  };

  const handleSelectExisting = (id: string) => {
    setSelectedAddressId(id);
    setShowCreateForm(false);
  };

  const handleShowCreate = () => {
    setSelectedAddressId(null);
    setShowCreateForm(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col gap-5 p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Typography variant="h3" weight="semibold" className="text-slate-800">
            {s('title')}
          </Typography>
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
            aria-label={s('cancel')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Legacy address — informational */}
        {item.legacy_address_hint && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {s('legacyLabel')}
            </span>
            <span className="text-sm text-slate-700">{item.legacy_address_hint}</span>
          </div>
        )}

        {/* Existing addresses */}
        {loadingAddresses ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : existingAddresses.length === 0 && !item.patient_id ? (
          <Typography variant="body" className="text-slate-500 text-sm">
            {s('noAddresses')}
          </Typography>
        ) : existingAddresses.length === 0 ? (
          <Typography variant="body" className="text-slate-500 text-sm">
            {s('noAddresses')}
          </Typography>
        ) : (
          <div className="flex flex-col gap-3">
            {existingAddresses.map(addr => {
              const isSelected = !showCreateForm && selectedAddressId === addr.id;
              return (
                <button
                  key={addr.id}
                  type="button"
                  onClick={() => handleSelectExisting(addr.id)}
                  className={[
                    'w-full text-left rounded-lg border-2 px-4 py-3 flex items-start gap-3 transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-slate-200 bg-white hover:border-slate-300',
                  ].join(' ')}
                >
                  {isSelected ? (
                    <CheckCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  ) : (
                    <MapPin className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
                  )}
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="text-sm font-medium text-slate-800 truncate">
                      {addr.address_formatted}
                    </span>
                    {addr.address_raw && (
                      <span className="text-xs text-slate-400 truncate">{addr.address_raw}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Create new address button / inline form */}
        {item.patient_id && (
          <>
            {!showCreateForm ? (
              <button
                type="button"
                onClick={handleShowCreate}
                disabled={isLoading}
                className="flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors self-start disabled:opacity-50"
              >
                <PlusCircle className="w-4 h-4" />
                {s('createNew')}
              </button>
            ) : (
              <div className="border border-slate-200 rounded-lg p-4 flex flex-col gap-3 bg-slate-50">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-slate-600">
                    {s('addressFormatted')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={newAddressFormatted}
                    onChange={e => setNewAddressFormatted(e.target.value)}
                    placeholder={s('addressFormatted')}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-slate-600">{s('addressRaw')}</label>
                  <input
                    type="text"
                    value={newAddressRaw}
                    onChange={e => setNewAddressRaw(e.target.value)}
                    placeholder={s('addressRaw')}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors disabled:opacity-50"
          >
            {s('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm || isLoading}
            className="px-6 py-2 text-sm font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {s('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
