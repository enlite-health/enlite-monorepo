import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tag, Edit2, Trash2, Plus } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate, useContainerAccess } from '@presentation/hooks/useCellAccess';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { TagFormModal } from './TagCatalogPage/TagFormModal';
import { TagDeleteModal } from './TagCatalogPage/TagDeleteModal';

/** Calcula luminância relativa para decidir cor de texto (claro/escuro). */
function getTextColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}

export default function TagCatalogPage() {
  // Spec 024 (D1/D401, 21/09): catálogo de Etiquetas é DADO diferente do perfil de prestador —
  // célula própria `tag:*`. Editar e excluir viram gates DISTINTOS (antes compartilhavam
  // `useActionGate('worker','update')`): GET→tag:read, POST→tag:create, PATCH→tag:update,
  // DELETE→tag:delete.
  const tagUpdateGate = useActionGate('tag', 'update');
  const tagDeleteGate = useActionGate('tag', 'delete');
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Trava de rota pela CÉLULA da leitura que a tela faz (GET /worker-tags → tag:read), não por
  // papel. `useContainerAccess` só nega com o engine ligado — com ele desligado a tela abre como
  // sempre abriu (D268/D286).
  const { visible } = useContainerAccess('tag');
  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);

  const [tags, setTags] = useState<WorkerTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formModal, setFormModal] = useState<{ open: boolean; tag: WorkerTag | null }>({ open: false, tag: null });
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; tag: WorkerTag | null }>({ open: false, tag: null });

  const fetchTags = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await AdminApiService.listWorkerTags();
      setTags(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg || t('admin.tags.loadError'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  function handleNewTag() {
    setFormModal({ open: true, tag: null });
  }

  function handleEditTag(tag: WorkerTag) {
    setFormModal({ open: true, tag });
  }

  function handleDeleteTag(tag: WorkerTag) {
    setDeleteModal({ open: true, tag });
  }

  async function handleFormSave(data: { name: string; color: string; description?: string }) {
    if (formModal.tag) {
      await AdminApiService.updateWorkerTag(formModal.tag.id, data);
    } else {
      await AdminApiService.createWorkerTag(data);
    }
    setFormModal({ open: false, tag: null });
    fetchTags();
  }

  async function handleDeleteConfirm() {
    if (!deleteModal.tag) return;
    await AdminApiService.deleteWorkerTag(deleteModal.tag.id);
    setDeleteModal({ open: false, tag: null });
    fetchTags();
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <Tag className="w-6 h-6 text-primary" />
          <Heading level={1} weight="semibold" color="primary">
            {t('admin.tags.title')}
          </Heading>
        </div>
        <ActionButton resource="tag" action="create" variant="primary" size="md" onClick={handleNewTag}>
          <Plus className="w-4 h-4" />
          {t('admin.tags.newTag')}
        </ActionButton>
      </div>

      {/* Content */}
      {loadError ? (
        <div className="py-12 text-center">
          <Text color="inherit" className="text-red-600">{loadError}</Text>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : tags.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Text size="sm" color="muted">{t('admin.tags.noTags')}</Text>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <Table>
            <TableHeader>
              <TableHead>{t('admin.tags.table.name')}</TableHead>
              <TableHead>{t('admin.tags.table.color')}</TableHead>
              <TableHead>{t('admin.tags.table.description')}</TableHead>
              <TableHead align="right">{t('admin.tags.table.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {tags.map((tag) => {
                const textColor = getTextColor(tag.color);
                return (
                  <TableRow key={tag.id} clickable={false}>
                    <TableCell unwrapped>
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium"
                        style={{ backgroundColor: tag.color, color: textColor }}
                      >
                        {tag.name}
                      </span>
                    </TableCell>
                    <TableCell unwrapped>
                      <div className="flex items-center gap-2">
                        <span
                          className="w-5 h-5 rounded border border-gray-200 shrink-0"
                          style={{ backgroundColor: tag.color }}
                        />
                        <Text as="span" size="sm" color="muted">{tag.color}</Text>
                      </div>
                    </TableCell>
                    <TableCell>{tag.description ?? '—'}</TableCell>
                    <TableCell align="right" unwrapped>
                      {(!tagUpdateGate.denied || !tagDeleteGate.denied) && (
                      <div className="flex items-center justify-end gap-2">
                        {!tagUpdateGate.denied && (
                        <button
                          type="button"
                          onClick={() => handleEditTag(tag)}
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-primary transition-colors cursor-pointer"
                          aria-label={t('admin.tags.editTag')}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        )}
                        {!tagDeleteGate.denied && (
                        <button
                          type="button"
                          onClick={() => handleDeleteTag(tag)}
                          className="p-1.5 rounded hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors cursor-pointer"
                          aria-label={t('admin.tags.deleteTag')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        )}
                      </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {formModal.open && (
        <TagFormModal
          tag={formModal.tag}
          onSave={handleFormSave}
          onClose={() => setFormModal({ open: false, tag: null })}
        />
      )}

      {deleteModal.open && deleteModal.tag && (
        <TagDeleteModal
          tag={deleteModal.tag}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteModal({ open: false, tag: null })}
        />
      )}
    </PageContainer>
  );
}
