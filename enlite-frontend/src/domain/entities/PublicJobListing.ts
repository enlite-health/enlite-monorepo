export interface PublicJobListing {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  description: string;
  schedule_days_hours: string | null;
  worker_profile_sought: string | null;
  service: string | null;
  pathologies: string | null;
  state: string | null;
  city: string | null;
  detail_link: string;
  worker_type: string[] | null;
  worker_sex: string | null;
  job_zone: string | null;
  neighborhood: string | null;
  state_city: string | null;
  location_label: string | null;
  country: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  whatsapp_url: string | null;
}

export interface PublicJobListingResponse {
  success: true;
  data: PublicJobListing[];
}
