import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { DRAFT_TODO_FIELDS, type DraftVacancyLike } from './draftVacancyFields';

/**
 * "Lo que falta" (protótipo v3, F24) — extraído de `DraftVacancyPage.tsx` (gate parcial 25/09,
 * achado #10). Círculos vazios, sem cor de alerta (fase-2.md) — o verde é só CONCLUÍDO, nunca
 * FALTA (que fica no `gray-600`).
 */
export function DraftVacancyTodoCard({ vacancy, missing }: { vacancy: DraftVacancyLike; missing: number }) {
  const { t } = useTranslation();

  return (
    <section className="bg-white rounded-2xl border-2 border-gray-600 p-6 sm:p-7">
      <Heading level={2} weight="semibold" color="primary" className="mb-5">
        {t('admin.draftVacancy.todoTitle')}{' '}
        <Text as="span" size="sm" color="tertiary" weight="normal">
          {t('admin.draftVacancy.todoCount', { count: missing })}
        </Text>
      </Heading>
      <ul className="flex flex-col">
        {DRAFT_TODO_FIELDS.map((field) => {
          const done = !field.isEmpty(vacancy);
          return (
            <li key={field.key} className="flex items-center gap-3 py-2.5 border-b border-gray-600 last:border-b-0">
              <span
                className={
                  done
                    ? 'w-[18px] h-[18px] rounded-full bg-green-600 flex items-center justify-center shrink-0'
                    : 'w-[18px] h-[18px] rounded-full border-2 border-gray-600 shrink-0'
                }
              >
                {done && <Check className="w-[11px] h-[11px] text-white" aria-hidden="true" />}
              </span>
              <Text as="span" size="sm" color={done ? 'muted' : 'secondary'}>
                {t(`admin.draftVacancy.todo.${field.labelKey}`)}
              </Text>
              {field.asideKey && (
                <Text as="span" size="xs" color="tertiary" className="ml-auto">
                  {t(`admin.draftVacancy.todo.${field.asideKey}`)}
                </Text>
              )}
            </li>
          );
        })}
      </ul>
      <Text size="xs" color="muted" className="mt-5 pt-4 border-t border-gray-600">
        {t('admin.draftVacancy.todoThen')}
      </Text>
    </section>
  );
}
