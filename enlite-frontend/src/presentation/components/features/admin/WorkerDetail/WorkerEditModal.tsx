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
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { GooglePlacesAutocomplete } from '@presentation/components/molecules/GooglePlacesAutocomplete';
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
const CLOSE_MS = 300;

/**
 * Admin-only worker edit — side drawer (slides in from the right, mirroring the
 * VacancyModal design-system pattern). Mounted only when the viewer is ADMIN.
 * Saves identity/profession via PATCH /profile and the address via
 * PUT /service-area (Google Places + lat/lng), like the worker self-service flow.
 */
export function WorkerEditModal({ worker, onClose, onSaved }: WorkerEditModalProps): JSX.Element {
  const { t } = useTranslation();
  const tm = (k: string, def: string) => t(`admin.workerDetail.editModal.${k}`, { defaultValue: def });

  const primaryArea = worker.serviceAreas[0];
  const initialAddress = primaryArea?.address ?? '';
  const initialRadius = primaryArea?.serviceRadiusKm ?? 10;

  const coordsRef = useRef<{ lat: number; lng: number }>({
    lat: primaryArea?.lat ?? 0,
    lng: primaryArea?.lng ?? 0,
  });
  const autoFilledRef = useRef<{ city?: string; postalCode?: string; neighborhood?: string }>({});
  const [addressDirty, setAddressDirty] = useState(false);
  const [placeSelected, setPlaceSelected] = useState<boolean>(!!primaryArea?.lat && !!primaryArea?.lng);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // slide-in animation: mount off-screen, then transition in on next tick
  const [show, setShow] = useState(false);

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
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => {
    setShow(false);
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const professionOptions: SelectOption[] = WORKER_PROFESSIONS.map((p) => ({
    value: p,
    label: t(`admin.workerDetail.professionValue.${p}`, { defaultValue: p }),
  }));
  const documentTypeOptions: SelectOption[] = WORKER_DOCUMENT_TYPES.map((d) => ({ value: d, label: d }));

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
      setError('email', { message: tm('invalidEmail', 'E-mail inválido') });
      return;
    }

    const radiusChanged = Number(values.serviceRadiusKm) !== initialRadius;
    const addressLineChanged = values.address.trim() !== initialAddress.trim();
    const mustSaveAddress = addressDirty || radiusChanged || addressLineChanged || !!values.addressComplement.trim();

    if (mustSaveAddress && values.address.trim() && !placeSelected) {
      setError('address', { message: tm('selectAddress', 'Seleccioná una dirección de la lista') });
      return;
    }

    const profilePatch = buildProfilePatch(values);
    const hasProfileChange = Object.keys(profilePatch).length > 0;

    if (!hasProfileChange && !(mustSaveAddress && values.address.trim())) {
      handleClose();
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
      handleClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : tm('saveError', 'Error al guardar'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="worker-edit-modal-backdrop"
      />

      {/* Side drawer — slides from the right */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tm('title', 'Editar prestador')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="worker-edit-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">
            {tm('title', 'Editar prestador')}
          </Heading>
          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSubmit(onSubmit)}
              isLoading={busy}
              className="w-32"
              data-testid="we-save"
            >
              {tm('save', 'Guardar')}
            </Button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t('admin.workerDetail.modal.close', { defaultValue: 'Cerrar' })}
              className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {/* Identidade */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={tm('firstName', 'Nombre')} htmlFor="we-firstName">
              <InputWithIcon id="we-firstName" inputSize="compact" data-testid="we-firstName" {...register('firstName')} />
            </FormField>
            <FormField label={tm('lastName', 'Apellido')} htmlFor="we-lastName">
              <InputWithIcon id="we-lastName" inputSize="compact" data-testid="we-lastName" {...register('lastName')} />
            </FormField>
            <FormField label={tm('email', 'E-mail')} htmlFor="we-email">
              <InputWithIcon id="we-email" type="email" inputSize="compact" error={errors.email?.message} data-testid="we-email" {...register('email')} />
            </FormField>
            <FormField label={t('admin.workerDetail.profession')} htmlFor="we-profession">
              <Controller
                control={control}
                name="profession"
                render={({ field }) => (
                  <SelectField
                    inputSize="compact"
                    options={professionOptions}
                    placeholder={tm('unset', '—')}
                    value={field.value}
                    onChange={field.onChange}
                    data-testid="we-profession"
                  />
                )}
              />
            </FormField>
            <FormField label={tm('documentType', 'Tipo de documento')} htmlFor="we-documentType">
              <Controller
                control={control}
                name="documentType"
                render={({ field }) => (
                  <SelectField
                    inputSize="compact"
                    options={documentTypeOptions}
                    placeholder={tm('unset', '—')}
                    value={field.value}
                    onChange={field.onChange}
                    data-testid="we-documentType"
                  />
                )}
              />
            </FormField>
            <FormField label={tm('documentNumber', 'Número de documento')} htmlFor="we-documentNumber">
              <InputWithIcon id="we-documentNumber" inputSize="compact" data-testid="we-documentNumber" {...register('documentNumber')} />
            </FormField>
          </div>

          {/* Endereço (Google Places) */}
          <div className="flex flex-col gap-4 pt-2 border-t border-slate-100">
            <Text size="sm" weight="semibold" color="secondary">
              {tm('addressSection', 'Dirección')}
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
              <FormField label={t('admin.workerDetail.addressComplement')} htmlFor="we-complement">
                <InputWithIcon id="we-complement" inputSize="compact" data-testid="we-complement" {...register('addressComplement', { onChange: () => setAddressDirty(true) })} />
              </FormField>
              <FormField label={`${t('admin.workerDetail.radius')} (km)`} htmlFor="we-radius">
                <Controller
                  control={control}
                  name="serviceRadiusKm"
                  render={({ field }) => (
                    <SelectField
                      inputSize="compact"
                      options={RADIUS_OPTIONS.map((r) => ({ value: String(r), label: `${r} km` }))}
                      placeholder={tm('unset', '—')}
                      value={String(field.value)}
                      onChange={(v) => { field.onChange(Number(v)); setAddressDirty(true); }}
                      data-testid="we-radius"
                    />
                  )}
                />
              </FormField>
            </div>
          </div>

          {submitError && <Text size="sm" className="text-red-600">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
