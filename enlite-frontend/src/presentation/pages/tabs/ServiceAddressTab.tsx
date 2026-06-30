import { useState, useEffect, useRef } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { serviceAddressSchema, ServiceAddressFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { GooglePlacesAutocomplete, AddressField, ServiceAreaMap } from '@presentation/components/molecules';
import { DistanceSlider } from '@presentation/components/shared/DistanceSlider';
import { InputWithIcon } from '@presentation/components/molecules';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useToast } from '@presentation/hooks/useToast';
import { Checkbox, Typography } from '@presentation/components/atoms';
import { extractAddressComponents } from '@application/use-cases/extractAddressComponents';

interface AutoFilledFields {
  city: string;
  postalCode: string;
  neighborhood: string;
}

export function ServiceAddressTab(): JSX.Element {
  const { t } = useTranslation();
  const { saveServiceArea, getProgress } = useWorkerApi();

  const data = useWorkerRegistrationStore((state) => state.data);
  const showToast = useToast();
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number }>({ lat: 0, lng: 0 });
  const coordinatesRef = useRef({ lat: 0, lng: 0 });
  const [autoFilled, setAutoFilled] = useState<AutoFilledFields>({ city: '', postalCode: '', neighborhood: '' });
  const autoFilledRef = useRef<AutoFilledFields>({ city: '', postalCode: '', neighborhood: '' });
  const [, setIsLoading] = useState(true);

  const {
    register,
    control,
    reset,
    watch,
    formState: { errors },
    getValues,
  } = useForm<ServiceAddressFormData>({
    resolver: zodResolver(serviceAddressSchema),
    defaultValues: {
      serviceRadius: data.serviceAddress.serviceRadius || 10,
      address: data.serviceAddress.address || '',
      complement: data.serviceAddress.complement || '',
      acceptsRemoteService: data.serviceAddress.acceptsRemoteService || false,
    },
    mode: 'onTouched',
  });

  useEffect(() => {
    const fetchWorkerData = async (): Promise<void> => {
      try {
        setIsLoading(true);
        const workerData = await getProgress();

        if (workerData.serviceAddress) {
          reset({
            address: workerData.serviceAddress || '',
            complement: workerData.serviceAddressComplement || '',
            serviceRadius: workerData.serviceRadiusKm || 10,
            acceptsRemoteService: false,
          });

          // Restore auto-filled fields from backend
          const restored: AutoFilledFields = {
            city: workerData.serviceCity || '',
            postalCode: workerData.servicePostalCode || '',
            neighborhood: workerData.serviceNeighborhood || '',
          };
          setAutoFilled(restored);
          autoFilledRef.current = restored;

          // Restore coordinates from backend
          if (workerData.serviceLat && workerData.serviceLng) {
            const coords = { lat: workerData.serviceLat, lng: workerData.serviceLng };
            setCoordinates(coords);
            coordinatesRef.current = coords;
          }
        }
      } catch (error) {
        console.error('Failed to fetch worker data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWorkerData();
  }, [getProgress, reset]);

  const triggerSave = useAutoSave(
    async () => {
      const formData = getValues();
      await saveServiceArea({
        address: formData.address,
        addressComplement: formData.complement || undefined,
        serviceRadiusKm: formData.serviceRadius,
        lat: coordinatesRef.current.lat,
        lng: coordinatesRef.current.lng,
        city: autoFilledRef.current.city || undefined,
        postalCode: autoFilledRef.current.postalCode || undefined,
        neighborhood: autoFilledRef.current.neighborhood || undefined,
      });
      showToast(t('profile.saveSuccess', 'Información guardada con éxito'), 'success', 'profile-save');
    },
    500,
    (error) => {
      showToast(
        error instanceof Error ? error.message : t('workerRegistration.serviceAddress.saveError'),
        'error',
        'profile-save',
      );
    },
  );

  const handlePlaceSelected = (place: google.maps.places.PlaceResult): void => {
    if (place.geometry?.location) {
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      coordinatesRef.current = { lat, lng };
      setCoordinates({ lat, lng });

      const extracted = extractAddressComponents(place);
      const filled: AutoFilledFields = {
        city: extracted.city ?? '',
        postalCode: extracted.postalCode ?? '',
        neighborhood: extracted.neighborhood ?? '',
      };
      autoFilledRef.current = filled;
      setAutoFilled(filled);

      triggerSave();
    }
  };

  return (
    <form onSubmit={(e) => e.preventDefault()} onBlur={triggerSave} className="flex flex-col gap-6 w-full">
      {/* Address Fields */}
      <div className="flex flex-col md:flex-row gap-4">
        <Controller
          control={control}
          name="address"
          render={({ field }) => (
            <GooglePlacesAutocomplete
              label={t('workerRegistration.serviceAddress.address')}
              containerClassName="w-full md:flex-[2]"
              placeholder={t('workerRegistration.serviceAddress.addressPlaceholder')}
              value={field.value}
              onChange={field.onChange}
              onPlaceSelected={handlePlaceSelected}
              error={errors.address?.message}
              requireSelection={true}
            />
          )}
        />

        <AddressField
          label={t('workerRegistration.serviceAddress.complement')}
          containerClassName="w-full md:flex-1"
          placeholder={t('workerRegistration.serviceAddress.complementPlaceholder')}
          {...register('complement')}
          error={errors.complement?.message}
        />
      </div>

      {/* Auto-filled city and postal code */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex flex-col items-start gap-1 w-full md:flex-1">
          <label className="font-lexend font-semibold text-[#374151] text-[16px] leading-[150%] whitespace-nowrap">
            {t('workerRegistration.serviceAddress.city')}
          </label>
          <div className="relative self-stretch w-full h-12 rounded-[10px] overflow-hidden border-[1.5px] border-solid border-[#D1D5DB] bg-gray-50">
            <input
              type="text"
              readOnly
              disabled
              value={autoFilled.city}
              placeholder="—"
              data-testid="service-city-readonly"
              className="absolute top-0 left-0 w-full h-full px-4 font-lexend font-medium text-[#6B7280] text-[14px] leading-[150%] bg-transparent outline-none placeholder:text-[#9CA3AF] cursor-default"
            />
          </div>
        </div>

        <div className="flex flex-col items-start gap-1 w-full md:flex-1">
          <label className="font-lexend font-semibold text-[#374151] text-[16px] leading-[150%] whitespace-nowrap">
            {t('workerRegistration.serviceAddress.postalCode')}
          </label>
          <div className="relative self-stretch w-full h-12 rounded-[10px] overflow-hidden border-[1.5px] border-solid border-[#D1D5DB] bg-gray-50">
            <input
              type="text"
              readOnly
              disabled
              value={autoFilled.postalCode}
              placeholder="—"
              data-testid="service-postal-code-readonly"
              className="absolute top-0 left-0 w-full h-full px-4 font-lexend font-medium text-[#6B7280] text-[14px] leading-[150%] bg-transparent outline-none placeholder:text-[#9CA3AF] cursor-default"
            />
          </div>
        </div>
      </div>

      {/* Map */}
      <ServiceAreaMap lat={coordinates.lat} lng={coordinates.lng} address={watch('address')} />

      {/* Service Radius with Slider */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Typography variant="body" weight="medium" color="primary">
            {t('workerRegistration.serviceAddress.serviceRadius')}
          </Typography>
          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="serviceRadius"
              render={({ field }) => (
                <>
                  <InputWithIcon
                    id="serviceRadius"
                    type="number"
                    value={field.value}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      const allowed = [5, 10, 20, 50];
                      const nearest = allowed.reduce((prev, curr) =>
                        Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev
                      );
                      field.onChange(nearest);
                    }}
                    onBlur={() => {
                      const allowed = [5, 10, 20, 50];
                      if (!allowed.includes(field.value)) {
                        const nearest = allowed.reduce((prev, curr) =>
                          Math.abs(curr - field.value) < Math.abs(prev - field.value) ? curr : prev
                        );
                        field.onChange(nearest);
                      }
                    }}
                    className="w-20 text-center"
                  />
                  <Typography variant="body" color="secondary">
                    {t('workerRegistration.serviceAddress.km')}
                  </Typography>
                </>
              )}
            />
          </div>
        </div>

        <Controller
          control={control}
          name="serviceRadius"
          render={({ field }) => (
            <DistanceSlider
              value={field.value}
              onChange={(val: number) => { field.onChange(val); triggerSave(); }}
              options={[5, 10, 20, 50]}
            />
          )}
        />
      </div>

      {/* Remote Service Toggle */}
      <div className="flex flex-col gap-4 pt-4">
        <Controller
          control={control}
          name="acceptsRemoteService"
          render={({ field }) => (
            <Checkbox
              id="acceptsRemoteService"
              label={t('workerRegistration.serviceAddress.acceptsRemote')}
              checked={field.value}
              onChange={(e) => { field.onChange(e.target.checked); triggerSave(); }}
            />
          )}
        />
      </div>
    </form>
  );
}
