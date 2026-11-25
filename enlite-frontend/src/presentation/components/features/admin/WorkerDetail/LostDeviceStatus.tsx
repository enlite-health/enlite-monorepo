import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { OperatorRevocation } from '@domain/entities/WorkerDevice';
import { formatDateTime } from '@presentation/components/features/admin/VacancyDetail/draftVacancyFormat';

interface LostDeviceStatusProps {
  revocation: OperatorRevocation;
}

/**
 * Linha de status do "Celular perdido" (spec 077, D795, T-F3c-DB-14). Mostra o que o SERVIDOR guardou — nada derivado
 * aqui (sem relógio, sem "pendente há X"): `wipedAt` preenchido → o app informou que apagou; `wipedAt` null → o servidor
 * ainda não ouviu o aparelho, o que NÃO quer dizer que não apagou (a tela diz isso). Quem pediu vem como nome.
 */
export function LostDeviceStatus({ revocation }: LostDeviceStatusProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tl = (k: string, o?: Record<string, string>) => t(`admin.workerDetail.lostDevice.${k}`, o);
  const requestedAt = formatDateTime(revocation.revokedAt, i18n.language) ?? '—';
  const name = revocation.requestedByName ?? tl('unknownRequester');

  return (
    <div className="flex flex-col gap-1" data-testid="lost-device-status">
      <Text size="sm" color="secondary" data-testid="lost-device-requested">
        {tl('requested', { date: requestedAt, name })}
      </Text>
      {revocation.wipedAt !== null ? (
        <div data-testid="lost-device-wiped">
          <Text size="sm" weight="medium" color="secondary">
            {tl('wiped', { date: formatDateTime(revocation.wipedAt, i18n.language) ?? '—' })}
          </Text>
          <Text size="xs" color="muted">{tl('wipedSource')}</Text>
        </div>
      ) : (
        <Text size="sm" color="muted" data-testid="lost-device-pending">
          {tl('pending')}
        </Text>
      )}
    </div>
  );
}
