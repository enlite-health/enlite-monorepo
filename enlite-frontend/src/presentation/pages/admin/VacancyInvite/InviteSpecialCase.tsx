import { useTranslation } from 'react-i18next';
import { MapPinOff, Pencil } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface NoServiceProps {
  /** endereço cru da vacante (`formatted` ‖ `raw`); `null` → "—". */
  address: string | null;
  /** destino de "Corregir la dirección del servicio" (DF-12); `null` esconde o botão. */
  fixHref: string | null;
  onBack: () => void;
  onFix: (href: string) => void;
}

/** F6 esquerda (E7): serviço sem coordenada — sem mapa, sem lista, sem POST (DF-11). */
export function InviteNoServiceCase({ address, fixHref, onBack, onFix }: NoServiceProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="invite-special-case" data-kind="no-service" className="flex flex-1 flex-col items-center justify-center gap-4 px-14 py-10 text-center">
      <span aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FFF4D6] text-[#7A4E00]">
        <MapPinOff size={28} />
      </span>
      <Heading level={3} as="h2" weight="semibold" color="primary" className="!text-[22px] !leading-[30px]">{t('admin.vacancyInvite.noService.title')}</Heading>
      <Text size="sm" color="inherit" className="max-w-[460px] text-primary/70 !leading-[22px]">{t('admin.vacancyInvite.noService.text')}</Text>
      <div className="flex w-full max-w-[460px] flex-col gap-1 rounded-2xl bg-gray-200 px-4 py-3.5 text-left" data-testid="invite-no-service-address">
        <Text as="span" size="2xs" color="inherit" className="uppercase tracking-[.04em] text-primary/70">{t('admin.vacancyInvite.noService.addressLabel')}</Text>
        <Text as="span" size="sm" weight="medium" color="primary">{address ?? '—'}</Text>
      </div>
      <div className="mt-2 flex gap-3">
        <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-special-back" onClick={onBack}>{t('admin.vacancyInvite.back')}</Button>
        {fixHref && (
          <Button variant="primary" size="dense" shape="rounded" data-testid="invite-special-fix" className="gap-2" onClick={() => onFix(fixHref)}>
            <Pencil size={16} aria-hidden="true" />
            {t('admin.vacancyInvite.noService.fix')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface NobodyProps {
  /** "Femenino · Cuidador/a" (sexo · profissão da vacante). */
  profile: string;
  /** pessoas em "Ya en la vacante" (⚑3): some com 0. */
  vacanteCount: number;
  onSeeVacante: () => void;
  onBack: () => void;
}

/** F6 direita (E8): ninguém até 50 km — cartão sobre o mapa com os 4 anéis. */
export function InviteNobodyCard({ profile, vacanteCount, onSeeVacante, onBack }: NobodyProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="invite-special-case"
      data-kind="nobody"
      className="absolute bottom-8 left-1/2 flex w-[520px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col items-center gap-3 rounded-[20px] bg-white px-7 py-6 text-center shadow-[0_12px_32px_rgba(0,0,0,.14)]"
    >
      <Heading level={3} as="h2" weight="semibold" color="primary" className="!text-xl !leading-7">{t('admin.vacancyInvite.nobody.title')}</Heading>
      <Text size="sm" color="inherit" className="text-primary/70 !leading-[22px]">{t('admin.vacancyInvite.nobody.text', { profile })}</Text>
      {vacanteCount > 0 && (
        <div className="flex flex-col items-center gap-2" data-testid="invite-nobody-vacante">
          <Text size="sm" color="primary" className="!text-[13px] !leading-5">{t('admin.vacancyInvite.nobody.vacante', { count: vacanteCount })}</Text>
          <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-nobody-see" className="gap-2" onClick={onSeeVacante}>
            <MapPinOff size={16} aria-hidden="true" />
            {t('admin.vacancyInvite.nobody.seeVacante', { count: vacanteCount })}
          </Button>
        </div>
      )}
      <Button variant="primary" size="dense" shape="rounded" data-testid="invite-special-back" onClick={onBack}>{t('admin.vacancyInvite.back')}</Button>
    </div>
  );
}
