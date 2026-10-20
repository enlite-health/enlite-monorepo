import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { Field } from './Field';
import { FormModal } from './FormModal';
import { WORKER_DOCUMENT_TYPES } from '@domain/entities/Worker';
import { validateContactDraft, type ContactDraft } from './contactDraft';

interface Props {
  title: string;
  initial: ContactDraft;
  submitting: boolean;
  /** Frase de erro do envio anterior (já traduzida). */
  error: string | null;
  onSubmit: (draft: ContactDraft) => void;
  onCancel: () => void;
}

const NS = 'admin.insuranceProviders.employees.form';

/** Modal (uma por container) de um empregado da obra social. Serve ao "Novo" e ao "Editar"; fechar alterado pede descarte. */
export function ContactForm({ title, initial, submitting, error, onSubmit, onCancel }: Props): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ContactDraft>(initial);
  const [problem, setProblem] = useState<'required' | 'documentPairIncomplete' | null>(null);
  const set = <K extends keyof ContactDraft>(k: K, v: ContactDraft[K]): void => setDraft((d) => ({ ...d, [k]: v }));

  function submit(): void {
    const found = validateContactDraft(draft);
    setProblem(found);
    if (!found) onSubmit(draft);
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <FormModal title={title} isDirty={isDirty} onClose={onCancel} busy={submitting} testId="contact-form">
      {(requestClose) => (<>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t(`${NS}.fullName`)} required htmlFor="contact-fullName">
          <Input inputSize="compact" id="contact-fullName" value={draft.fullName} onChange={(e) => set('fullName', e.target.value)} data-testid="contact-fullName" />
        </Field>
        <Field label={t(`${NS}.roleTitle`)} required htmlFor="contact-roleTitle">
          <Input inputSize="compact" id="contact-roleTitle" value={draft.roleTitle} onChange={(e) => set('roleTitle', e.target.value)} data-testid="contact-roleTitle" />
        </Field>
        <Field label={t(`${NS}.phone`)} required htmlFor="contact-phone">
          <Input inputSize="compact" id="contact-phone" type="tel" value={draft.phone} onChange={(e) => set('phone', e.target.value)} data-testid="contact-phone" />
        </Field>
        <Field label={t(`${NS}.email`)} htmlFor="contact-email">
          <Input inputSize="compact" id="contact-email" type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} data-testid="contact-email" />
        </Field>
        <Field label={t(`${NS}.documentType`)} htmlFor="contact-documentType">
          <Select
            inputSize="compact"
            id="contact-documentType"
            value={draft.documentType}
            placeholder={t(`${NS}.documentNone`)}
            options={WORKER_DOCUMENT_TYPES.map((d) => ({ value: d, label: t(`admin.patients.detail.documentTypes.${d}`) }))}
            onValueChange={(v) => set('documentType', v as ContactDraft['documentType'])}
            data-testid="contact-documentType"
          />
        </Field>
        <Field label={t(`${NS}.documentNumber`)} htmlFor="contact-documentNumber">
          <Input inputSize="compact" id="contact-documentNumber" value={draft.documentNumber} onChange={(e) => set('documentNumber', e.target.value)} data-testid="contact-documentNumber" />
        </Field>
      </div>
      {problem && (
        <div role="alert" data-testid="contact-problem" className="border border-red-300 bg-red-50 rounded-lg px-3 py-2">
          <Text color="inherit" size="sm" className="text-red-700">{t(`${NS}.${problem}`)}</Text>
        </div>
      )}
      {error && (
        <div role="alert" data-testid="contact-error" className="border border-red-300 bg-red-50 rounded-lg px-3 py-2">
          <Text color="inherit" size="sm" className="text-red-700">{error}</Text>
        </div>
      )}
      <div className="flex items-center gap-3 justify-end">
        <Button variant="outline" size="sm" onClick={requestClose} disabled={submitting} data-testid="contact-cancel">
          {t('admin.insuranceProviders.detail.cancel')}
        </Button>
        <Button variant="primary" size="sm" isLoading={submitting} onClick={submit} data-testid="contact-save">
          {t('admin.insuranceProviders.detail.save')}
        </Button>
      </div>
      </>)}
    </FormModal>
  );
}
