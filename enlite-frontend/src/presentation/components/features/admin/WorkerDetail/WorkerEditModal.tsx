import { useEffect, useRef, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import {
  WorkerDetail,
  WorkerProfileUpdatePayload,
  WORKER_PROFESSIONS,
  WORKER_DOCUMENT_TYPES,
} from '@domain/entities/Worker';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Input } from '@presentation/components/atoms/Input';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import { GooglePlacesAutocomplete } from '@presentation/components/molecules';
import { extractAddressComponents } from '@application/use-cases/extractAddressComponents';

interface WorkerEditModalProps {
  worker: WorkerDetail;
  onClose: () => void;
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void;
}

interface EditForm {
  firstName: string;
  lastName: string;
  email: string;
  documentType: string;
  documentNumber: string;
  profession: string;
  address: string;
  addressComplement: string;
  serviceRadiusKm: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RADIUS_OPTIONS = [5, 10, 20, 50];

/**
 * Admin-only worker edit modal. Mounted only when the viewer is ADMIN (the
 * trigger in WorkerDetailContent is gated). Saves identity/profession via
 * PATCH /profile and the address via PUT /service-area (Google Places + lat/lng),
 * mirroring the worker self-service address flow.
 */
export function WorkerEditModal({ worker, onClose, onSaved }: WorkerEditModalProps): JSX.Element {
  const { t } = useTranslation();

  const primaryArea = worker.serviceAreas[0];
  const initialAddress = primaryArea?.address ?? '';
  const initialRadius = primaryArea?.serviceRadiusKm ?? 10;

  const coordsRef = useRef<{ lat: number; lng: number }>({
    lat: primaryArea?.lat ?? 0,
    lng: primaryArea?.lng ?? 0,
  });
  const autoFilledRef = useRef<{ city?: string; postalCode?: string; neighborhood?: string }>({});
  const [addressDirty, setAddressDirty] = useState(false);
  // Prefilled address with existing coords counts as a valid selection.
  const [placeSelected, setPlaceSelected] = useState<boolean>(!!primaryArea?.lat && !!primaryArea?.lng);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<EditForm>({
    defaultValues: {
      firstName: worker.firstName ?? '',
      lastName: worker.lastName ?? '',
      email: worker.email ?? '',
      documentType: worker.documentType ?? '',
      documentNumber: worker.documentNumber ?? '',
      profession: worker.profession ?? '',
      address: initialAddress,
      addressComplement: '',
      serviceRadiusKm: initialRadius,
    },
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const professionOptions: SelectOption[] = [
    { value: '', label: t('admin.workerDetail.editModal.unset', { defaultValue: '—' }) },
    ...WORKER_PROFESSIONS.map((p) => ({
      value: p,
      label: t(`admin.workerDetail.professionValue.${p}`, { defaultValue: p }),
    })),
  ];
  const documentTypeOptions: SelectOption[] = [
    { value: '', label: t('admin.workerDetail.editModal.unset', { defaultValue: '—' }) },
    ...WORKER_DOCUMENT_TYPES.map((d) => ({ value: d, label: d })),
  ];

  const handlePlaceSelected = (place: google.maps.places.PlaceResult): void => {
    if (place.geometry?.location) {
      coordsRef.current = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
      const extracted = extractAddressComponents(place);
      autoFilledRef.current = {
        city: extracted.city ?? undefined,
        postalCode: extracted.postalCode ?? undefined,
        neighborhood: extracted.neighborhood ?? undefined,
      };
      setPlaceSelected(true);
      setAddressDirty(true);
    }
  };

  const buildProfilePatch = (values: EditForm): WorkerProfileUpdatePayload => {
    const patch: WorkerProfileUpdatePayload = {};
    if (values.firstName.trim() && values.firstName.trim() !== (worker.firstName ?? '')) patch.firstName = values.firstName.trim();
    if (values.lastName.trim() && values.lastName.trim() !== (worker.lastName ?? '')) patch.lastName = values.lastName.trim();
    if (values.email.trim() && values.email.trim() !== (worker.email ?? '')) patch.email = values.email.trim();
    if (values.documentNumber.trim() && values.documentNumber.trim() !== (worker.documentNumber ?? '')) patch.documentNumber = values.documentNumber.trim();
    if (values.documentType && values.documentType !== (worker.documentType ?? '') && (WORKER_DOCUMENT_TYPES as readonly string[]).includes(values.documentType)) {
      patch.documentType = values.documentType as WorkerProfileUpdatePayload['documentType'];
    }
    if (values.profession && values.profession !== (worker.profession ?? '') && (WORKER_PROFESSIONS as readonly string[]).includes(values.profession)) {
      patch.profession = values.profession as WorkerProfileUpdatePayload['profession'];
    }
    return patch;
  };

  const onSubmit = async (values: EditForm): Promise<void> => {
    setSubmitError(null);

    if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) {
      setError('email', { message: t('admin.workerDetail.editModal.invalidEmail', { defaultValue: 'E-mail inválido' }) });
      return;
    }

    const radiusChanged = Number(values.serviceRadiusKm) !== initialRadius;
    const addressLineChanged = values.address.trim() !== initialAddress.trim();
    const mustSaveAddress = addressDirty || radiusChanged || addressLineChanged || !!values.addressComplement.trim();

    if (mustSaveAddress && values.address.trim() && !placeSelected) {
      setError('address', { message: t('admin.workerDetail.editModal.selectAddress', { defaultValue: 'Seleccioná una dirección de la lista' }) });
      return;
    }

    const profilePatch = buildProfilePatch(values);
    const hasProfileChange = Object.keys(profilePatch).length > 0;

    if (!hasProfileChange && !(mustSaveAddress && values.address.trim())) {
      onClose();
      return;
    }

    setBusy(true);
    try {
      if (hasProfileChange) {
        await AdminApiService.updateWorkerProfile(worker.id, profilePatch);
      }
      if (mustSaveAddress && values.address.trim()) {
        await AdminApiService.updateWorkerServiceArea(worker.id, {
          address: values.address.trim(),
          addressComplement: values.addressComplement.trim() || undefined,
          serviceRadiusKm: Number(values.serviceRadiusKm),
          lat: coordsRef.current.lat,
          lng: coordsRef.current.lng,
          city: autoFilledRef.current.city,
          postalCode: autoFilledRef.current.postalCode,
          neighborhood: autoFilledRef.current.neighborhood,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('admin.workerDetail.editModal.saveError', { defaultValue: 'Error al guardar' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="worker-edit-modal-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.workerDetail.editModal.title', { defaultValue: 'Editar prestador' })}
        className="bg-white rounded-card w-full max-w-2xl my-8 shadow-lg relative"
        onClick={(e) => e.stopPropagation()}
        data-testid="worker-edit-modal"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-200">
          <Heading level={2} weight="semibold" color="primary">
            {t('admin.workerDetail.editModal.title', { defaultValue: 'Editar prestador' })}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('admin.workerDetail.modal.close', { defaultValue: 'Cerrar' })}
            className="p-1.5 rounded-lg text-gray-800 hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 flex flex-col gap-5">
          {/* Identidade */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="we-firstName">{t('admin.workerDetail.editModal.firstName', { defaultValue: 'Nombre' })}</Label>
              <Input id="we-firstName" data-testid="we-firstName" {...register('firstName')} />
            </div>
            <div>
              <Label htmlFor="we-lastName">{t('admin.workerDetail.editModal.lastName', { defaultValue: 'Apellido' })}</Label>
              <Input id="we-lastName" data-testid="we-lastName" {...register('lastName')} />
            </div>
            <div>
              <Label htmlFor="we-email">{t('admin.workerDetail.editModal.email', { defaultValue: 'E-mail' })}</Label>
              <Input id="we-email" type="email" data-testid="we-email" error={errors.email?.message} {...register('email')} />
            </div>
            <div>
              <Label htmlFor="we-profession">{t('admin.workerDetail.profession')}</Label>
              <Select id="we-profession" data-testid="we-profession" options={professionOptions} {...register('profession')} />
            </div>
            <div>
              <Label htmlFor="we-documentType">{t('admin.workerDetail.editModal.documentType', { defaultValue: 'Tipo de documento' })}</Label>
              <Select id="we-documentType" data-testid="we-documentType" options={documentTypeOptions} {...register('documentType')} />
            </div>
            <div>
              <Label htmlFor="we-documentNumber">{t('admin.workerDetail.editModal.documentNumber', { defaultValue: 'Número de documento' })}</Label>
              <Input id="we-documentNumber" data-testid="we-documentNumber" {...register('documentNumber')} />
            </div>
          </div>

          {/* Endereço (Google Places) */}
          <div className="flex flex-col gap-4 pt-2 border-t border-gray-200">
            <Text size="sm" weight="semibold" color="secondary">
              {t('admin.workerDetail.editModal.addressSection', { defaultValue: 'Dirección' })}
            </Text>
            <Controller
              control={control}
              name="address"
              render={({ field }) => (
                <GooglePlacesAutocomplete
                  label={t('admin.workerDetail.address')}
                  value={field.value}
                  onChange={(v) => { field.onChange(v); setAddressDirty(true); }}
                  onPlaceSelected={handlePlaceSelected}
                  onValidationChange={setPlaceSelected}
                  error={errors.address?.message}
                  requireSelection
                />
              )}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="we-complement">{t('admin.workerDetail.addressComplement')}</Label>
                <Input id="we-complement" data-testid="we-complement" {...register('addressComplement', { onChange: () => setAddressDirty(true) })} />
              </div>
              <div>
                <Label htmlFor="we-radius">{t('admin.workerDetail.radius')} (km)</Label>
                <Select
                  id="we-radius"
                  data-testid="we-radius"
                  options={RADIUS_OPTIONS.map((r) => ({ value: String(r), label: `${r} km` }))}
                  {...register('serviceRadiusKm', { onChange: () => setAddressDirty(true) })}
                />
              </div>
            </div>
          </div>

          {submitError && (
            <Text size="sm" className="text-red-600">{submitError}</Text>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('admin.workerDetail.editModal.cancel', { defaultValue: 'Cancelar' })}
            </Button>
            <Button type="submit" variant="primary" isLoading={busy} data-testid="we-save">
              {t('admin.workerDetail.editModal.save', { defaultValue: 'Guardar' })}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
