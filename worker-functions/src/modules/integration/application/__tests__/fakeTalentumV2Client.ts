/** Cliente Talentum v2 FALSO (só leitura) para os testes da reconciliação — infra de teste, sem dado real. */
import type { TalentumProject } from '../../domain/ITalentumApiClient';
import { buildPublicPrescreeningUrl } from '../../infrastructure/TalentumApiClient';

export interface FakeProject {
  projectId: string;
  title: string;
  publicId?: string;
  slug?: string;
  type?: string;
  /** `getPrescreening` falha com esta mensagem. */
  detailError?: string;
}

const item = (p: FakeProject): TalentumProject => ({
  projectId: p.projectId, publicId: '', title: p.title, description: '', whatsappUrl: '', slug: '',
  active: true, timestamp: '', questions: [], faq: [], status: 'IN_PROGRESS', type: p.type ?? 'FULL', myRole: 'OWNER',
});

export function fakeTalentumV2Client(projects: FakeProject[]) {
  const calls: string[] = [];
  return {
    calls,
    listAllPrescreenings: async () => projects.map(item),
    getPrescreening: async (id: string): Promise<TalentumProject> => {
      calls.push(id);
      const p = projects.find((x) => x.projectId === id)!;
      if (p.detailError) throw new Error(p.detailError);
      return { ...item(p), publicId: p.publicId!, slug: p.slug ?? 'slug', whatsappUrl: buildPublicPrescreeningUrl(p.publicId!) };
    },
  };
}
