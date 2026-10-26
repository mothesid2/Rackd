// Shapes returned by the app_get / app_status database functions (see migrations 082 and 085).

export type AppStatus = 'draft' | 'submitted' | 'in_review' | 'needs_info' | 'approved' | 'rejected' | 'activated';

export type LicenseKind = 'tx_ecig' | 'tobacco' | 'sales_tax' | 'tabc';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export type Hours = Record<Day, { open: string; close: string; closed: boolean }>;

export interface LicenseDto {
  kind: LicenseKind;
  number: string | null;
  expiry: string | null;
  document_id: string | null;
}

export interface LocationDto {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  hours: Partial<Hours>;
  licenses: LicenseDto[];
}

export interface OwnerDto {
  id: string;
  full_name: string;
  title: string | null;
  ownership_pct: number;
  is_control_person: boolean;
  id_document_id: string | null;
}

export interface DocumentDto {
  id: string;
  kind: string;
  location_id: string | null;
  owner_id: string | null;
  original_name: string | null;
  mime: string;
  size_bytes: number;
  scan_status: string;
  requested_by_admin: boolean;
  uploaded_at: string;
}

export interface Operations {
  current_pos?: string;
  current_processor?: string;
  monthly_sales_range?: string;
  card_pct?: number | null;
  avg_ticket?: number | null;
  product_mix?: string[];
  registers?: number | null;
  employees?: number | null;
  current_software_cost?: number | null;
  current_processing_cost?: number | null;
}

export interface HardwareSelection {
  mode: 'bundle' | 'own' | 'none';
  bundle_slug?: string;
}

export interface ApplicationDto {
  id: string;
  status: AppStatus;
  full_name: string;
  email: string;
  email_verified_at: string | null;
  phone: string | null;
  contact_role: 'owner' | 'manager' | 'other' | null;
  legal_name: string | null;
  dba: string | null;
  entity_type: 'llc' | 'corporation' | 'sole_proprietor' | 'partnership' | null;
  ein_set: boolean;
  ein_last4: string | null;
  years_in_business: number | null;
  business_email: string | null;
  business_phone: string | null;
  website: string | null;
  mailing_address: { street?: string; city?: string; state?: string; zip?: string } | null;
  location_count: number | null;
  operations: Operations;
  plan_model: 'model_a' | 'model_b' | null;
  addons: string[];
  hardware_selection: HardwareSelection | null;
  compliance_ack_at: string | null;
  current_step: number;
  info_request: string | null;
  submitted_at: string | null;
}

export interface SignatureDto {
  agreement_version_id: string;
  kind: 'terms_of_service' | 'merchant_agreement';
  version: string;
  typed_name: string;
  signed_at: string;
}

export interface Draft {
  application: ApplicationDto;
  locations: LocationDto[];
  owners: OwnerDto[];
  documents: DocumentDto[];
  signatures: SignatureDto[];
  sms_consent: { consented: boolean; text_version: string; created_at: string } | null;
}

export interface StatusDto {
  status: AppStatus;
  full_name: string;
  legal_name: string | null;
  submitted_at: string | null;
  info_request: string | null;
  reject_reason: string | null;
  events: { type: string; at: string; message: string | null }[];
}

export const STEP_TITLES = [
  'Account', 'Business', 'Locations', 'Owners', 'Operations', 'Plan', 'Hardware', 'Agreements', 'Review',
] as const;
