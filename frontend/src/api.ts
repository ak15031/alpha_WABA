/**
 * API client — thin fetch wrapper + typed response shapes + endpoint functions.
 *
 * Every call takes the current Supabase JWT and (when tenant-scoped) an
 * activeTenantId. Nothing else in the app talks to the backend directly.
 */

const API_URL: string = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

export class ApiError extends Error {
  public body?: unknown;

  constructor(public status: number, public detail: string, body?: unknown) {
    super(detail);
    this.body = body;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token: string;
  tenantId?: string | null;
}

async function apiFetch(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
  };
  if (opts.tenantId) headers["X-Tenant-Id"] = opts.tenantId;

  return fetch(`${API_URL}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function request<T>(path: string, opts: RequestOptions): Promise<T> {
  const res = await apiFetch(path, opts);

  if (!res.ok) {
    let detail = res.statusText || "Request failed";
    try {
      const body = await res.json();
      detail = body.detail || detail;
      // Attach body to Error for richer UI reporting
      const err: any = new ApiError(res.status, detail);
      err.body = body;
      throw err;
    } catch {
      /* ignore body parse errors */
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function qs<T extends object>(params?: T): string {
  if (!params) return "";
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  }
  const q = s.toString();
  return q ? `?${q}` : "";
}

// ─── Types (mirror the backend response shapes exactly) ──────────────────────

export interface Membership {
  tenant_id: string;
  tenant_name: string;
  role: string;
}

export interface Me {
  id: string;
  email: string;
  full_name: string | null;
  is_platform_admin: boolean;
  memberships: Membership[];
}

export interface Branch {
  id: string;
  name: string;
  branch_type: "physical" | "virtual" | string;
  status?: "active" | "archived";
}

export interface PhoneNumberIn {
  display_phone_number: string;
  meta_phone_number_id: string;
  is_test_number?: boolean;
}

export interface BranchIn {
  name: string;
  branch_type?: "physical" | "virtual";
}

export interface TenantCreatePayload {
  tenant_name: string;
  admin_email: string;
  admin_role?: "tenant_admin";
  meta_waba_id: string;
  business_name: string;
  waba_access_token?: string | null;
  phone_numbers: PhoneNumberIn[];
  branches?: BranchIn[];
}

export interface TenantCreateResponse {
  tenant_id: string;
  tenant_slug: string;
  waba_id: string;
  phone_number_ids: string[];
  branch_ids: string[];
  admin_user_id: string;
  admin_email: string;
  invite_status: string;
}

export interface BranchFull extends Branch {
  status: "active" | "archived";
}

export interface KpiCard {
  value: number;
  trend_pct: number;
  sparkline: number[];
}

export interface DashboardKpis {
  period: { start: string; end: string };
  kpis: {
    total_sent: KpiCard;
    delivered_rate: KpiCard;
    read_rate: KpiCard;
    active_contacts: KpiCard;
  };
}

export interface ActivityPoint {
  date: string;
  sent: number;
  delivered: number;
}

export interface CampaignStatusCounts {
  counts: Record<string, number>;
}

export interface LatestBroadcast {
  id: string;
  name: string;
  branch_name: string;
  status: string;
  recipient_count: number;
  sent_at: string | null;
}

export interface DashboardFilters {
  branch_id?: string;
  start_date?: string;
  end_date?: string;
}

export interface ContactRow {
  id: string;
  phone_e164: string;
  full_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
  opt_in_status: "opted_in" | "opted_out" | "pending" | string;
  source: string;
  created_at: string;
}

export type Contact = ContactRow;

export interface ContactUpdatePayload {
  full_name?: string | null;
  opt_in_status?: "opted_in" | "opted_out" | "pending";
  custom_fields?: Record<string, unknown>;
}

export interface ContactsListResponse {
  data: Contact[];
  pagination: { page: number; page_size: number; total: number };
}

export interface ContactsListParams {
  search?: string;
  branch_id?: string;
  segment?: string;
  page?: number;
  page_size?: number;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  campaign_id: string;
  campaign_name: string;
  phone_e164: string;
  meta_message_id: string | null;
  branch_name: string;
  status: string;
  queued_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  latency_ms: number | null;
  error_code: number | null;
  error_message: string | null;
}

export interface MessagesListResponse {
  data: MessageRow[];
  pagination: { page: number; page_size: number; total: number };
}

export interface MessagesKpisResponse {
  total_sent: number | null;
  total_delivered: number | null;
  total_read: number | null;
  total_failed: number | null;
}

export interface UploadPreviewRow {
  row: number;
  phone_e164: string;
  full_name?: string | null;
  segment?: string | null;
  branch?: string | null;
}

export interface UploadError {
  row: number;
  phone_raw?: string | null;
  reason: string;
}

export interface UploadResponse {
  upload_id: string | null;
  total_rows: number;
  valid: number;
  invalid: number;
  skipped_empty: number;
  preview_rows: UploadPreviewRow[];
  errors: UploadError[];
  committed: boolean;
}
// ─── Groups ──────────────────────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface GroupsListResponse {
  data: GroupRow[];
}

export interface GroupUploadError {
  row: number;
  phone_raw?: string | null;
  reason: string;
}

export interface GroupUploadResponse {
  group_id: string;
  total_rows: number;
  matched: number;
  created: number;
  reactivated: number;
  already_member: number;
  errors: GroupUploadError[];
  committed: boolean;
}
// ─── Templates ──────────────────────────────────────────────────────────────

export interface TemplateVariableDef {
  index: number;
  description?: string;
  example?: string;
}

export interface TemplateRow {
  id: string;
  waba_id: string;
  name: string;
  language_code: string;
  category: string;
  status: string;
  body_text: string;
  variable_definitions: TemplateVariableDef[];
}

export interface TemplatesListResponse {
  data: TemplateRow[];
}

// ─── Phone numbers ─────────────────────────────────────────────────────────

export interface PhoneNumberRow {
  id: string;
  display_phone_number: string;
  meta_phone_number_id: string;
  is_test_number: boolean;
  status: string;
  waba_id: string;
  waba_business_name: string;
}

export interface PhoneNumbersListResponse {
  data: PhoneNumberRow[];
}

// ─── Broadcasts (aligned with backend broadcasts.py) ────────────────────────

export type BroadcastStatus =
  | "draft" | "scheduled" | "queued" | "running"
  | "completed" | "failed" | "canceled";

export type AudienceMode =
  | "all_contacts" | "branch_group" | "csv_upload" | "group" | "combined";

export interface InlineContact {
  phone_e164: string;
  full_name: string | null;
}

export interface CombinedAudienceConfig {
  branch_ids?: string[];
  group_ids?: string[];
  inline_contacts?: InlineContact[];
}

export type VarMode = 'static' | 'contact' | 'tenant';

export interface VarRow {
  mode: VarMode;
  value: string;
  fallback: string;
}

export const CONTACT_FIELDS = [
  { key: 'full_name', label: 'Name' },
  { key: 'phone_e164', label: 'Phone' },
  { key: 'external_id', label: 'External ID' },
  { key: 'email', label: 'Email' },
];

export const TENANT_FIELDS = [
  { key: 'name', label: 'Tenant name' },
];

export function varRowToMapping(row: VarRow): string | object {
  if (row.mode === 'static') return `$literal:${row.value}`;
  if (row.mode === 'contact') {
    return { source: `contact.${row.value || 'full_name'}`, fallback: row.fallback || 'Receiver' };
  }
  if (row.mode === 'tenant') {
    return { source: `tenant.${row.value || 'name'}`, fallback: row.fallback || '' };
  }
  return `$literal:`;
}

export function emptyVarRow(): VarRow {
  return { mode: 'static', value: '', fallback: '' };
}

export interface BroadcastListRow {
  id: string;
  name: string;
  branch_name: string;
  template_name: string;
  status: BroadcastStatus;
  recipient_count: number;
  scheduled_for: string | null;
  created_at: string;
}

export interface BroadcastsListResponse {
  data: BroadcastListRow[];
  pagination: { page: number; page_size: number; total: number };
}

export interface BroadcastCreatePayload {
  name: string;
  branch_id: string | null;
  phone_number_id: string;
  template_id: string;
  variable_mappings: Record<string, any>;
  audience_type: AudienceMode;
  audience_config: Record<string, any>;
  lane?: "transactional" | "bulk";
  schedule?: "immediate" | "scheduled";
  scheduled_for?: string | null;
}

export interface BroadcastDetail {
  id: string;
  name: string;
  status: BroadcastStatus;
  branch: { id: string; name: string };
  template: { id: string; name: string; language_code?: string };
  phone: { id: string; display_phone_number: string };
  audience_type: string;
  audience_config: Record<string, unknown>;
  variable_mappings: Record<string, string>;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
  stats: {
    total_recipients: number;
    total_sent: number;
    total_delivered: number;
    total_read: number;
    total_failed: number;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
  };
}

export interface TemplateSyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
}

export interface UserRow {
  id: string;
  user_id: string;
  email: string;
  role: 'tenant_admin' | 'tenant_user';
  status: 'active' | 'invited' | 'suspended';
  invited_at: string | null;
  accepted_at: string | null;
}

export async function listUsers(token: string, tenantId: string): Promise<UserRow[]> {
  const res = await apiFetch('/users', { token, tenantId });
  if (!res.ok) throw new ApiError(res.status, 'Failed to load users');
  return res.json();
}

export async function inviteUser(
  token: string,
  tenantId: string,
  email: string,
  role: 'tenant_admin' | 'tenant_user',
) {
  const res = await apiFetch('/users/invite', {
    method: 'POST',
    token,
    tenantId,
    body: { email, role },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const b = body as { error_message?: string; detail?: string };
    throw new ApiError(res.status, b.error_message || b.detail || 'Invite failed', body);
  }
  return res.json();
}

export async function updateUserRole(
  token: string,
  tenantId: string,
  membershipId: string,
  role: 'tenant_admin' | 'tenant_user',
) {
  const res = await apiFetch(`/users/${membershipId}/role`, {
    method: 'PATCH',
    token,
    tenantId,
    body: { role },
  });
  if (!res.ok) throw new ApiError(res.status, 'Failed to update role');
  return res.json();
}

export async function removeUser(token: string, tenantId: string, membershipId: string) {
  const res = await apiFetch(`/users/${membershipId}`, {
    method: 'DELETE',
    token,
    tenantId,
  });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status, 'Failed to remove user');
}

export async function syncTemplatesFromMeta(token: string, tenantId: string): Promise<TemplateSyncSummary> {
  const res = await apiFetch('/templates/sync', {
    method: 'POST',
    token,
    tenantId,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error_message?: string; detail?: string }).error_message || (body as { detail?: string }).detail || 'Sync failed');
  }

  return res.json();
}

export async function createTenant(
  token: string,
  payload: TenantCreatePayload,
): Promise<TenantCreateResponse> {
  const res = await apiFetch('/platform/tenants', {
    method: 'POST',
    token,
    body: payload,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const bb = b as { error_message?: string; detail?: string };
    throw new ApiError(res.status, bb.error_message || bb.detail || 'Create tenant failed', b);
  }
  return res.json();
}

export async function createBranch(
  token: string,
  tenantId: string,
  payload: { name: string; branch_type?: 'physical' | 'virtual' },
): Promise<BranchFull> {
  const res = await apiFetch('/branches', { method: 'POST', token, tenantId, body: payload });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (b as any).detail || 'Create branch failed');
  }
  return res.json();
}

export async function deleteBranch(
  token: string,
  tenantId: string,
  branchId: string,
): Promise<void> {
  const res = await apiFetch(`/branches/${branchId}`, { method: 'DELETE', token, tenantId });
  if (!res.ok && res.status !== 204) {
    const b = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (b as any).detail || 'Delete branch failed');
  }
}

export async function deleteGroup(
  token: string,
  tenantId: string,
  groupId: string,
): Promise<void> {
  const res = await apiFetch(`/groups/${groupId}`, {
    method: "DELETE",
    token,
    tenantId,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail || "Delete group failed";
    throw new ApiError(res.status, detail);
  }
}

export async function deleteBroadcast(
  token: string,
  tenantId: string,
  broadcastId: string,
): Promise<void> {
  const res = await apiFetch(`/broadcasts/${broadcastId}`, {
    method: "DELETE",
    token,
    tenantId,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail || "Delete broadcast failed";
    throw new ApiError(res.status, detail);
  }
}

export function parsePastedContacts(text: string): InlineContact[] {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const out: InlineContact[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const parts = line.split(/[,\t;|]/).map((p) => p.trim()).filter(Boolean);
    let phone = "";
    let name: string | null = null;

    if (parts.length === 1) {
      phone = normalizePhone(parts[0]);
    } else if (parts.length >= 2) {
      const [a, b] = parts;
      if (countDigits(a) >= countDigits(b)) {
        phone = normalizePhone(a);
        name = b || null;
      } else {
        phone = normalizePhone(b);
        name = a || null;
      }
    }

    if (!phone || countDigits(phone) < 7) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone_e164: phone, full_name: name });
  }

  return out;
}

function normalizePhone(s: string): string {
  const trimmed = s.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return "+" + digits;
  if (digits.startsWith("0")) return "+92" + digits.slice(1);
  if (digits.startsWith("92")) return "+" + digits;
  return "+" + digits;
}

function countDigits(s: string): number {
  return (s.match(/\d/g) || []).length;
}

export interface SendResponse {
  status: string;
  campaign_id: string;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export const api = {
  me: (token: string) => request<Me>("/me", { token }),

  branches: (token: string, tenantId: string) =>
    request<{ data: Branch[] }>("/branches", { token, tenantId }),

  contacts: (
    token: string,
    tenantId: string,
    params?: ContactsListParams,
  ) =>
    request<ContactsListResponse>(`/contacts${qs(params)}`, {
      token,
      tenantId,
    }),

  contactsCount: (token: string, tenantId: string) =>
    request<{ count: number }>("/contacts/count", { token, tenantId }),

  updateContact: (token: string, tenantId: string, contactId: string, payload: ContactUpdatePayload) =>
    request<ContactRow>(`/contacts/${contactId}`, {
      method: "PATCH",
      token,
      tenantId,
      body: payload,
    }),

  archiveContact: (token: string, tenantId: string, contactId: string) =>
    request<void>(`/contacts/${contactId}`, {
      method: "DELETE",
      token,
      tenantId,
    }),

  messages: (
    token: string,
    tenantId: string,
    params?: { page?: number; page_size?: number; status?: string; search?: string },
  ) =>
    request<MessagesListResponse>(`/messages${qs(params)}`, { token, tenantId }),

  messagesKpis: (token: string, tenantId: string) =>
    request<MessagesKpisResponse>("/messages/kpis", { token, tenantId }),

  groups: (token: string, tenantId: string) =>
    request<GroupsListResponse>("/groups", { token, tenantId }),

  createGroup: (
    token: string,
    tenantId: string,
    payload: { name: string; description?: string | null },
  ) =>
    request<GroupRow>("/groups", {
      method: "POST",
      token,
      tenantId,
      body: payload,
    }),

  uploadToGroup: async (
    token: string,
    tenantId: string,
    opts: { groupId: string; file: File; branchId: string; commit: boolean },
  ): Promise<GroupUploadResponse> => {
    const fd = new FormData();
    fd.append("file", opts.file);
    const url = `${API_URL}/groups/${opts.groupId}/upload${qs({
      branch_id: opts.branchId,
      commit: opts.commit,
    })}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantId },
      body: fd,
    });
    if (!res.ok) {
      let detail = res.statusText || "Upload failed";
      let bodyJson: unknown;
      try {
        bodyJson = await res.json();
        detail = (bodyJson as { detail?: string }).detail || detail;
      } catch { /* ignore */ }
      throw new ApiError(res.status, detail, bodyJson);
    }
    return res.json();
  },

  uploadContacts: async (
    token: string,
    tenantId: string,
    opts: { file: File; branch_id: string; commit: boolean },
  ): Promise<UploadResponse> => {
    // FormData path — cannot go through the JSON request() helper.
    const fd = new FormData();
    fd.append("file", opts.file);
    const url = `${API_URL}/contacts/upload${qs({
      branch_id: opts.branch_id,
      commit: opts.commit,
    })}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId,
      },
      body: fd,
    });
    if (!res.ok) {
      let detail = res.statusText || "Upload failed";
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, detail);
    }
    return res.json();
  },

  dashboardKpis: (token: string, tenantId: string, params?: DashboardFilters) =>
    request<DashboardKpis>(`/dashboard/kpis${qs(params)}`, { token, tenantId }),

  dashboardActivity: (
    token: string,
    tenantId: string,
    params?: DashboardFilters,
  ) =>
    request<{ series: ActivityPoint[] }>(
      `/dashboard/activity${qs(params)}`,
      { token, tenantId },
    ),

  dashboardCampaignStatus: (
    token: string,
    tenantId: string,
    params?: { branch_id?: string },
  ) =>
    request<CampaignStatusCounts>(
      `/dashboard/campaign-status${qs(params)}`,
      { token, tenantId },
    ),

  dashboardLatestBroadcasts: (
    token: string,
    tenantId: string,
    params?: { limit?: number; branch_id?: string },
  ) =>
    request<{ data: LatestBroadcast[] }>(
      `/dashboard/latest-broadcasts${qs(params)}`,
      { token, tenantId },
    ),

  templates: (token: string, tenantId: string) =>
    request<TemplatesListResponse>("/templates", { token, tenantId }),

  phoneNumbers: (token: string, tenantId: string) =>
    request<PhoneNumbersListResponse>("/phone-numbers", { token, tenantId }),

  broadcasts: (
    token: string,
    tenantId: string,
    params?: { page?: number; page_size?: number; status?: string },
  ) =>
    request<BroadcastsListResponse>(`/broadcasts${qs(params)}`, {
      token,
      tenantId,
    }),

  createBroadcast: (
    token: string,
    tenantId: string,
    payload: BroadcastCreatePayload,
  ) =>
    request<BroadcastDetail>("/broadcasts", {
      method: "POST",
      token,
      tenantId,
      body: payload,
    }),

  sendBroadcast: (token: string, tenantId: string, broadcastId: string) =>
    request<SendResponse>(`/broadcasts/${broadcastId}/send`, {
      method: "POST",
      token,
      tenantId,
    }),

  cancelBroadcast: (token: string, tenantId: string, broadcastId: string) =>
    request<{ status: string; campaign_id: string }>(
      `/broadcasts/${broadcastId}/cancel`,
      {
        method: "POST",
        token,
        tenantId,
      }
    ),
};

export { API_URL };
