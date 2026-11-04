/**
 * EmployeesCard — cartão "Empregados" (spec 058 §4.2, referência `empregados-tabela.png`): Nome (e-mail embaixo) / Cargo / Telefone /
 * Identificação (tipo + número). Novo, Editar e Retirar (nunca apaga: o contato some da lista, o registro fica).
 *
 * Telefone, e-mail e número do documento são cifrados no back e só saem com `insurance_provider_contacts:read`. Sem a célula (ou 403)
 * o cartão mostra "sem permissão" no lugar da tabela — não uma tabela vazia que pareceria "ninguém cadastrado".
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, UserMinus } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { InsuranceProviderContact } from '@domain/entities/InsuranceProviderDetail';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { ContactForm } from './ContactForm';
import { contactCreateBody, contactPatchBody, contactToDraft, EMPTY_CONTACT_DRAFT, type ContactDraft } from './contactDraft';
import { CardMessage, ProviderCard } from './ProviderCard';
import { isForbidden, useCardLoad } from './useCardLoad';

const NS = 'admin.insuranceProviders';

type FormState = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; contact: InsuranceProviderContact };

export function EmployeesCard({ code }: { code: string }): JSX.Element {
  const { t } = useTranslation();
  const readGate = useActionGate('insurance_provider_contacts', 'read');
  const updateGate = useActionGate('insurance_provider_contacts', 'update');
  const { data, error, loading, reload } = useCardLoad(() => AdminInsuranceApiService.listContacts(code), readGate.allowed, [code]);
  const [form, setForm] = useState<FormState>({ mode: 'closed' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const noRead = readGate.denied || isForbidden(error);
  const contacts = data ?? [];

  async function submit(draft: ContactDraft): Promise<void> {
    try {
      setSubmitting(true);
      setFormError(null);
      if (form.mode === 'edit') {
        const body = contactPatchBody(form.contact, draft);
        if (Object.keys(body).length > 0) await AdminInsuranceApiService.patchContact(code, form.contact.id, body);
      } else {
        await AdminInsuranceApiService.createContact(code, contactCreateBody(draft));
      }
      setForm({ mode: 'closed' });
      reload();
    } catch (err: unknown) {
      setFormError(insuranceErrorText(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  async function retire(contact: InsuranceProviderContact): Promise<void> {
    if (!window.confirm(t(`${NS}.employees.retireConfirm`, { name: contact.fullName }))) return;
    try {
      setRowError(null);
      await AdminInsuranceApiService.retireContact(code, contact.id);
      reload();
    } catch (err: unknown) {
      setRowError(insuranceErrorText(t, err));
    }
  }

  const actions = noRead ? null : (
    <ActionButton resource="insurance_provider_contacts" action="create" variant="outline" size="sm" onClick={() => { setFormError(null); setForm({ mode: 'new' }); }} className="flex items-center gap-1" data-testid="employees-new">
      {t(`${NS}.detail.new`)}
      <Plus className="w-4 h-4" />
    </ActionButton>
  );

  return (
    <ProviderCard id="provider-employees-card" title={t(`${NS}.employees.title`)} actions={actions}>
      {noRead ? (
        <CardMessage testId="employees-no-permission">{t(`${NS}.employees.noPermission`)}</CardMessage>
      ) : (
        <>
          {form.mode !== 'closed' && (
            <ContactForm
              key={form.mode === 'edit' ? form.contact.id : 'new'}
              title={form.mode === 'edit' ? t(`${NS}.employees.form.editTitle`) : t(`${NS}.employees.form.newTitle`)}
              initial={form.mode === 'edit' ? contactToDraft(form.contact) : EMPTY_CONTACT_DRAFT}
              submitting={submitting}
              error={formError}
              onSubmit={submit}
              onCancel={() => setForm({ mode: 'closed' })}
            />
          )}
          {rowError && (
            <div role="alert" data-testid="employees-row-error" className="border border-red-300 bg-red-50 rounded-lg px-3 py-2">
              <Text color="inherit" size="sm" className="text-red-700">{rowError}</Text>
            </div>
          )}
          {loading ? (
            <TableSkeleton />
          ) : error ? (
            <CardMessage testId="employees-load-error" tone="error">{insuranceErrorText(t, error)}</CardMessage>
          ) : contacts.length === 0 ? (
            <CardMessage testId="employees-empty">{t(`${NS}.employees.empty`)}</CardMessage>
          ) : (
            <div className="overflow-x-auto" data-testid="employees-table">
              <Table>
                <TableHeader>
                  <TableHead>{t(`${NS}.employees.columns.name`)}</TableHead>
                  <TableHead>{t(`${NS}.employees.columns.role`)}</TableHead>
                  <TableHead>{t(`${NS}.employees.columns.phone`)}</TableHead>
                  <TableHead>{t(`${NS}.employees.columns.identification`)}</TableHead>
                  <TableHead align="right">{t(`${NS}.employees.columns.actions`)}</TableHead>
                </TableHeader>
                <TableBody>
                  {contacts.map((c) => (
                    <TableRow key={c.id} clickable={false} data-testid={`employee-row-${c.id}`}>
                      <TableCell unwrapped>
                        <div className="flex flex-col">
                          <Text color="tertiary" as="span" size="sm" weight="medium" data-testid={`employee-name-${c.id}`}>{c.fullName}</Text>
                          <Text as="span" size="xs" color="inherit" className="text-slate-600" data-testid={`employee-email-${c.id}`}>{c.redacted ? t(`${NS}.detail.redacted`) : c.email ?? ''}</Text>
                        </div>
                      </TableCell>
                      <TableCell unwrapped><Text color="tertiary" as="span" size="sm" data-testid={`employee-role-${c.id}`}>{c.roleTitle}</Text></TableCell>
                      <TableCell unwrapped><Text color="tertiary" as="span" size="sm" data-testid={`employee-phone-${c.id}`}>{c.redacted ? t(`${NS}.detail.redacted`) : c.phone ?? '—'}</Text></TableCell>
                      <TableCell unwrapped>
                        <div className="flex flex-col" data-testid={`employee-document-${c.id}`}>
                          {c.document ? (
                            <>
                              <Text color="tertiary" as="span" size="sm">{t(`admin.patients.detail.documentTypes.${c.document.type}`)}</Text>
                              <Text as="span" size="xs" color="inherit" className="text-slate-600">{c.redacted ? t(`${NS}.detail.redacted`) : c.document.number ?? ''}</Text>
                            </>
                          ) : (
                            <Text as="span" size="sm" color="inherit" className="text-slate-600">—</Text>
                          )}
                        </div>
                      </TableCell>
                      <TableCell align="right" unwrapped>
                        {!updateGate.denied && !c.redacted && (
                          <div className="flex items-center justify-end gap-2">
                            <button type="button" onClick={() => { setFormError(null); setForm({ mode: 'edit', contact: c }); }} className="p-1.5 rounded hover:bg-slate-100 text-slate-700 hover:text-primary cursor-pointer" aria-label={t(`${NS}.detail.edit`)} data-testid={`employee-edit-${c.id}`}>
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => retire(c)} className="p-1.5 rounded hover:bg-red-50 text-slate-700 hover:text-red-700 cursor-pointer" aria-label={t(`${NS}.employees.retire`)} data-testid={`employee-retire-${c.id}`}>
                              <UserMinus className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </ProviderCard>
  );
}
