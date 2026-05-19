import { JobPostingARRepository } from '../infrastructure/JobPostingARRepository';
import { mapPublicJobRow } from '../infrastructure/PublicJobMapper';
import type { PublicJobDto } from '../domain/PublicJobDto';
import type { PublicJobsFilters } from '../domain/PublicJobsFilters';

export class ListActivePublicJobsUseCase {
  constructor(private readonly repo: JobPostingARRepository) {}

  async execute(filters: PublicJobsFilters): Promise<PublicJobDto[]> {
    const rows = await this.repo.findActivePublic(filters);
    return rows.map(mapPublicJobRow);
  }
}
