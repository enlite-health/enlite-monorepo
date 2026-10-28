/**
 * EnquadresListRow — uma linha da lista global de enquadres (spec 076). Hora no fuso do PAÍS DO EVENTO (o mesmo cálculo da
 * linha da aba da vaga). Sem nome de paciente nem de convocado: só código, caso, entrevistador e contagens (FR-21). A linha
 * leva à aba Enquadre da vaga com o evento aberto (`?tab=enquadre&event=`): clique, Enter ou o link da data (abre em nova aba).
 */
import type { JSX, KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { TableCell, TableRow } from '@presentation/components/atoms/Table';
import type { EnquadreGlobalListItem } from '@domain/entities/EnquadreEvent';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import { SealChip } from '../PatientDetail/admission/AdmissionSeals';
import { timeZoneForCountry } from '../PatientDetail/admission/admissionTime';
import { dateAndTime } from '../VacancyDetail/Enquadre/enquadreEventTime';
import { ENQUADRE_PHASE_KEY, ENQUADRE_PHASE_TONE } from '../VacancyDetail/Enquadre/enquadreEventPhase';

const enquadreDeepLink = (e: Pick<EnquadreGlobalListItem, 'jobPostingId' | 'id'>): string =>
  `/admin/vacancies/${encodeURIComponent(e.jobPostingId)}?tab=enquadre&event=${encodeURIComponent(e.id)}`;

export function EnquadresListRow({ event: e }: { event: EnquadreGlobalListItem }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const href = enquadreDeepLink(e);
  const [date, time] = dateAndTime(e.startsAt, timeZoneForCountry(e.country));
  const open = (): void => navigate(href);
  const onKeyDown = (ev: KeyboardEvent<HTMLTableRowElement>): void => {
    if (ev.key === 'Enter' && ev.target === ev.currentTarget) open();
  };
  const reason = e.importBlocked?.reason;
  const blockedText = reason
    ? t('admin.enquadres.importBlocked', { reason: t(`admin.vacancyDetail.enquadre.seals.blockedReasons.${reason}`, { defaultValue: reason }) })
    : '';

  return (
    <TableRow data-testid="enquadres-row" data-event-id={e.id} data-phase={e.phase} tabIndex={0} onClick={open} onKeyDown={onKeyDown}>
      <TableCell unwrapped className="whitespace-nowrap">
        <Link to={href} onClick={(ev) => ev.stopPropagation()} className="text-primary underline" data-testid="enquadres-row-link">
          <Text as="span" size="sm" weight="medium" color="inherit">{`${date} ${time}`}</Text>
        </Link>
      </TableCell>
      <TableCell unwrapped className="max-w-[260px]" data-clarity-mask="True" data-testid="enquadres-row-host">
        <span title={e.hostName} className="block truncate">
          <Text as="span" size="sm" color="inherit">{e.hostName}</Text>
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap" data-testid="enquadres-row-case">{`${formatVacancyCase(e.caseNumber, e.caseOrdinal)} · ${e.eventCode}`}</TableCell>
      <TableCell data-testid="enquadres-row-convoked">{e.convokedCount}</TableCell>
      <TableCell unwrapped className="whitespace-nowrap">
        <SealChip tone={ENQUADRE_PHASE_TONE[e.phase]} testId="enquadres-row-phase">
          {t(`admin.vacancyDetail.enquadre.${ENQUADRE_PHASE_KEY[e.phase]}`)}
        </SealChip>
      </TableCell>
      <TableCell unwrapped className="w-full max-w-0">
        {reason && (
          <span data-testid="enquadres-import-blocked" data-reason={reason} title={blockedText} className="block truncate">
            <Text as="span" size="xs" weight="medium" color="inherit" className="text-amber-700">{blockedText}</Text>
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
