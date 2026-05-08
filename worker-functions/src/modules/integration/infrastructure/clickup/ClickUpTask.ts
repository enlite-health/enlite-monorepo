/**
 * ClickUpTask — shape of a task returned by the ClickUp REST API v2 /task endpoint.
 * Only fields consumed by the importer are declared; extra fields are tolerated at runtime.
 */

export interface ClickUpTaskCustomField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
}

export interface ClickUpTask {
  id: string;
  name: string;
  status: {
    status: string;
    color?: string;
    type?: string;
  };
  parent: string | null;
  custom_fields: ClickUpTaskCustomField[];
  list?: {
    id: string;
    name?: string;
  };
  url: string;
  date_created: string;
  date_updated: string;
}
