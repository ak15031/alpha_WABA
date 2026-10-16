import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, Users, Megaphone, FileText, BarChart2,
  Settings, LogOut, ChevronDown, Search, Filter, Plus,
  Upload, Bell, Check, Clock, Calendar, Building2,
  ArrowUpRight, TrendingUp, X, ChevronRight,
  MessageSquare, Send, ArrowRight, Menu, AlertTriangle,
  FileUp, Activity, Copy, ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { ToastProvider, useToast } from "./Toast";
import { FullPageLoader, LoginScreen, useAuth } from "../auth";
import { ResetPasswordPage } from "./ResetPasswordPage";
import AcceptInvitePage from "./AcceptInvitePage";
import {
  useArchiveContact,
  useBranches,
  useBroadcasts,
  useContacts,
  useCreateBroadcast,
  useDashboard,
  usePhoneNumbers,
  useSendBroadcast,
  useCancelBroadcast,
  useTemplates,
  useUpdateContact,
  useUploadContacts,
  useGroups,
  useCreateGroup,
  useUploadToGroup,
  useMessages,
} from "./hooks";
import {
  createBranch,
  createTenant,
  deleteBranch,
  deleteBroadcast,
  deleteGroup,
  type TenantCreatePayload,
} from "../api";
import type {
  CampaignStatusCounts,
  ContactRow,
  GroupUploadResponse,
  InlineContact,
  LatestBroadcast,
  UploadResponse,
  UserRow,
  VarMode,
  VarRow,
} from "../api";
import {
  CONTACT_FIELDS,
  TENANT_FIELDS,
  emptyVarRow,
  inviteUser,
  listUsers,
  parsePastedContacts,
  removeUser,
  syncTemplatesFromMeta,
  updateUserRole,
  varRowToMapping,
} from "../api";
function BroadcastCreateForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");

  const [templateId, setTemplateId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [branchId, setBranchId] = useState("");
  const { groups } = useGroups();
  const [audienceType, setAudienceType] = useState<"all_contacts" | "branch_group" | "group">("all_contacts");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [audienceMode, setAudienceMode] = useState<"single" | "combined">("single");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [pastedContacts, setPastedContacts] = useState<InlineContact[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  const [variableRows, setVariableRows] = useState<Record<string, VarRow>>({});

  const { templates, loading: tplLoading } = useTemplates();
  const { phoneNumbers, loading: phLoading } = usePhoneNumbers();
  const { branches } = useBranches();
  const { create, creating } = useCreateBroadcast();

  const selectedTemplate = templates.find((t) => t.id === templateId);

  useEffect(() => {
    const vars = selectedTemplate?.variable_definitions ?? [];
    const next: Record<string, VarRow> = {};
    for (let i = 0; i < vars.length; i++) {
      const key = String((vars[i] as any).name ?? (vars[i] as any).index ?? i + 1);
      next[key] = variableRows[key] ?? emptyVarRow();
    }
    setVariableRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, templates]);

  const canSubmit = Boolean(
    name.trim() &&
    phoneNumberId &&
    templateId &&
    (audienceMode === 'single'
      ? branchId
      : (branchIds.length > 0 || groupIds.length > 0 || pastedContacts.length > 0))
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;

    if (
      audienceMode === "combined" &&
      !branchIds.length &&
      !groupIds.length &&
      !pastedContacts.length
    ) {
      toast.push({
        variant: "error",
        message: "Select at least one branch, group, or paste some numbers.",
      });
      return;
    }

    try {
      const variable_mappings: Record<string, any> = {};
      for (const [key, row] of Object.entries(variableRows)) {
        variable_mappings[key] = varRowToMapping(row);
      }

      const payload = audienceMode === "single"
        ? {
            name: name.trim(),
            branch_id: branchId,
            phone_number_id: phoneNumberId,
            template_id: templateId,
            variable_mappings,
            audience_type: audienceType,
            audience_config: audienceType === "group" ? { group_id: selectedGroupId } : {},
            lane: "bulk" as const,
            schedule: "immediate" as const,
          }
        : {
            name: name.trim(),
            branch_id: null,
            phone_number_id: phoneNumberId,
            template_id: templateId,
            variable_mappings,
            audience_type: "combined" as const,
            audience_config: {
              ...(branchIds.length ? { branch_ids: branchIds } : {}),
              ...(groupIds.length ? { group_ids: groupIds } : {}),
              ...(pastedContacts.length ? { inline_contacts: pastedContacts } : {}),
            },
            lane: "bulk" as const,
            schedule: "immediate" as const,
          };

      await create(payload);
      toast.push({
        variant: "success",
        message: "Campaign created successfully.",
      });
      onDone();
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to create campaign",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };


  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <button onClick={onCancel} className="text-sm mb-2" style={{ color: "#2563EB" }}>← Back to campaigns</button>
        <h1 className="text-2xl font-semibold" style={{ color: "#0F172A" }}>Create Broadcast Campaign</h1>
      </div>

      <div className="space-y-4 p-6 rounded-lg" style={{ background: "#fff", border: "1px solid #E2E8F0" }}>
        <div>
          <label className="text-sm font-medium block mb-1" style={{ color: "#334155" }}>Campaign name</label>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Faculty Meeting Oct 25"
            className="w-full px-3 py-2 text-sm rounded-md outline-none"
            style={{ border: "1px solid #E2E8F0", background: "#fff" }}
          />
          {audienceMode === 'single' && (
            <div>
              <label className="text-sm font-medium block mb-1" style={{ color: "#334155" }}>Branch</label>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md outline-none"
                style={{ border: "1px solid #E2E8F0", background: "#fff" }}
              >
                <option value="">Select a branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <label className="text-sm font-medium block" style={{ color: "#334155" }}>Audience</label>

          <div className="flex gap-2 border-b">
            <button
              type="button"
              className={`px-3 py-2 ${audienceMode === "single" ? "border-b-2 border-blue-600 font-medium" : "text-gray-500"}`}
              onClick={() => setAudienceMode("single")}
            >
              Single branch
            </button>
            <button
              type="button"
              className={`px-3 py-2 ${audienceMode === "combined" ? "border-b-2 border-blue-600 font-medium" : "text-gray-500"}`}
              onClick={() => setAudienceMode("combined")}
            >
              Mix &amp; match
            </button>
          </div>

          {audienceMode === "single" ? (
            <>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md outline-none"
                style={{ border: "1px solid #E2E8F0", background: "#fff" }}
              >
                <option value="">Select a branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>

              <select
                value={audienceType}
                onChange={(e) => setAudienceType(e.target.value as typeof audienceType)}
                className="w-full px-3 py-2 text-sm rounded-md outline-none"
                style={{ border: "1px solid #E2E8F0", background: "#fff" }}
              >
                <option value="all_contacts">All contacts in branch</option>
                <option value="group">A specific group in this branch</option>
              </select>

              {audienceType === "group" && (
                <select
                  value={selectedGroupId}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md outline-none"
                  style={{ border: "1px solid #E2E8F0", background: "#fff" }}
                >
                  <option value="">Select a group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.member_count})</option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium mb-1">Branches (any contacts in these)</div>
                <div className="border rounded p-2 max-h-32 overflow-y-auto space-y-1">
                  {branches.map((b) => (
                    <label key={b.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={branchIds.includes(b.id)}
                        onChange={(e) => setBranchIds((prev) =>
                          e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id)
                        )}
                      />
                      {b.name}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">Groups</div>
                <div className="border rounded p-2 max-h-32 overflow-y-auto space-y-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={(e) => setGroupIds((prev) =>
                          e.target.checked ? [...prev, g.id] : prev.filter((x) => x !== g.id)
                        )}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">
                  Paste numbers (one per line, optionally with a name)
                </div>
                <textarea
                  rows={4}
                  placeholder={"+923001234567\n+923009876543, Ali Khan\nHina Shah, 0321-5551234"}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  className="w-full border rounded p-2 font-mono text-sm"
                  style={{ border: "1px solid #E2E8F0", background: "#fff" }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setPastedContacts(parsePastedContacts(pasteText));
                    setShowPreview(true);
                  }}
                  className="mt-2 px-3 py-1 border rounded text-sm hover:bg-gray-50"
                >
                  Preview parse
                </button>

                {showPreview && (
                  <div className="mt-2 border rounded max-h-40 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-left">
                        <tr>
                          <th className="p-1 px-2">Phone</th>
                          <th className="p-1 px-2">Name</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pastedContacts.length === 0 && (
                          <tr>
                            <td colSpan={2} className="p-2 text-gray-500">No rows parsed</td>
                          </tr>
                        )}
                        {pastedContacts.map((c, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-1 px-2 font-mono">{c.phone_e164}</td>
                            <td className="p-1 px-2">{c.full_name || <span className="text-gray-400">(no name)</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="p-2 text-xs text-gray-600 border-t">
                      {pastedContacts.length} unique recipient{pastedContacts.length === 1 ? "" : "s"} will be added.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="text-sm font-medium block mb-1" style={{ color: "#334155" }}>Send from (phone number)</label>
          <select
            value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md outline-none"
            style={{ border: "1px solid #E2E8F0", background: "#fff" }}
          >
            <option value="">{phLoading ? "Loading…" : "Select a sender number"}</option>
            {phoneNumbers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_phone_number} — {p.waba_business_name}{p.is_test_number ? " (test)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm font-medium block mb-1" style={{ color: "#334155" }}>Message template</label>
          <select
            value={templateId} onChange={(e) => setTemplateId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md outline-none"
            style={{ border: "1px solid #E2E8F0", background: "#fff" }}
          >
            <option value="">{tplLoading ? "Loading…" : "Select an approved template"}</option>
            {templates.filter((t) => t.status === "approved").map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.language_code})</option>
            ))}
          </select>
          {selectedTemplate && (
            <div className="mt-2 p-3 rounded-md text-xs whitespace-pre-wrap" style={{ background: "#F8FAFC", color: "#475569" }}>
              <div className="font-medium mb-1" style={{ color: "#0F172A" }}>Template body:</div>
              {selectedTemplate.body_text}
            </div>
          )}
        </div>

        {selectedTemplate && (
          <div className="space-y-2">
            <div className="font-medium">Template variables</div>
            {Object.keys(variableRows).length === 0 && (
              <div className="text-sm text-gray-500">
                This template has no variables.
              </div>
            )}
            {Object.entries(variableRows).map(([key, row]) => (
              <div key={key} className="flex items-start gap-2 flex-wrap">
                <span className="inline-block min-w-[70px] text-xs font-mono bg-gray-100 rounded px-2 py-1 mt-1">
                  {`{{${key}}}`}
                </span>

                <select
                  className="border rounded p-1 text-sm"
                  value={row.mode}
                  onChange={e => setVariableRows({
                    ...variableRows,
                    [key]: { ...row, mode: e.target.value as VarMode, value: '', fallback: '' },
                  })}
                >
                  <option value="static">Enter text</option>
                  <option value="contact">Contact field</option>
                  <option value="tenant">Tenant field</option>
                </select>

                {row.mode === 'static' && (
                  <input
                    className="flex-1 border rounded p-1 text-sm min-w-[180px]"
                    placeholder="Same text for every recipient"
                    value={row.value}
                    onChange={e => setVariableRows({
                      ...variableRows,
                      [key]: { ...row, value: e.target.value },
                    })}
                  />
                )}

                {row.mode === 'contact' && (
                  <>
                    <select
                      className="border rounded p-1 text-sm"
                      value={row.value || 'full_name'}
                      onChange={e => setVariableRows({
                        ...variableRows,
                        [key]: { ...row, value: e.target.value },
                      })}
                    >
                      {CONTACT_FIELDS.map(f => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                    <input
                      className="flex-1 border rounded p-1 text-sm min-w-[140px]"
                      placeholder="Fallback if empty (default: Receiver)"
                      value={row.fallback}
                      onChange={e => setVariableRows({
                        ...variableRows,
                        [key]: { ...row, fallback: e.target.value },
                      })}
                    />
                  </>
                )}

                {row.mode === 'tenant' && (
                  <>
                    <select
                      className="border rounded p-1 text-sm"
                      value={row.value || 'name'}
                      onChange={e => setVariableRows({
                        ...variableRows,
                        [key]: { ...row, value: e.target.value },
                      })}
                    >
                      {TENANT_FIELDS.map(f => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                    <input
                      className="flex-1 border rounded p-1 text-sm min-w-[140px]"
                      placeholder="Fallback if empty"
                      value={row.fallback}
                      onChange={e => setVariableRows({
                        ...variableRows,
                        [key]: { ...row, fallback: e.target.value },
                      })}
                    />
                  </>
                )}
              </div>
            ))}
            <div className="text-xs text-gray-500 pt-1">
              Contact fields personalize per recipient. Fallback shows if that recipient's field is empty.
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-4" style={{ borderTop: "1px solid #E2E8F0" }}>
          <button onClick={onCancel} className="px-4 py-2 rounded-md text-sm" style={{ border: "1px solid #E2E8F0", background: "#fff", color: "#0F172A" }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit} disabled={!canSubmit}
            className="px-4 py-2 rounded-md text-sm font-medium text-white"
            style={{ background: canSubmit ? "#2563EB" : "#CBD5E1", cursor: canSubmit ? "pointer" : "not-allowed" }}
          >
            {creating ? "Creating…" : "Create Campaign (draft)"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Static UI data (unchanged mocks kept for screens not yet wired) ─────────

const contacts = [
  { id: 1, name: "Sarah Mitchell", phone: "+1 212 555 0147", branch: "New York Office", created: "Jun 15, 2025", status: "Active" },
  { id: 2, name: "James Okafor", phone: "+44 20 7946 0318", branch: "London Branch", created: "Jun 18, 2025", status: "Active" },
  { id: 3, name: "Ana Ramirez", phone: "+1 646 555 0892", branch: "New York Office", created: "Jun 22, 2025", status: "Opt-out" },
  { id: 4, name: "Tom Lindqvist", phone: "+46 8 555 0234", branch: "Remote Team", created: "Jul 1, 2025", status: "Active" },
  { id: 5, name: "Priya Nair", phone: "+91 98765 43210", branch: "Remote Team", created: "Jul 3, 2025", status: "Active" },
  { id: 6, name: "Chen Wei", phone: "+86 138 0000 1234", branch: "London Branch", created: "Jul 5, 2025", status: "Active" },
  { id: 7, name: "Marcus Johnson", phone: "+1 917 555 0674", branch: "New York Office", created: "Jul 8, 2025", status: "Active" },
  { id: 8, name: "Fatima Al-Hassan", phone: "+971 50 123 4567", branch: "Remote Team", created: "Jul 10, 2025", status: "Opt-out" },
];

const navItems = [
  { id: "dashboard", label: "Dashboard",            icon: LayoutDashboard },
  { id: "contacts",  label: "Contacts",             icon: Users },
  { id: "campaigns", label: "Broadcast Campaigns",  icon: Megaphone },
    { id: "logs",      label: "Message Logs",         icon: Activity },
  { id: "templates", label: "Message Templates",    icon: FileText },
];

const MESSAGE_TEMPLATES = [
  {
    id: "promo",
    name: "Promotional Offer",
    preview: "Hi {{1}}, we have an exclusive offer just for you! Get {{2}} off your next purchase. Use code {{3}}. Valid until {{4}}.",
    vars: [["{{1}}", "Contact First Name"], ["{{2}}", "Discount Value"], ["{{3}}", "Promo Code"], ["{{4}}", "Expiry Date"]],
  },
  {
    id: "order",
    name: "Order Confirmation",
    preview: "Hello {{1}}, your order #{{2}} has been confirmed. Estimated delivery: {{3}}. Reply TRACK to get updates.",
    vars: [["{{1}}", "Contact First Name"], ["{{2}}", "Order Number"], ["{{3}}", "Delivery Date"]],
  },
  {
    id: "reminder",
    name: "Appointment Reminder",
    preview: "Hi {{1}}, this is a reminder for your appointment on {{2}} at {{3}}. Reply YES to confirm or NO to reschedule.",
    vars: [["{{1}}", "Contact First Name"], ["{{2}}", "Appointment Date"], ["{{3}}", "Time Slot"]],
  },
];

const VAR_VALUES: Record<string, string> = {
  "{{1}}": "Sarah",
  "{{2}}": "20%",
  "{{3}}": "BFRIDAY20",
  "{{4}}": "Nov 30, 2025",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function formatPercentage(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatSignedNumber(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatTrendPct(value: number): string {
  if (value === 0) return "0.0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const diffMin = Math.round((now - ts) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function humanizeStatus(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    scheduled: "Scheduled",
    queued: "Queued",
    running: "In Progress",
    completed: "Completed",
    failed: "Failed",
    canceled: "Canceled",
  };
  return map[status] ?? status;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#94A3B8",
  scheduled: "#F59E0B",
  queued: "#F59E0B",
  running: "#2563EB",
  completed: "#22C55E",
  failed: "#EF4444",
  canceled: "#CBD5E1",
};

function SparkLine({ data, color }: { data: number[]; color: string; seriesKey?: string }) {
  const W = 120, H = 40, pad = 2;
  const cleanData = data.length ? data : [0, 0];
  const min = Math.min(...cleanData);
  const max = Math.max(...cleanData);
  const range = max - min || 1;
  const pts = cleanData.map((v, i) => {
    const x = pad + (i / Math.max(cleanData.length - 1, 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return `${x},${y}`;
  });
  const linePath = `M${pts.join("L")}`;
  const areaPath = `M${pts[0]}L${pts.join("L")}L${W - pad},${H - pad}L${pad},${H - pad}Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={40} style={{ display: "block", overflow: "visible" }}>
      <path d={areaPath} fill={color} fillOpacity={0.12} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; dot?: string }> = {
    Sent:        { bg: "#F0FDF4", fg: "#16A34A", dot: "#22C55E" },
    Scheduled:   { bg: "#FFFBEB", fg: "#B45309", dot: "#F59E0B" },
    Active:      { bg: "#F0FDF4", fg: "#16A34A", dot: "#22C55E" },
    "Opt-out":   { bg: "#F8FAFC", fg: "#64748B", dot: "#94A3B8" },
    Draft:       { bg: "#F8FAFC", fg: "#64748B", dot: "#94A3B8" },
    "In Progress": { bg: "#EFF6FF", fg: "#1D4ED8", dot: "#2563EB" },
    Completed:   { bg: "#F0FDF4", fg: "#16A34A", dot: "#22C55E" },
    Failed:      { bg: "#FEF2F2", fg: "#B91C1C", dot: "#EF4444" },
    Queued:      { bg: "#FFFBEB", fg: "#B45309", dot: "#F59E0B" },
    Canceled:    { bg: "#F8FAFC", fg: "#64748B", dot: "#CBD5E1" },
  };
  const s = map[status] ?? { bg: "#F8FAFC", fg: "#64748B", dot: "#94A3B8" };
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.dot }} />
      {status}
    </span>
  );
}

function MockDataBanner({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2.5 mx-4 sm:mx-6 lg:mx-8 mt-4 rounded-md"
      style={{ background: "#FEF3C7", border: "1px solid #FDE68A", color: "#92400E" }}
    >
      <AlertTriangle size={13} />
      <p className="text-xs font-medium">
        {label} shows placeholder data. Backend endpoints are live — wiring pending.
      </p>
    </div>
  );
}

// ─── Sidebar (WIRED: tenant switcher, user info, logout) ──────────────────────

function Sidebar({
  active,
  onNavigate,
  open,
  onClose,
}: {
  active: string;
  onNavigate: (id: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const { me, activeMembership, setActiveTenantId, signOut } = useAuth();
  const [tenantOpen, setTenantOpen] = useState(false);

  const handleNav = (id: string) => {
    onNavigate(id);
    onClose();
  };

  const otherMemberships = me?.memberships.filter(
    (m) => m.tenant_id !== activeMembership?.tenant_id,
  ) ?? [];

  const displayName = me?.full_name || me?.email || "User";
  const displayRole = activeMembership?.role
    ? activeMembership.role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : me?.is_platform_admin ? "Platform Admin" : "";
  const userAvatarInitials = initials(displayName);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-50 h-full flex flex-col
          transition-transform duration-200
          lg:static lg:translate-x-0 lg:z-auto lg:flex-shrink-0
          ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
        style={{ width: "232px", background: "#0F172A" }}
      >
        <div className="flex flex-col gap-3 px-4 pt-5 pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#25D366" }}>
                <MessageSquare size={14} className="text-white" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm tracking-tight leading-none">WA Platform</p>
                <p className="text-[10px] leading-none mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>API Dashboard</p>
              </div>
            </div>
            <button onClick={onClose} className="lg:hidden p-1 rounded" style={{ color: "rgba(255,255,255,0.4)" }}>
              <X size={16} />
            </button>
          </div>

          {/* Tenant Switcher */}
          <div className="relative">
            <button
              onClick={() => setTenantOpen(!tenantOpen)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md transition-colors"
              style={{ background: "rgba(255,255,255,0.06)" }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-6 h-6 rounded flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0" style={{ background: "#3B82F6" }}>
                  {activeMembership?.tenant_name?.[0] ?? "?"}
                </div>
                <div className="min-w-0 text-left">
                  <p className="text-white text-xs font-semibold truncate leading-none mb-0.5">
                    {activeMembership?.tenant_name ?? "No tenant selected"}
                  </p>
                  <p className="text-[10px] leading-none" style={{ color: "rgba(255,255,255,0.35)" }}>
                    {activeMembership ? displayRole : "—"}
                  </p>
                </div>
              </div>
              <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${tenantOpen ? "rotate-180" : ""}`} style={{ color: "rgba(255,255,255,0.35)" }} />
            </button>

            {tenantOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden z-50 shadow-xl" style={{ background: "#1E293B", border: "1px solid rgba(255,255,255,0.08)" }}>
                {otherMemberships.length === 0 ? (
                  <div className="px-3 py-2 text-[11px]" style={{ color: "rgba(255,255,255,0.4)" }}>
                    No other tenants to switch to.
                  </div>
                ) : (
                  otherMemberships.map((m) => (
                    <button
                      key={m.tenant_id}
                      onClick={() => { setActiveTenantId(m.tenant_id); setTenantOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-white/5"
                      style={{ color: "rgba(255,255,255,0.55)" }}
                    >
                      <div className="w-5 h-5 rounded flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0" style={{ background: "#7C3AED" }}>
                        {m.tenant_name[0]}
                      </div>
                      {m.tenant_name}
                    </button>
                  ))
                )}
                {me?.is_platform_admin && (
                  <button
                    type="button"
                    onClick={() => {
                      setTenantOpen(false);
                      onNavigate('platform-create-tenant');
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs border-t border-white/10 hover:bg-white/5"
                    style={{ color: "rgba(255,255,255,0.75)" }}
                  >
                    <div className="w-5 h-5 rounded flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style={{ background: "#059669" }}>
                      +
                    </div>
                    <span>Add new tenant</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-3 py-4 overflow-y-auto">
          {[
            ...navItems,
            ...((me?.is_platform_admin || activeMembership?.role === "tenant_admin")
              ? [{ id: "branches", label: "Branches", icon: Building2 }]
              : []),
            ...((me?.is_platform_admin || activeMembership?.role === "tenant_admin")
              ? [{ id: "users", label: "Users", icon: Users }]
              : []),
          ].map((item) => {
            const isActive = active === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all text-left"
                style={
                  isActive
                    ? { background: "#2563EB", color: "#ffffff" }
                    : { color: "rgba(255,255,255,0.45)" }
                }
                onMouseEnter={(e) => { if (!isActive) { const el = e.currentTarget as HTMLButtonElement; el.style.color = "rgba(255,255,255,0.85)"; el.style.background = "rgba(255,255,255,0.06)"; }}}
                onMouseLeave={(e) => { if (!isActive) { const el = e.currentTarget as HTMLButtonElement; el.style.color = "rgba(255,255,255,0.45)"; el.style.background = ""; }}}
              >
                <Icon size={15} className="flex-shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex flex-col gap-0.5 px-3 py-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-md">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-semibold flex-shrink-0" style={{ background: "linear-gradient(135deg,#3B82F6,#2563EB)" }}>
              {userAvatarInitials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-xs font-semibold truncate leading-none mb-0.5">{displayName}</p>
              <p className="text-[10px] leading-none truncate" style={{ color: "rgba(255,255,255,0.35)" }}>
                {displayRole || "—"}
              </p>
            </div>
            <Bell size={13} style={{ color: "rgba(255,255,255,0.3)" }} className="flex-shrink-0" />
          </div>
          <button
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors"
            style={{ color: "rgba(255,255,255,0.4)" }}
            onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = "rgba(255,255,255,0.8)"; el.style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = "rgba(255,255,255,0.4)"; el.style.background = ""; }}
          >
            <Settings size={14} className="flex-shrink-0" />
            Settings
          </button>
          <button
            onClick={() => signOut()}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors"
            style={{ color: "rgba(248,113,113,0.7)" }}
            onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = "#F87171"; el.style.background = "rgba(248,113,113,0.08)"; }}
            onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = "rgba(248,113,113,0.7)"; el.style.background = ""; }}
          >
            <LogOut size={14} className="flex-shrink-0" />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}

// ─── Mobile Topbar ────────────────────────────────────────────────────────────

function MobileTopbar({ onMenuOpen }: { onMenuOpen: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 lg:hidden flex-shrink-0"
      style={{ background: "#0F172A", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <button onClick={onMenuOpen} className="p-1.5 rounded-md" style={{ color: "rgba(255,255,255,0.6)" }}>
        <Menu size={18} />
      </button>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "#25D366" }}>
          <MessageSquare size={12} className="text-white" />
        </div>
        <span className="text-white text-sm font-semibold">WA Platform</span>
      </div>
    </div>
  );
}

// ─── Screen 1: Dashboard (WIRED to backend) ───────────────────────────────────

function DashboardScreen() {
  const { activeMembership } = useAuth();
  const { branches } = useBranches();

  // Branch filter — single-select for now (backend accepts one branch_id).
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [dateRange, setDateRange] = useState("Last 7 Days");
  const [dateOpen, setDateOpen] = useState(false);

  const { data, loading, error } = useDashboard(activeBranchId ?? undefined);

  const activeBranchName =
    activeBranchId
      ? branches.find((b) => b.id === activeBranchId)?.name ?? "Unknown"
      : "All Branches";

  const statCards = useMemo(() => {
    if (!data) return [];
    const k = data.kpis.kpis;
    return [
      {
        label: "Total Messages Sent",
        value: formatWholeNumber(k.total_sent.value),
        change: formatTrendPct(k.total_sent.trend_pct),
        data: k.total_sent.sparkline,
        color: "#2563EB",
      },
      {
        label: "Delivered Rate",
        value: formatPercentage(k.delivered_rate.value),
        change: formatTrendPct(k.delivered_rate.trend_pct),
        data: k.delivered_rate.sparkline,
        color: "#22C55E",
      },
      {
        label: "Read Rate",
        value: formatPercentage(k.read_rate.value),
        change: formatTrendPct(k.read_rate.trend_pct),
        data: k.read_rate.sparkline,
        color: "#8B5CF6",
      },
      {
        label: "Active Contacts",
        value: formatWholeNumber(k.active_contacts.value),
        change: formatSignedNumber(k.active_contacts.trend_pct),
        data: k.active_contacts.sparkline,
        color: "#F59E0B",
      },
    ];
  }, [data]);

  const messagingData = useMemo(
    () =>
      data?.activity.map((p) => ({
        date: shortDate(p.date),
        sent: p.sent,
        delivered: p.delivered,
      })) ?? [],
    [data],
  );

  const campaignStatus = useMemo(() => {
    const counts: Record<string, number> = data?.campaignCounts ?? {};
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([status, value]) => ({
        name: humanizeStatus(status),
        value,
        color: STATUS_COLORS[status] ?? "#94A3B8",
      }));
  }, [data]);

  const totalCampaigns = campaignStatus.reduce((sum, s) => sum + s.value, 0);

  const broadcasts = useMemo(
    () =>
      data?.latest.map((b: LatestBroadcast) => ({
        name: b.name,
        branch: b.branch_name ?? "—",
        status: humanizeStatus(b.status),
        time: b.sent_at ? timeAgo(b.sent_at) : "—",
        reach: b.recipient_count.toLocaleString(),
      })) ?? [],
    [data],
  );

  const dateRangeLabel = data
    ? `${shortDate(data.kpis.period.start)} – ${shortDate(data.kpis.period.end)}, ${new Date(data.kpis.period.end).getFullYear()}`
    : "";

  return (
    <div
      className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8 w-full"
      onClick={() => { setBranchOpen(false); setDateOpen(false); }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="text-lg sm:text-xl font-semibold" style={{ color: "#0F172A" }}>
            Welcome Back{data?.kpis ? "" : "…"}
          </h1>
          <p className="text-sm" style={{ color: "#64748B" }}>
            {activeMembership?.tenant_name ?? "—"} · {activeBranchName} · {dateRange}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Branch Filter */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setBranchOpen(!branchOpen); setDateOpen(false); }}
              className="flex items-center gap-2 px-3 py-2 bg-white rounded-md text-sm font-medium transition-colors"
              style={{ border: "1px solid #E2E8F0", color: "#374151", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
            >
              <Building2 size={14} style={{ color: "#94A3B8" }} />
              <span className="hidden sm:inline">{activeBranchName}</span>
              <span className="sm:hidden">Branches</span>
              <ChevronDown size={13} style={{ color: "#94A3B8" }} className={`transition-transform ${branchOpen ? "rotate-180" : ""}`} />
            </button>
            {branchOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-md z-30 overflow-hidden" style={{ border: "1px solid #E2E8F0", boxShadow: "0 8px 24px rgba(0,0,0,0.10)" }}>
                <div className="px-3 py-2" style={{ borderBottom: "1px solid #F1F5F9" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#94A3B8" }}>Filter by Branch</p>
                </div>
                <button
                  onClick={() => { setActiveBranchId(null); setBranchOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-slate-50"
                  style={{ color: activeBranchId === null ? "#2563EB" : "#374151", background: activeBranchId === null ? "#EFF6FF" : "transparent" }}
                >
                  <div className="w-4 h-4 rounded flex items-center justify-center" style={{ border: activeBranchId === null ? "none" : "1px solid #CBD5E1", background: activeBranchId === null ? "#2563EB" : "transparent" }}>
                    {activeBranchId === null && <Check size={10} className="text-white" />}
                  </div>
                  All Branches
                </button>
                {branches.map((branch) => {
                  const checked = activeBranchId === branch.id;
                  return (
                    <button
                      key={branch.id}
                      onClick={() => { setActiveBranchId(branch.id); setBranchOpen(false); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-slate-50"
                      style={{ color: checked ? "#2563EB" : "#374151", background: checked ? "#EFF6FF" : "transparent" }}
                    >
                      <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ border: checked ? "none" : "1px solid #CBD5E1", background: checked ? "#2563EB" : "transparent" }}>
                        {checked && <Check size={10} className="text-white" />}
                      </div>
                      {branch.name}
                    </button>
                  );
                })}
                {branches.length === 0 && (
                  <div className="px-3 py-2 text-xs" style={{ color: "#94A3B8" }}>
                    No branches for this tenant yet.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Date Range (visual only for now — hardcoded to last 7 days server-side) */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setDateOpen(!dateOpen); setBranchOpen(false); }}
              className="flex items-center gap-2 px-3 py-2 bg-white rounded-md text-sm font-medium transition-colors"
              style={{ border: "1px solid #E2E8F0", color: "#374151", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
            >
              <Calendar size={14} style={{ color: "#94A3B8" }} />
              <span className="hidden sm:inline">{dateRange}</span>
              <span className="sm:hidden">Date</span>
              <ChevronDown size={13} style={{ color: "#94A3B8" }} className={`transition-transform ${dateOpen ? "rotate-180" : ""}`} />
            </button>
            {dateOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-white rounded-md z-30 overflow-hidden" style={{ border: "1px solid #E2E8F0", boxShadow: "0 8px 24px rgba(0,0,0,0.10)" }}>
                {["Last 7 Days", "Last 30 Days", "Last 90 Days"].map((d) => (
                  <button key={d} onClick={() => { setDateRange(d); setDateOpen(false); }}
                    className="w-full text-left px-3 py-2.5 text-sm transition-colors"
                    style={{ color: dateRange === d ? "#2563EB" : "#374151", background: dateRange === d ? "#EFF6FF" : "transparent" }}>
                    {d}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 rounded-md"
          style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C" }}
        >
          <AlertTriangle size={13} />
          <p className="text-xs font-medium">Failed to load dashboard: {error}</p>
        </div>
      )}

      {loading && !data && (
        <p className="text-sm" style={{ color: "#94A3B8" }}>Loading dashboard…</p>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.label} className="flex flex-col gap-1 bg-white rounded-lg p-5" style={{ border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium leading-snug" style={{ color: "#64748B" }}>{card.label}</p>
              <span className="text-xs font-semibold flex items-center gap-0.5 flex-shrink-0" style={{ color: card.change.startsWith("-") ? "#DC2626" : "#16A34A" }}>
                <TrendingUp size={11} />{card.change}
              </span>
            </div>
            <p className="text-[26px] font-semibold leading-tight" style={{ color: "#0F172A" }}>{card.value}</p>
            <SparkLine data={card.data} color={card.color} />
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="flex flex-col gap-4 bg-white rounded-lg p-5 lg:col-span-2" style={{ border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold" style={{ color: "#0F172A" }}>Messaging Activity Overview</h3>
              <p className="text-xs mt-0.5" style={{ color: "#94A3B8" }}>{dateRangeLabel}</p>
            </div>
            <div className="flex items-center gap-4">
              {[{ label: "Sent", color: "#2563EB" }, { label: "Delivered", color: "#22C55E" }].map((l) => (
                <div key={l.label} className="flex items-center gap-1.5 text-xs" style={{ color: "#64748B" }}>
                  <div className="w-5 h-[2px] rounded" style={{ background: l.color }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={messagingData} margin={{ top: 0, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid key="lc-grid" strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
              <XAxis key="lc-xaxis" dataKey="date" tick={{ fontSize: 11, fill: "#94A3B8" }} axisLine={false} tickLine={false} />
              <YAxis key="lc-yaxis" tick={{ fontSize: 11, fill: "#94A3B8" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
              <Tooltip key="lc-tooltip" contentStyle={{ border: "1px solid #E2E8F0", borderRadius: "8px", fontSize: "12px", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", padding: "8px 12px" }} labelStyle={{ color: "#374151", fontWeight: 600 }} />
              <Line key="lc-sent" type="monotone" dataKey="sent" stroke="#2563EB" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#2563EB", strokeWidth: 0 }} />
              <Line key="lc-delivered" type="monotone" dataKey="delivered" stroke="#22C55E" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#22C55E", strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Donut */}
        <div className="flex flex-col gap-1 bg-white rounded-lg p-5" style={{ border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "#0F172A" }}>Campaign Status</h3>
          <p className="text-xs mb-2" style={{ color: "#94A3B8" }}>{totalCampaigns} total campaigns</p>
          <ResponsiveContainer width="100%" height={148}>
            <PieChart>
              <Pie key="pc-pie" data={campaignStatus} cx="50%" cy="50%" innerRadius={46} outerRadius={66} paddingAngle={2.5} dataKey="value" strokeWidth={0}>
                {campaignStatus.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip key="pc-tooltip" contentStyle={{ border: "1px solid #E2E8F0", borderRadius: "8px", fontSize: "12px" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-2.5 mt-1">
            {campaignStatus.length === 0 && (
              <p className="text-xs" style={{ color: "#94A3B8" }}>No campaigns yet.</p>
            )}
            {campaignStatus.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: item.color }} />
                  <span style={{ color: "#64748B" }}>{item.name}</span>
                </div>
                <span className="font-semibold" style={{ color: "#1E293B" }}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Latest Broadcasts */}
      <div className="bg-white rounded-lg overflow-hidden" style={{ border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid #F1F5F9" }}>
          <h3 className="text-sm font-semibold" style={{ color: "#0F172A" }}>Latest Broadcasts</h3>
          <button className="text-xs font-medium flex items-center gap-1 hover:opacity-70 transition-opacity" style={{ color: "#2563EB" }}>
            View All <ArrowUpRight size={12} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr style={{ borderBottom: "1px solid #F8FAFC" }}>
                {["Campaign Name", "Branch", "Status", "Time"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "#94A3B8" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {broadcasts.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-sm" style={{ color: "#94A3B8" }}>
                    No broadcasts yet.
                  </td>
                </tr>
              )}
              {broadcasts.map((row, i) => (
                <tr
                  key={i}
                  style={{ borderBottom: i < broadcasts.length - 1 ? "1px solid #F8FAFC" : "none" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#FAFBFC")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <td className="px-5 py-3.5">
                    <p className="text-sm font-medium" style={{ color: "#1E293B" }}>{row.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: "#94A3B8" }}>{row.reach} recipients</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-sm whitespace-nowrap" style={{ color: "#475569" }}>
                      <Building2 size={13} style={{ color: "#CBD5E1" }} className="flex-shrink-0" />
                      {row.branch}
                    </div>
                  </td>
                  <td className="px-5 py-3.5"><StatusBadge status={row.status} /></td>
                  <td className="px-5 py-3.5 text-sm whitespace-nowrap" style={{ color: "#64748B" }}>{row.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Screen 2: Contacts (STILL MOCK — banner shows this) ─────────────────────

// ─── Phone normalization helpers (mirrors backend) ──────────────────────────

/**
 * Normalize a raw phone string to E.164.
 *
 * Handles common local-format inputs by prepending a default country code
 * when appropriate. Rules:
 *   - Strip everything except digits and a single leading '+'
 *   - If input starts with '+', preserve as-is (assume user gave country code)
 *   - If input starts with '00', treat as international prefix → replace with '+'
 *   - Otherwise, strip a single leading '0' (local trunk prefix) and prepend
 *     the default country code
 *   - Reject if final digit count is <8 (too short to be a real phone) or
 *     >15 (E.164 max length)
 *
 * @param raw the user's input line
 * @param defaultCountryCode digits only, no '+'. e.g. "92" for Pakistan
 */
function normalizePhoneToE164(
  raw: string,
  defaultCountryCode: string = "92",
): { ok: true; e164: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "empty" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Strip everything except digits and leading '+'
  const cleaned = trimmed.replace(/[^\d+]/g, "");
  if (!cleaned) return { ok: false, reason: "no_digits" };

  let digits: string;

  if (cleaned.startsWith("+")) {
    // User provided country code — trust them
    digits = cleaned.slice(1).replace(/\+/g, "");
  } else if (cleaned.startsWith("00")) {
    // International prefix (some regions dial 00 instead of +)
    digits = cleaned.slice(2);
  } else if (cleaned.startsWith("0")) {
    // Local format with trunk-line leading 0 — strip and prepend CC
    digits = defaultCountryCode + cleaned.slice(1);
  } else {
    // No prefix — assume already includes country code
    digits = cleaned;
  }

  if (!digits) return { ok: false, reason: "no_digits" };
  if (digits.length < 8) return { ok: false, reason: "too_short" };
  if (digits.length > 15) return { ok: false, reason: "too_long" };

  return { ok: true, e164: `+${digits}` };
}

interface ParsedPhoneLine {
  raw: string;
  status: "valid" | "invalid" | "empty";
  e164?: string;
  reason?: string;
}

function parsePastedPhones(text: string, defaultCountryCode: string = "92"): ParsedPhoneLine[] {
  const lines = text.split(/[\r\n]+/);
  const out: ParsedPhoneLine[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) {
      out.push({ raw: line, status: "empty" });
      continue;
    }
    const norm = normalizePhoneToE164(line, defaultCountryCode);
    if (!norm.ok) {
      out.push({ raw: line, status: "invalid", reason: norm.reason });
      continue;
    }
    if (seen.has(norm.e164)) {
      out.push({ raw: line, status: "invalid", reason: "duplicate" });
      continue;
    }
    seen.add(norm.e164);
    out.push({ raw: line, status: "valid", e164: norm.e164 });
  }
  return out;
}

/**
 * Turn parsed phones into a synthetic CSV File that the existing
 * /contacts/upload endpoint accepts. Header row uses `phone` as the column
 * name — matches the backend's alias-matching (accepts phone, phone_number,
 * mobile, contact, etc.).
 */
function phonesToCsvFile(parsed: ParsedPhoneLine[]): File {
  const rows = ["phone"];
  for (const p of parsed) {
    if (p.status === "valid" && p.e164) rows.push(p.e164);
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  return new File([blob], "pasted-phones.csv", { type: "text/csv" });
}
function GroupsPanel() {
  const { groups, loading, error, refresh } = useGroups();
  const { create, creating } = useCreateGroup();
  const { upload, uploading } = useUploadToGroup();
  const { branches } = useBranches();
  const { session, activeTenantId, activeMembership } = useAuth();
  const toast = useToast();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadTargetGroup, setUploadTargetGroup] = useState<string | null>(null);
  const [uploadBranchId, setUploadBranchId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [pendingUploadResult, setPendingUploadResult] = useState<{
    groupId: string;
    branchId: string;
    file: File;
    result: GroupUploadResponse;
  } | null>(null);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      await create(newGroupName.trim(), newGroupDesc.trim() || undefined);
      toast.push({ variant: "success", message: `Group "${newGroupName}" created.` });
      setShowCreateDialog(false);
      setNewGroupName("");
      setNewGroupDesc("");
      refresh();
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to create group",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  };

  const handleDeleteGroup = async (groupId: string, name: string) => {
    if (!session || !activeTenantId) return;
    if (!confirm(`Delete group "${name}" and remove all its memberships? Contacts stay.`)) return;
    try {
      await deleteGroup(session.access_token, activeTenantId, groupId);
      toast.push({ variant: "success", message: "Group deleted" });
      await refresh();
    } catch (err) {
      const e = err as Error;
      toast.push({ variant: "error", message: e.message || "Delete group failed" });
    }
  };

  const handlePreviewUpload = async () => {
    if (!uploadFile || !uploadTargetGroup || !uploadBranchId) return;
    try {
      const result = await upload(uploadTargetGroup, uploadFile, uploadBranchId, false);
      setPendingUploadResult({
        groupId: uploadTargetGroup,
        branchId: uploadBranchId,
        file: uploadFile,
        result,
      });
      setShowUploadDialog(false);
    } catch (err) {
      const e2 = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to preview upload",
        detail: e2.body ? JSON.stringify(e2.body) : e2.message,
        status: e2.status,
      });
    }
  };

  const confirmUpload = async () => {
    if (!pendingUploadResult) return;
    try {
      const result = await upload(
        pendingUploadResult.groupId,
        pendingUploadResult.file,
        pendingUploadResult.branchId,
        true,
      );
      toast.push({
        variant: "success",
        message: `Processed ${result.matched} existing, created ${result.created}, and reactivated ${result.reactivated} contacts.`,
      });
      setPendingUploadResult(null);
      setUploadTargetGroup(null);
      setUploadBranchId("");
      setUploadFile(null);
      refresh();
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to commit upload",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: "#64748B" }}>
          {groups.length > 0 ? `${groups.length} group${groups.length !== 1 ? "s" : ""}` : "No groups yet"}
        </p>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="px-4 py-2 rounded-md text-sm font-medium text-white"
          style={{ background: "#2563EB" }}
        >
          + Create Group
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-md text-sm mb-4" style={{ background: "#FEF2F2", color: "#991B1B" }}>
          Failed to load groups: {error}
        </div>
      )}
      {loading && groups.length === 0 && (
        <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>Loading…</div>
      )}

      <div className="space-y-2">
        {groups.map((g) => (
          <div
            key={g.id}
            className="flex items-center justify-between px-4 py-3 rounded-lg"
            style={{ border: "1px solid #E2E8F0", background: "#fff" }}
          >
            <div className="min-w-0">
              <div className="font-medium text-sm" style={{ color: "#0F172A" }}>{g.name}</div>
              {g.description && (
                <div className="text-xs mt-0.5" style={{ color: "#64748B" }}>{g.description}</div>
              )}
              <div className="text-xs mt-1" style={{ color: "#94A3B8" }}>
                {g.member_count} member{g.member_count !== 1 ? "s" : ""}
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <button
                onClick={() => {
                  setUploadTargetGroup(g.id);
                  setUploadBranchId("");
                  setUploadFile(null);
                  setShowUploadDialog(true);
                }}
                className="text-xs px-3 py-1.5 rounded-md font-medium"
                style={{ border: "1px solid #E2E8F0", color: "#334155" }}
              >
                Upload CSV
              </button>
              {activeMembership?.role === "tenant_admin" && (
                <button
                  onClick={() => handleDeleteGroup(g.id, g.name)}
                  className="text-red-600 text-xs hover:underline"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showUploadDialog && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 100,
          }}
        >
          <div className="rounded-lg p-6 max-w-md w-full" style={{ background: "#fff" }}>
            <h3 className="font-semibold mb-4" style={{ color: "#0F172A" }}>Upload to Group</h3>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-gray-900 mb-1">
                Target branch <span className="text-red-500">*</span>
              </label>
              <select
                value={uploadBranchId}
                onChange={(e) => setUploadBranchId(e.target.value)}
                className={`w-full border-2 rounded p-2 ${
                  !uploadBranchId ? "border-red-400 bg-red-50" : "border-gray-300"
                }`}
              >
                <option value="">Select the branch where these contacts belong</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
              {!uploadBranchId && (
                <p className="text-xs text-red-600 mt-1">
                  Choose a branch before uploading. New contacts will attach to this branch.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-1">
                CSV file <span className="text-red-500">*</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-gray-300 rounded p-3 hover:border-blue-500 hover:bg-blue-50 transition">
                <span className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded font-medium">
                  Choose file
                </span>
                <span className="text-sm text-gray-700">
                  {uploadFile ? uploadFile.name : "No file selected"}
                </span>
                <input
                  type="file"
                  accept=".csv,.txt"
                  className="hidden"
                  onChange={handleFileChosen}
                />
              </label>
              <a
                href="/samples/groups-sample.csv"
                download
                className="inline-block mt-2 text-xs text-blue-600 hover:underline"
              >
                Download sample CSV
              </a>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => {
                  setShowUploadDialog(false);
                  setUploadTargetGroup(null);
                  setUploadFile(null);
                }}
                className="px-4 py-2 rounded-md text-sm"
                style={{ border: "1px solid #E2E8F0" }}
              >
                Cancel
              </button>
              <button
                onClick={handlePreviewUpload}
                disabled={!uploadBranchId || !uploadFile || uploading}
                className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 disabled:bg-gray-400"
              >
                {uploading ? "Uploading…" : "Preview"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create group dialog */}
      {showCreateDialog && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div className="rounded-lg p-6 max-w-md w-full" style={{ background: "#fff" }}>
            <h3 className="font-semibold mb-4" style={{ color: "#0F172A" }}>Create Group</h3>
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="e.g. O-Level Students"
              className="w-full px-3 py-2 text-sm rounded-md mb-3"
              style={{ border: "1px solid #E2E8F0" }}
            />
            <textarea
              value={newGroupDesc}
              onChange={(e) => setNewGroupDesc(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full px-3 py-2 text-sm rounded-md mb-4"
              style={{ border: "1px solid #E2E8F0" }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreateDialog(false)}
                className="px-4 py-2 rounded-md text-sm"
                style={{ border: "1px solid #E2E8F0" }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={creating || !newGroupName.trim()}
                className="px-4 py-2 rounded-md text-sm font-medium text-white"
                style={{ background: creating || !newGroupName.trim() ? "#CBD5E1" : "#2563EB" }}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload preview dialog */}
      {pendingUploadResult && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div className="rounded-lg p-6 max-w-md w-full" style={{ background: "#fff" }}>
            <h3 className="font-semibold mb-4" style={{ color: "#0F172A" }}>Confirm Upload</h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4 text-sm">
              <div>
                <div style={{ color: "#64748B" }}>Created</div>
                <div className="font-semibold" style={{ color: "#2563EB" }}>{pendingUploadResult.result.created}</div>
              </div>
              <div>
                <div style={{ color: "#64748B" }}>Reactivated</div>
                <div className="font-semibold" style={{ color: "#D97706" }}>{pendingUploadResult.result.reactivated}</div>
              </div>
              <div>
                <div style={{ color: "#64748B" }}>Matched</div>
                <div className="font-semibold" style={{ color: "#16A34A" }}>{pendingUploadResult.result.matched}</div>
              </div>
              <div>
                <div style={{ color: "#64748B" }}>Already in group</div>
                <div className="font-semibold" style={{ color: "#64748B" }}>{pendingUploadResult.result.already_member}</div>
              </div>
              <div>
                <div style={{ color: "#64748B" }}>Invalid rows</div>
                <div className="font-semibold" style={{ color: "#DC2626" }}>{pendingUploadResult.result.errors.length}</div>
              </div>
            </div>
            <p className="text-xs mb-4" style={{ color: "#64748B" }}>
              New contacts will be created in the selected branch; archived contacts will be reactivated.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setPendingUploadResult(null);
                  setUploadTargetGroup(null);
                  setUploadBranchId("");
                  setUploadFile(null);
                }}
                className="px-4 py-2 rounded-md text-sm"
                style={{ border: "1px solid #E2E8F0" }}
              >
                Cancel
              </button>
              <button
                onClick={confirmUpload}
                disabled={uploading || (
                  pendingUploadResult.result.matched
                  + pendingUploadResult.result.created
                  + pendingUploadResult.result.reactivated === 0
                )}
                className="px-4 py-2 rounded-md text-sm font-medium text-white"
                style={{ background: uploading ? "#CBD5E1" : "#2563EB" }}
              >
                {uploading ? "Adding…" : `Add ${pendingUploadResult.result.matched} to group`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactsScreen() {
  const toast = useToast();
  const [search, setSearch] = useState("");

  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState<string>("");
  const [uploadBranchId, setUploadBranchId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [page, setPage] = useState(1);
  const [uploadMode, setUploadMode] = useState<"file" | "paste">("file");
  const { update: updateContact, updating } = useUpdateContact();
  const { archive: archiveContact, archiving } = useArchiveContact();
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editOptIn, setEditOptIn] = useState<"opted_in" | "opted_out" | "pending">("opted_in");
  const [pastedText, setPastedText] = useState("");
  const [activeTab, setActiveTab] = useState<"contacts" | "groups">("contacts");
  const [pendingPreview, setPendingPreview] = useState<{
    file: File;
    branchId: string;
    preview: UploadResponse;
    source: "file" | "paste";
  } | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);

  // Live parse of pasted text for the preview counter
  const parsedPastes = useMemo(
    () => (uploadMode === "paste" ? parsePastedPhones(pastedText) : []),
    [uploadMode, pastedText],
  );
  const validPastedCount = parsedPastes.filter((p) => p.status === "valid").length;
  const invalidPastedCount = parsedPastes.filter((p) => p.status === "invalid").length;

  const { branches } = useBranches();
  const selectedBranch = branchFilter || undefined;
  const pageSize = 25;
  const contactsParams = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      branchId: selectedBranch,
      page,
      pageSize,
    }),
    [debouncedSearch, selectedBranch, page, pageSize],
  );

  const { data, loading, error, refresh } = useContacts(contactsParams);
  const { upload, uploading } = useUploadContacts();

  const startEdit = (c: ContactRow) => {
    setEditingContact(c);
    setEditName(c.full_name ?? "");
    setEditOptIn(c.opt_in_status as "opted_in" | "opted_out" | "pending");
  };

  const submitEdit = async () => {
    if (!editingContact) return;
    try {
      await updateContact(editingContact.id, {
        full_name: editName.trim() || null,
        opt_in_status: editOptIn,
      });
      toast.push({ variant: "success", message: "Contact updated." });
      setEditingContact(null);
      refresh();
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to update contact",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };

  const handleArchive = async (c: ContactRow) => {
    if (!confirm(`Archive ${c.full_name ?? c.phone_e164}? This preserves campaign history but removes them from future sends.`)) return;
    try {
      await archiveContact(c.id);
      toast.push({ variant: "success", message: "Contact archived." });
      refresh();
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown };
      toast.push({
        variant: "error",
        message: "Failed to archive contact",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };

  // Debounce search (300ms) so we don't fire a request every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever the filter set changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, branchFilter]);

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  };

  const handleFilePreview = async () => {
    if (!uploadFile || !uploadBranchId) return;
    try {
      const preview = await upload(uploadFile, uploadBranchId, false);
      setPendingPreview({
        file: uploadFile,
        branchId: uploadBranchId,
        preview,
        source: "file",
      });
      setShowUploadDialog(false);
    } catch (err) {
      const ex = err as Error & { status?: number; body?: any };
      toast.push({
        variant: "error",
        message: "Upload Failed",
        detail: ex.body ? JSON.stringify(ex.body) : ex.message,
        status: ex.status,
      });
    }
  };

  const handlePasteSubmit = async () => {
    if (!uploadBranchId) return;
    if (validPastedCount === 0) {
      toast.push({ variant: "error", message: "No Valid Numbers", detail: "No valid phone numbers to import." });
      return;
    }
    const file = phonesToCsvFile(parsedPastes);
    try {
      const preview = await upload(file, uploadBranchId, false);
      setPendingPreview({ file, branchId: uploadBranchId, preview, source: "paste" });
      setShowUploadDialog(false);
      setPastedText("");
      setUploadFile(null);
    } catch (err) {
      const ex = err as Error & { status?: number; body?: any };
      toast.push({
        variant: "error",
        message: "Upload Failed",
        detail: ex.body ? JSON.stringify(ex.body) : ex.message,
        status: ex.status,
      });
    }
  };

  const confirmCommit = async () => {
    if (!pendingPreview) return;
    try {
      const result = await upload(
        pendingPreview.file,
        pendingPreview.branchId,
        true,
      );
      setUploadResult(result);
      setPendingPreview(null);
      refresh();
      toast.push({ variant: "success", message: "Import Complete", detail: `Imported ${result.valid} contacts.` });
    } catch (err) {
      const ex = err as Error & { status?: number; body?: any };
      toast.push({
        variant: "error",
        message: "Commit Failed",
        detail: ex.body ? JSON.stringify(ex.body) : ex.message,
        status: ex.status,
      });
    }
  };


  const contacts = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "#0F172A" }}>
            Contacts & Groups
          </h1>
          <p className="text-sm mt-1" style={{ color: "#64748B" }}>
            Manage your audiences
          </p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-4" style={{ borderBottom: "1px solid #E2E8F0" }}>
        <button
          onClick={() => setActiveTab("contacts")}
          className="px-4 py-2 text-sm font-medium"
          style={{
            color: activeTab === "contacts" ? "#2563EB" : "#64748B",
            borderBottom: activeTab === "contacts" ? "2px solid #2563EB" : "2px solid transparent",
            marginBottom: -1,
          }}
        >
          Contacts
        </button>
        <button
          onClick={() => setActiveTab("groups")}
          className="px-4 py-2 text-sm font-medium"
          style={{
            color: activeTab === "groups" ? "#2563EB" : "#64748B",
            borderBottom: activeTab === "groups" ? "2px solid #2563EB" : "2px solid transparent",
            marginBottom: -1,
          }}
        >
          Groups
        </button>
      </div>

      {activeTab === "groups" ? (
        <GroupsPanel />
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm" style={{ color: "#64748B" }}>
              {`${total.toLocaleString()} total contacts`}
            </p>
            <button
              onClick={() => {
                setUploadBranchId("");
                setUploadFile(null);
                setShowUploadDialog(true);
              }}
              disabled={branches.length === 0}
              className="px-4 py-2 rounded-md text-sm font-medium text-white flex items-center gap-2"
              style={{
                background: branches.length === 0 ? "#CBD5E1" : "#2563EB",
                cursor: branches.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              <Upload size={16} />
              Import Contacts
            </button>
          </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: "#94A3B8" }}
          />
          <input
            type="text"
            placeholder="Search by name or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-3 py-2 text-sm rounded-md outline-none"
            style={{ border: "1px solid #E2E8F0", background: "#fff" }}
          />
        </div>
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md outline-none"
          style={{ border: "1px solid #E2E8F0", background: "#fff" }}
        >
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {/* Upload result banner */}
      {uploadResult && (
        <div
          className="mb-4 p-3 rounded-md text-sm flex items-start justify-between"
          style={{
            background: uploadResult.valid > 0 ? "#F0FDF4" : "#FEFCE8",
            border: `1px solid ${uploadResult.valid > 0 ? "#BBF7D0" : "#FEF08A"}`,
            color: uploadResult.valid > 0 ? "#166534" : "#854D0E",
          }}
        >
          <span>
            {uploadResult.valid > 0 && (
              <>
                Imported <strong>{uploadResult.valid}</strong> new contact{uploadResult.valid !== 1 && "s"}.
              </>
            )}
            {uploadResult.invalid > 0 && (
              <>
                {" "}
                {uploadResult.invalid} {uploadResult.valid > 0 ? "skipped" : "not imported"} (already exist or invalid format).
              </>
            )}
            {uploadResult.skipped_empty > 0 &&
              ` ${uploadResult.skipped_empty} empty rows skipped.`}
          </span>
          <button onClick={() => setUploadResult(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Table */}
      <div
        className="rounded-lg overflow-hidden"
        style={{ border: "1px solid #E2E8F0", background: "#fff" }}
      >
        {error && (
          <div className="p-4 text-sm" style={{ color: "#B91C1C" }}>
            Failed to load contacts: {error}
          </div>
        )}
        {loading && !data && (
          <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>
            Loading contacts…
          </div>
        )}
        {!loading && contacts.length === 0 && !error && (
          <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>
            No contacts match these filters. Import a CSV to get started.
          </div>
        )}
        {contacts.length > 0 && (
          <table className="w-full text-sm">
            <thead style={{ background: "#F8FAFC" }}>
              <tr>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Name</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Phone</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Branch</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Opt-in</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Source</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Added</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                  <td className="px-4 py-2" style={{ color: "#0F172A" }}>
                    {c.full_name ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: "#334155" }}>
                    {c.phone_e164}
                  </td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>
                    {c.branch_name ?? "—"}
                  </td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>
                    {c.opt_in_status}
                  </td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>
                    {c.source}
                  </td>
                  <td className="px-4 py-2" style={{ color: "#64748B" }}>
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <button
                        onClick={() => startEdit(c)}
                        className="text-xs px-2 py-1 rounded-md"
                        style={{ border: "1px solid #E2E8F0", color: "#334155" }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleArchive(c)}
                        disabled={archiving}
                        className="text-xs px-2 py-1 rounded-md"
                        style={{ border: "1px solid #FECACA", color: "#B91C1C" }}
                      >
                        Archive
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > 25 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <span style={{ color: "#64748B" }}>
            Page {page} of {totalPages} — {total.toLocaleString()} total
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 rounded-md"
              style={{
                border: "1px solid #E2E8F0",
                background: "#fff",
                color: page === 1 ? "#CBD5E1" : "#0F172A",
                cursor: page === 1 ? "not-allowed" : "pointer",
              }}
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1 rounded-md"
              style={{
                border: "1px solid #E2E8F0",
                background: "#fff",
                color: page >= totalPages ? "#CBD5E1" : "#0F172A",
                cursor: page >= totalPages ? "not-allowed" : "pointer",
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Upload mode chooser dialog */}
      {showUploadDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 100,
          }}
        >
          <div
            className="rounded-lg max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            style={{ background: "#fff" }}
          >
            <div
              className="p-4 flex items-center justify-between"
              style={{ borderBottom: "1px solid #E2E8F0" }}
            >
              <h2 className="font-semibold" style={{ color: "#0F172A" }}>
                Import Contacts
              </h2>
              <button
                onClick={() => {
                  setShowUploadDialog(false);
                  setPastedText("");
                  setUploadFile(null);
                  setUploadBranchId("");
                }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Mode tabs */}
            <div className="flex gap-1 px-4 pt-3" style={{ borderBottom: "1px solid #E2E8F0" }}>
              <button
                onClick={() => setUploadMode("file")}
                className="px-3 py-2 text-sm font-medium"
                style={{
                  color: uploadMode === "file" ? "#2563EB" : "#64748B",
                  borderBottom: uploadMode === "file" ? "2px solid #2563EB" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                Upload CSV file
              </button>
              <button
                onClick={() => setUploadMode("paste")}
                className="px-3 py-2 text-sm font-medium"
                style={{
                  color: uploadMode === "paste" ? "#2563EB" : "#64748B",
                  borderBottom: uploadMode === "paste" ? "2px solid #2563EB" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                Paste phone numbers
              </button>
            </div>

            <div className="p-4 flex-1 overflow-y-auto">
              <div className="mb-4">
                <label className="block text-sm font-semibold text-gray-900 mb-1">
                  Target branch <span className="text-red-500">*</span>
                </label>
                <select
                  value={uploadBranchId}
                  onChange={(e) => setUploadBranchId(e.target.value)}
                  className={`w-full border-2 rounded p-2 ${
                    !uploadBranchId ? "border-red-400 bg-red-50" : "border-gray-300"
                  }`}
                >
                  <option value="">Select the branch where these contacts belong</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
                {!uploadBranchId && (
                  <p className="text-xs text-red-600 mt-1">
                    Choose a branch before uploading. New contacts will attach to this branch.
                  </p>
                )}
              </div>
              {uploadMode === "file" && (
                <div>
                  <p className="text-sm mb-4" style={{ color: "#475569" }}>
                    CSV with a <code>phone</code> column (also accepts <code>phone_number</code>, <code>mobile</code>, <code>contact</code>). Optional columns:{" "}
                    <code>name</code>, <code>segment</code>.
                  </p>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1">
                      CSV file <span className="text-red-500">*</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-gray-300 rounded p-3 hover:border-blue-500 hover:bg-blue-50 transition">
                      <span className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded font-medium">
                        Choose file
                      </span>
                      <span className="text-sm text-gray-700">
                        {uploadFile ? uploadFile.name : "No file selected"}
                      </span>
                      <input
                        type="file"
                        accept=".csv,.txt"
                        className="hidden"
                        onChange={handleFileChosen}
                      />
                    </label>
                    <a
                      href="/samples/contacts-sample.csv"
                      download
                      className="inline-block mt-2 text-xs text-blue-600 hover:underline"
                    >
                      Download sample CSV
                    </a>
                  </div>
                </div>
              )}

              {uploadMode === "paste" && (
                <div>
                  <p className="text-sm mb-3" style={{ color: "#475569" }}>
                    Paste phone numbers, one per line. Any format works — we'll normalize to E.164.
                  </p>
                  <textarea
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    placeholder={`+92 300 1234567\n03001234567\n(212) 555-0100\n...`}
                    rows={10}
                    className="w-full px-3 py-2 text-sm font-mono rounded-md outline-none"
                    style={{
                      border: "1px solid #E2E8F0",
                      background: "#fff",
                      color: "#0F172A",
                      resize: "vertical",
                    }}
                  />
                  {pastedText.trim() && (
                    <div className="mt-3 flex gap-4 text-xs">
                      <span style={{ color: "#16A34A" }}>
                        <strong>{validPastedCount}</strong> valid
                      </span>
                      {invalidPastedCount > 0 && (
                        <span style={{ color: "#DC2626" }}>
                          <strong>{invalidPastedCount}</strong> invalid or duplicate
                        </span>
                      )}
                    </div>
                  )}
                  {invalidPastedCount > 0 && (
                    <details className="mt-2 text-xs">
                      <summary style={{ cursor: "pointer", color: "#64748B" }}>
                        Show rejected lines
                      </summary>
                      <div className="mt-2 max-h-32 overflow-y-auto">
                        {parsedPastes
                          .filter((p) => p.status === "invalid")
                          .slice(0, 20)
                          .map((p, i) => (
                            <div key={i} className="flex gap-2 py-0.5">
                              <span className="font-mono" style={{ color: "#334155" }}>
                                {p.raw.trim() || "(empty)"}
                              </span>
                              <span style={{ color: "#DC2626" }}>— {p.reason}</span>
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div
              className="p-4 flex justify-end gap-2"
              style={{ borderTop: "1px solid #E2E8F0" }}
            >
              <button
                onClick={() => {
                  setShowUploadDialog(false);
                  setPastedText("");
                  setUploadFile(null);
                  setUploadBranchId("");
                }}
                className="px-4 py-2 rounded-md text-sm"
                style={{ border: "1px solid #E2E8F0", background: "#fff", color: "#0F172A" }}
              >
                Cancel
              </button>
              <button
                onClick={uploadMode === "paste" ? handlePasteSubmit : handleFilePreview}
                disabled={
                  !uploadBranchId
                  || uploading
                  || (uploadMode === "paste" ? validPastedCount === 0 : !uploadFile)
                }
                className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 disabled:bg-gray-400"
                style={{
                  cursor: uploading || !uploadBranchId
                    || (uploadMode === "paste" ? validPastedCount === 0 : !uploadFile)
                    ? "not-allowed"
                    : "pointer",
                }}
              >
                {uploading
                  ? "Uploading…"
                  : uploadMode === "paste"
                    ? `Preview ${validPastedCount} phones`
                    : "Preview"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview dialog — shown after upload preview succeeds, before commit */}
      {pendingPreview && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 100,
          }}
        >
          <div
            className="rounded-lg max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            style={{ background: "#fff" }}
          >
            <div
              className="p-4 flex items-center justify-between"
              style={{ borderBottom: "1px solid #E2E8F0" }}
            >
              <h2 className="font-semibold" style={{ color: "#0F172A" }}>
                CSV Import Preview
              </h2>
              <button onClick={() => setPendingPreview(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-4 gap-3 mb-4 text-sm">
                <div>
                  <div style={{ color: "#64748B" }}>Total rows</div>
                  <div className="font-semibold" style={{ color: "#0F172A" }}>
                    {pendingPreview.preview.total_rows}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748B" }}>Valid</div>
                  <div className="font-semibold" style={{ color: "#16A34A" }}>
                    {pendingPreview.preview.valid}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748B" }}>Invalid</div>
                  <div className="font-semibold" style={{ color: "#DC2626" }}>
                    {pendingPreview.preview.invalid}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748B" }}>Empty skipped</div>
                  <div className="font-semibold" style={{ color: "#64748B" }}>
                    {pendingPreview.preview.skipped_empty}
                  </div>
                </div>
              </div>

              {pendingPreview.preview.preview_rows.length > 0 && (
                <div className="mb-4">
                  <div
                    className="text-xs uppercase font-medium mb-2"
                    style={{ color: "#64748B" }}
                  >
                    First {pendingPreview.preview.preview_rows.length} valid rows
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="text-left py-1" style={{ color: "#475569" }}>
                          Row
                        </th>
                        <th className="text-left py-1" style={{ color: "#475569" }}>
                          Phone
                        </th>
                        <th className="text-left py-1" style={{ color: "#475569" }}>
                          Name
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingPreview.preview.preview_rows.map((r) => (
                        <tr key={r.row}>
                          <td className="py-1" style={{ color: "#64748B" }}>
                            {r.row}
                          </td>
                          <td className="py-1 font-mono" style={{ color: "#334155" }}>
                            {r.phone_e164}
                          </td>
                          <td className="py-1" style={{ color: "#334155" }}>
                            {r.full_name ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {pendingPreview.preview.errors.length > 0 && (
                <div>
                  <div
                    className="text-xs uppercase font-medium mb-2"
                    style={{ color: "#DC2626" }}
                  >
                    Rejected rows (first {Math.min(10, pendingPreview.preview.errors.length)})
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {pendingPreview.preview.errors.slice(0, 10).map((e, i) => (
                        <tr key={i}>
                          <td className="py-1" style={{ color: "#64748B" }}>
                            Row {e.row}
                          </td>
                          <td className="py-1 font-mono" style={{ color: "#334155" }}>
                            {e.phone_raw ?? "(empty)"}
                          </td>
                          <td className="py-1" style={{ color: "#DC2626" }}>
                            {e.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div
              className="p-4 flex justify-end gap-2"
              style={{ borderTop: "1px solid #E2E8F0" }}
            >
              <button
                onClick={() => setPendingPreview(null)}
                className="px-4 py-2 rounded-md text-sm"
                style={{
                  border: "1px solid #E2E8F0",
                  background: "#fff",
                  color: "#0F172A",
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmCommit}
                disabled={uploading || pendingPreview.preview.valid === 0}
                className="px-4 py-2 rounded-md text-sm font-medium text-white"
                style={{
                  background:
                    uploading || pendingPreview.preview.valid === 0
                      ? "#CBD5E1"
                      : "#2563EB",
                  cursor:
                    uploading || pendingPreview.preview.valid === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {uploading
                  ? "Importing…"
                  : `Import ${pendingPreview.preview.valid} contacts`}
              </button>
            </div>
          </div>
        </div>
      )}
      {editingContact && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <div className="rounded-lg p-6 max-w-md w-full" style={{ background: "#fff" }}>
            <h3 className="font-semibold mb-4" style={{ color: "#0F172A" }}>Edit Contact</h3>
            <p className="text-xs mb-3 font-mono" style={{ color: "#64748B" }}>{editingContact.phone_e164}</p>

            <label className="text-xs font-medium block mb-1" style={{ color: "#334155" }}>Full name</label>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="(no name)"
              className="w-full px-3 py-2 text-sm rounded-md mb-3"
              style={{ border: "1px solid #E2E8F0" }}
            />

            <label className="text-xs font-medium block mb-1" style={{ color: "#334155" }}>Opt-in status</label>
            <select
              value={editOptIn}
              onChange={(e) => setEditOptIn(e.target.value as typeof editOptIn)}
              className="w-full px-3 py-2 text-sm rounded-md mb-4"
              style={{ border: "1px solid #E2E8F0", background: "#fff" }}
            >
              <option value="opted_in">Opted in</option>
              <option value="opted_out">Opted out</option>
              <option value="pending">Pending</option>
            </select>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditingContact(null)}
                className="px-4 py-2 rounded-md text-sm"
                style={{ border: "1px solid #E2E8F0" }}
              >
                Cancel
              </button>
              <button
                onClick={submitEdit}
                disabled={updating}
                className="px-4 py-2 rounded-md text-sm font-medium text-white"
                style={{ background: updating ? "#CBD5E1" : "#2563EB" }}
              >
                {updating ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ─── Screen 3+4: Placeholders for Campaign & Logs (still mock, banner shows) ─

function BroadcastsScreen() {
  const [view, setView] = useState<"list" | "create">("list");
  const { session, activeTenantId } = useAuth();
  const { data, loading, error, refresh } = useBroadcasts({ page: 1, page_size: 50 });
  const { send, sending } = useSendBroadcast();
  const { cancel, canceling } = useCancelBroadcast();
  const toast=useToast();
  const handleDeleteDraft = async (broadcastId: string, name: string) => {
    if (!session || !activeTenantId) return;
    if (!confirm(`Delete draft "${name}"? This cannot be undone.`)) return;
    try {
      await deleteBroadcast(session.access_token, activeTenantId, broadcastId);
      toast.push({ variant: "success", message: "Draft deleted" });
      await refresh();
    } catch (err) {
      const e = err as Error;
      toast.push({ variant: "error", message: e.message || "Delete draft failed" });
    }
  };

    const handleSend = async (broadcastId: string) => {
    if (!confirm("Send this broadcast now? This cannot be undone.")) return;
    try {
      const result = await send(broadcastId);
      refresh();
      toast.push({ variant: "success", message: "Broadcast Queued", detail: `Campaign ID: ${result.campaign_id}` });
    } catch (err) {
      const e = err as Error & { status?: number; body?: any };
      toast.push({
        variant: "error",
        message: "Send Failed",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };

  const handleCancel = async (broadcastId: string) => {
    if (!confirm("Cancel this broadcast? Messages already sent cannot be recalled — this only stops further sending.")) return;
    try {
      await cancel(broadcastId);
      refresh();
      toast.push({ variant: "success", message: "Broadcast Canceled", detail: "Stopped further sending." });
    } catch (err) {
      const e = err as Error & { status?: number; body?: any };
      toast.push({
        variant: "error",
        message: "Cancel Failed",
        detail: e.body ? JSON.stringify(e.body) : e.message,
        status: e.status,
      });
    }
  };


  if (view === "create") {
    return <BroadcastCreateForm onDone={() => { setView("list"); refresh(); }} onCancel={() => setView("list")} />;
  }

  const broadcasts = data?.data ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "#0F172A" }}>Broadcast Campaigns</h1>
          <p className="text-sm mt-1" style={{ color: "#64748B" }}>
            {data ? `${data.pagination.total} total` : "Loading…"}
          </p>
        </div>
        <button
          onClick={() => setView("create")}
          className="px-4 py-2 rounded-md text-sm font-medium text-white"
          style={{ background: "#2563EB", cursor: "pointer" }}
        >
          + Create Campaign
        </button>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #E2E8F0", background: "#fff" }}>
        {error && <div className="p-4 text-sm" style={{ color: "#B91C1C" }}>Failed to load: {error}</div>}
        {loading && !data && <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>Loading…</div>}
        {!loading && broadcasts.length === 0 && !error && (
          <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>
            No campaigns yet. Click "Create Campaign" to get started.
          </div>
        )}
        {broadcasts.length > 0 && (
          <table className="w-full text-sm">
            <thead style={{ background: "#F8FAFC" }}>
              <tr>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Name</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Branch</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Template</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Recipients</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Status</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Created</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b) => (
                <tr key={b.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                  <td className="px-4 py-2" style={{ color: "#0F172A" }}>{b.name}</td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>{b.branch_name}</td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: "#334155" }}>{b.template_name}</td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>{b.recipient_count}</td>
                  <td className="px-4 py-2">
                    <span
                      className="px-2 py-0.5 text-xs rounded-full font-medium"
                     style={{
  background:
    b.status === "completed" ? "#DCFCE7" :
    b.status === "running" || b.status === "queued" ? "#FEF3C7" :
    b.status === "failed" ? "#FEE2E2" :
    b.status === "draft" ? "#E0E7FF" : "#F1F5F9",
  color:
    b.status === "completed" ? "#166534" :
    b.status === "running" || b.status === "queued" ? "#92400E" :
    b.status === "failed" ? "#991B1B" :
    b.status === "draft" ? "#3730A3" : "#475569",
}}
                    >
                      {b.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs" style={{ color: "#64748B" }}>
                    {new Date(b.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {(b.status === "draft" || b.status === "scheduled") && (
                      <button
                        onClick={() => handleSend(b.id)}
                        disabled={sending}
                        className="text-xs px-3 py-1 rounded-md text-white font-medium"
                        style={{ background: sending ? "#CBD5E1" : "#2563EB" }}
                      >
                        {sending ? "Sending…" : "Send Now"}
                      </button>
                    )}
                    {(b.status === "queued" || b.status === "running") && (
                      <button
                        onClick={() => handleCancel(b.id)}
                        disabled={canceling}
                        className="text-xs px-3 py-1 rounded-md font-medium ml-2"
                        style={{ background: canceling ? "#CBD5E1" : "#FEE2E2", color: "#991B1B" }}
                      >
                        {canceling ? "Canceling…" : "Cancel"}
                      </button>
                    )}
                    {b.status === "draft" && (
                      <button
                        onClick={() => handleDeleteDraft(b.id, b.name)}
                        className="text-red-600 text-xs hover:underline ml-2"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PlatformCreateTenantScreen({ onDone }: { onDone: () => void }) {
  const { session, me, setActiveTenantId } = useAuth();
  const toast = useToast();

  const [tenantName, setTenantName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [metaWabaId, setMetaWabaId] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [useOwnToken, setUseOwnToken] = useState(false);
  const [accessToken, setAccessToken] = useState('');

  type PhoneRow = { meta_phone_number_id: string; display_phone_number: string; is_test_number: boolean };
  const [phones, setPhones] = useState<PhoneRow[]>([
    { meta_phone_number_id: '', display_phone_number: '', is_test_number: false },
  ]);

  type BranchDraft = { name: string; branch_type: 'physical' | 'virtual' };
  const [branches, setBranches] = useState<BranchDraft[]>([{ name: 'Main Office', branch_type: 'physical' }]);

  const [busy, setBusy] = useState(false);

  if (!me?.is_platform_admin) {
    return <div className="p-6">Platform admin only.</div>;
  }

  const canSubmit = Boolean(
    tenantName.trim() && adminEmail.trim() && metaWabaId.trim() && businessName.trim()
    && phones.length > 0 && phones.every(p => p.meta_phone_number_id.trim() && p.display_phone_number.trim())
    && (!useOwnToken || accessToken.trim())
  );

  async function submit() {
    if (!session || !canSubmit) return;
    setBusy(true);
    try {
      const payload: TenantCreatePayload = {
        tenant_name: tenantName.trim(),
        admin_email: adminEmail.trim().toLowerCase(),
        meta_waba_id: metaWabaId.trim(),
        business_name: businessName.trim(),
        waba_access_token: useOwnToken ? accessToken.trim() : null,
        phone_numbers: phones.map(p => ({
          meta_phone_number_id: p.meta_phone_number_id.trim(),
          display_phone_number: p.display_phone_number.trim(),
          is_test_number: p.is_test_number,
        })),
        branches: branches.filter(b => b.name.trim()).map(b => ({
          name: b.name.trim(), branch_type: b.branch_type,
        })),
      };
      const res = await createTenant(session.access_token, payload);
      toast.push({
        variant: res.invite_status === 'sent' ? 'success' : 'warning' as any,
        message: `Tenant created. Invite ${res.invite_status === 'sent' ? 'sent' : 'FAILED (' + res.invite_status + ')'}.`,
      });
      setActiveTenantId(res.tenant_id);
      onDone();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Create tenant failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Onboard a new tenant</h1>

      <section className="bg-white border rounded p-4 space-y-3">
        <h2 className="font-medium">Tenant</h2>
        <input className="w-full border rounded p-2" placeholder="Tenant name (e.g. Alpha Education)"
               value={tenantName} onChange={e => setTenantName(e.target.value)} />
      </section>

      <section className="bg-white border rounded p-4 space-y-3">
        <h2 className="font-medium">First admin</h2>
        <input type="email" className="w-full border rounded p-2"
               placeholder="admin@customer.com"
               value={adminEmail} onChange={e => setAdminEmail(e.target.value)} />
        <p className="text-xs text-gray-500">An invite email will be sent. They set a password and land as tenant_admin.</p>
      </section>

      <section className="bg-white border rounded p-4 space-y-3">
        <h2 className="font-medium">WhatsApp Business Account</h2>
        <input className="w-full border rounded p-2" placeholder="meta_waba_id"
               value={metaWabaId} onChange={e => setMetaWabaId(e.target.value)} />
        <input className="w-full border rounded p-2" placeholder="Business name shown in WhatsApp"
               value={businessName} onChange={e => setBusinessName(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useOwnToken} onChange={e => setUseOwnToken(e.target.checked)} />
          Customer brings their own access token (BYOW)
        </label>
        {useOwnToken && (
          <input type="password" className="w-full border rounded p-2 font-mono"
                 placeholder="WABA access token"
                 value={accessToken} onChange={e => setAccessToken(e.target.value)} />
        )}
      </section>

      <section className="bg-white border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Phone numbers</h2>
          <button type="button"
                  onClick={() => setPhones([...phones, { meta_phone_number_id: '', display_phone_number: '', is_test_number: false }])}
                  className="text-sm text-blue-600 hover:underline">
            + Add phone
          </button>
        </div>
        {phones.map((p, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <input className="col-span-5 border rounded p-2" placeholder="+923001234567"
                   value={p.display_phone_number}
                   onChange={e => setPhones(phones.map((x, j) => j === i ? { ...x, display_phone_number: e.target.value } : x))} />
            <input className="col-span-5 border rounded p-2 font-mono text-xs" placeholder="meta_phone_number_id"
                   value={p.meta_phone_number_id}
                   onChange={e => setPhones(phones.map((x, j) => j === i ? { ...x, meta_phone_number_id: e.target.value } : x))} />
            <label className="col-span-1 flex items-center gap-1 text-xs">
              <input type="checkbox" checked={p.is_test_number}
                     onChange={e => setPhones(phones.map((x, j) => j === i ? { ...x, is_test_number: e.target.checked } : x))} />
              Test
            </label>
            <button type="button" disabled={phones.length === 1}
                    onClick={() => setPhones(phones.filter((_, j) => j !== i))}
                    className="col-span-1 text-red-600 text-sm disabled:text-gray-300">✕</button>
          </div>
        ))}
      </section>

      <section className="bg-white border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Branches (optional, admin can add later)</h2>
          <button type="button"
                  onClick={() => setBranches([...branches, { name: '', branch_type: 'physical' }])}
                  className="text-sm text-blue-600 hover:underline">
            + Add branch
          </button>
        </div>
        {branches.map((b, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <input className="col-span-9 border rounded p-2" placeholder="Branch name"
                   value={b.name}
                   onChange={e => setBranches(branches.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <select className="col-span-2 border rounded p-2"
                    value={b.branch_type}
                    onChange={e => setBranches(branches.map((x, j) => j === i ? { ...x, branch_type: e.target.value as 'physical' | 'virtual' } : x))}>
              <option value="physical">Physical</option>
              <option value="virtual">Virtual</option>
            </select>
            <button type="button"
                    onClick={() => setBranches(branches.filter((_, j) => j !== i))}
                    className="col-span-1 text-red-600 text-sm">✕</button>
          </div>
        ))}
      </section>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onDone} className="px-4 py-2 border rounded">Cancel</button>
        <button onClick={submit} disabled={!canSubmit || busy}
                className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
          {busy ? 'Provisioning…' : 'Create tenant & send invite'}
        </button>
      </div>
    </div>
  );
}

function BranchesScreen() {
  const { session, activeTenantId, activeMembership, me } = useAuth();
  const { branches, loading, error } = useBranches();
  const toast = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'physical' | 'virtual'>('physical');
  const [busy, setBusy] = useState(false);

  const isAdmin = activeMembership?.role === 'tenant_admin' || Boolean(me?.is_platform_admin);
  const activeCount = branches.filter((b) => b.status !== 'archived').length;

  async function refresh() {
    window.location.reload();
  }

  async function doAdd() {
    if (!session || !activeTenantId || !newName.trim()) return;
    setBusy(true);
    try {
      await createBranch(session.access_token, activeTenantId, { name: newName.trim(), branch_type: newType });
      toast.push({ variant: 'success', message: 'Branch added' });
      setShowAdd(false);
      setNewName('');
      await refresh();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Add branch failed' });
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(id: string, name: string) {
    if (!session || !activeTenantId) return;
    if (activeCount <= 1) {
      toast.push({ variant: 'error', message: 'Cannot delete the last active branch.' });
      return;
    }
    if (!confirm(`Archive branch "${name}"?`)) return;
    try {
      await deleteBranch(session.access_token, activeTenantId, id);
      toast.push({ variant: 'success', message: 'Branch archived' });
      await refresh();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Archive failed' });
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Branches</h2>
        {isAdmin && (
          <button onClick={() => setShowAdd(true)}
                  className="px-3 py-2 bg-blue-600 text-white rounded text-sm">
            + Add branch
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <table className="w-full border rounded bg-white">
          <thead className="bg-gray-50 text-left text-sm">
            <tr>
              <th className="p-2">Name</th><th className="p-2">Type</th>
              <th className="p-2">Status</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b.id} className="border-t text-sm">
                <td className="p-2">{b.name}</td>
                <td className="p-2">{b.branch_type}</td>
                <td className="p-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    b.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'
                  }`}>{b.status || 'active'}</span>
                </td>
                <td className="p-2 text-right">
                  {isAdmin && (
                    <button onClick={() => doDelete(b.id, b.name)}
                            disabled={activeCount <= 1}
                            className="text-red-600 text-xs hover:underline disabled:text-gray-300">
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <div className="text-red-600 text-sm mt-3">{error}</div>}

      {showAdd && isAdmin && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
          <div className="bg-white p-6 rounded shadow-lg w-96 space-y-3">
            <h3 className="font-semibold">Add a branch</h3>
            <input className="w-full border rounded p-2"
                   placeholder="Branch name"
                   value={newName} onChange={e => setNewName(e.target.value)} />
            <select className="w-full border rounded p-2"
                    value={newType} onChange={e => setNewType(e.target.value as 'physical' | 'virtual')}>
              <option value="physical">Physical</option>
              <option value="virtual">Virtual</option>
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAdd(false)} className="px-3 py-1 border rounded">Cancel</button>
              <button onClick={doAdd} disabled={busy || !newName.trim()}
                      className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50">
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UsersScreen() {
  const { session, activeTenantId } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'tenant_admin' | 'tenant_user'>('tenant_user');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function refresh() {
    if (!session?.access_token || !activeTenantId) return;
    setLoading(true);
    try {
      setUsers(await listUsers(session.access_token, activeTenantId));
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Load failed' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [session?.access_token, activeTenantId]);

  async function doInvite() {
    if (!inviteEmail.trim() || !session?.access_token || !activeTenantId) return;
    setBusy(true);
    try {
      await inviteUser(session.access_token, activeTenantId, inviteEmail.trim(), inviteRole);
      toast.push({ variant: 'success', message: `Invite sent to ${inviteEmail}` });
      setShowInvite(false);
      setInviteEmail('');
      await refresh();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Invite failed' });
    } finally {
      setBusy(false);
    }
  }

  async function doRoleChange(id: string, role: 'tenant_admin' | 'tenant_user') {
    if (!session?.access_token || !activeTenantId) return;
    try {
      await updateUserRole(session.access_token, activeTenantId, id, role);
      await refresh();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Role update failed' });
    }
  }

  async function doRemove(id: string, email: string) {
    if (!session?.access_token || !activeTenantId) return;
    if (!confirm(`Suspend ${email}?`)) return;
    try {
      await removeUser(session.access_token, activeTenantId, id);
      await refresh();
    } catch (e: any) {
      toast.push({ variant: 'error', message: e.message || 'Remove failed' });
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold" style={{ color: '#0F172A' }}>Users</h2>
        <button
          onClick={() => setShowInvite(true)}
          className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          + Invite user
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#64748B' }}>Loading…</div>
      ) : (
        <table className="w-full border rounded" style={{ background: '#fff', borderColor: '#E2E8F0' }}>
          <thead className="bg-gray-50 text-left text-sm" style={{ background: '#F8FAFC' }}>
            <tr>
              <th className="p-2">Email</th>
              <th className="p-2">Role</th>
              <th className="p-2">Status</th>
              <th className="p-2">Invited</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t text-sm" style={{ borderTopColor: '#E2E8F0' }}>
                <td className="p-2">{u.email}</td>
                <td className="p-2">
                  <select
                    value={u.role}
                    onChange={(e) => doRoleChange(u.id, e.target.value as 'tenant_admin' | 'tenant_user')}
                    className="border rounded p-1"
                    style={{ borderColor: '#E2E8F0', background: '#fff' }}
                  >
                    <option value="tenant_user">User</option>
                    <option value="tenant_admin">Admin</option>
                  </select>
                </td>
                <td className="p-2">
                  <span
                    className="px-2 py-0.5 rounded text-xs"
                    style={{
                      background:
                        u.status === 'active' ? '#DCFCE7' :
                        u.status === 'invited' ? '#FEF3C7' : '#E2E8F0',
                      color:
                        u.status === 'active' ? '#166534' :
                        u.status === 'invited' ? '#92400E' : '#475569',
                    }}
                  >
                    {u.status}
                  </span>
                </td>
                <td className="p-2 text-gray-500">{u.invited_at ? new Date(u.invited_at).toLocaleDateString() : '-'}</td>
                <td className="p-2 text-right">
                  {u.status !== 'suspended' && (
                    <button onClick={() => doRemove(u.id, u.email)} className="text-red-600 text-xs hover:underline">
                      Suspend
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showInvite && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
          <div className="bg-white p-6 rounded shadow-lg w-96 space-y-3">
            <h3 className="font-semibold">Invite a user</h3>
            <input
              type="email"
              placeholder="colleague@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="w-full border rounded p-2"
              style={{ borderColor: '#E2E8F0' }}
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'tenant_admin' | 'tenant_user')}
              className="w-full border rounded p-2"
              style={{ borderColor: '#E2E8F0', background: '#fff' }}
            >
              <option value="tenant_user">Tenant user (can run campaigns)</option>
              <option value="tenant_admin">Tenant admin (full access)</option>
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowInvite(false)} className="px-3 py-1 border rounded">
                Cancel
              </button>
              <button
                onClick={doInvite}
                disabled={busy || !inviteEmail}
                className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplatesScreen() {
  const { session, activeTenantId } = useAuth();
  const { templates, loading, error, refetch: refetchTemplates } = useTemplates();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();
  const statusStyle = (status: string) => ({
    background: status === "approved" ? "#DCFCE7" : status === "pending" ? "#FEF3C7" : "#FEE2E2",
    color: status === "approved" ? "#166534" : status === "pending" ? "#92400E" : "#991B1B",
  });

  async function handleSync() {
    if (!session || !activeTenantId) return;
    setSyncing(true);
    try {
      const summary = await syncTemplatesFromMeta(session.access_token, activeTenantId);
      const parts: string[] = [];
      if (summary.created) parts.push(`${summary.created} new`);
      if (summary.updated) parts.push(`${summary.updated} updated`);
      if (summary.unchanged) parts.push(`${summary.unchanged} unchanged`);
      toast.push({
        variant: "success",
        message: `Templates synced: ${parts.join(", ") || "nothing to update"}`,
      });
      if (summary.errors.length) {
        toast.push({
          variant: "info",
          message: `Partial errors: ${summary.errors[0]}`,
        });
      }
      await refetchTemplates();
    } catch (e: any) {
      toast.push({
        variant: "error",
        message: `Sync failed: ${e.message || e}`,
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "#0F172A" }}>Message Templates</h1>
          <p className="text-sm mt-1" style={{ color: "#64748B" }}>
            {templates.length > 0 ? `${templates.length} template${templates.length !== 1 ? "s" : ""}` : "Loading…"}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {syncing ? "Syncing…" : "Sync from Meta"}
        </button>
      </div>
      {error && (
        <div className="p-4 rounded-md text-sm mb-4" style={{ background: "#FEF2F2", color: "#991B1B", border: "1px solid #FECACA" }}>
          Failed to load templates: {error}
        </div>
      )}
      {loading && templates.length === 0 && (
        <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>Loading templates…</div>
      )}
      {!loading && templates.length === 0 && !error && (
        <div className="p-8 text-center text-sm rounded-lg" style={{ background: "#F8FAFC", color: "#64748B", border: "1px solid #E2E8F0" }}>
          No templates yet. Templates are created and approved in Meta's WhatsApp Manager, then registered here.
        </div>
      )}
      <div className="space-y-3">
        {templates.map((t) => {
          const isOpen = expandedId === t.id;
          const varCount = t.variable_definitions?.length ?? 0;
          return (
            <div
              key={t.id}
              className="rounded-lg overflow-hidden"
              style={{ border: "1px solid #E2E8F0", background: "#fff" }}
            >
              <button
                onClick={() => setExpandedId(isOpen ? null : t.id)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
                style={{ cursor: "pointer" }}
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-sm" style={{ color: "#0F172A" }}>{t.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={statusStyle(t.status)}>
                    {t.status}
                  </span>
                  <span className="text-xs" style={{ color: "#94A3B8" }}>{t.language_code}</span>
                  <span className="text-xs" style={{ color: "#94A3B8" }}>{t.category}</span>
                </div>
                <div className="flex items-center gap-3">
                  {varCount > 0 && (
                    <span className="text-xs" style={{ color: "#64748B" }}>
                      {varCount} variable{varCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  <span style={{ color: "#94A3B8", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                    ▾
                  </span>
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-4" style={{ borderTop: "1px solid #F1F5F9" }}>
                  <div
                    className="mt-3 p-3 rounded-md text-sm whitespace-pre-wrap"
                    style={{ background: "#F8FAFC", color: "#334155", lineHeight: 1.6 }}
                  >
                    {renderTemplateBody(t.body_text)}
                  </div>
                  {varCount > 0 && (
                    <div className="mt-3">
                      <div className="text-xs uppercase font-medium mb-2" style={{ color: "#94A3B8" }}>
                        Variables
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {t.variable_definitions.map((v: any, i: number) => {
                          const key = v.name ?? v.index ?? i + 1;
                          return (
                            <span
                              key={i}
                              className="text-xs px-2 py-1 rounded font-mono"
                              style={{ background: "#EFF6FF", color: "#1E40AF" }}
                              title={v.description || ""}
                            >
                              {"{{"}{key}{"}}"} {v.example ? `— e.g. "${v.example}"` : ""}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
// Highlights {{variable}} placeholders subtly within body text — soft
// background, not garish, matches the app's restrained visual language.
function renderTemplateBody(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span key={i} style={{ background: "#DBEAFE", color: "#1E40AF", borderRadius: 3, padding: "0 3px" }}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function MessagesScreen() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const { data, kpis, loading, error } = useMessages({
    page, page_size: 50, status: statusFilter || undefined,
  });

  const statusBadge = (s: string) => {
    const map: Record<string, { bg: string; fg: string }> = {
      sent:      { bg: "#DBEAFE", fg: "#1E40AF" },
      delivered: { bg: "#DCFCE7", fg: "#166534" },
      read:      { bg: "#D1FAE5", fg: "#065F46" },
      failed:    { bg: "#FEE2E2", fg: "#991B1B" },
      pending:   { bg: "#F1F5F9", fg: "#475569" },
      queued:    { bg: "#FEF3C7", fg: "#92400E" },
    };
    const c = map[s] ?? { bg: "#F1F5F9", fg: "#475569" };
    return (
      <span className="text-xs px-2 py-0.5 rounded-full font-medium"
        style={{ background: c.bg, color: c.fg }}>{s}</span>
    );
  };

  const rows = data?.data ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "#0F172A" }}>Message Logs</h1>
        <p className="text-sm mt-1" style={{ color: "#64748B" }}>
          {data ? `${data.pagination.total.toLocaleString()} messages` : "Loading…"}
        </p>
      </div>

      {kpis && (
        <div className="grid grid-cols-4 gap-3 mb-4">
           {[
  { label: "Sent", value: kpis.total_sent ?? 0, color: "#1E40AF" },
  { label: "Delivered", value: kpis.total_delivered ?? 0, color: "#166534" },
  { label: "Read", value: kpis.total_read ?? 0, color: "#065F46" },
  { label: "Failed", value: kpis.total_failed ?? 0, color: "#991B1B" },
].map((k) => (
  <div key={k.label} className="p-4 rounded-lg"
    style={{ background: "#fff", border: "1px solid #E2E8F0" }}>
    <div className="text-xs uppercase font-medium" style={{ color: "#94A3B8" }}>{k.label}</div>
    <div className="text-2xl font-semibold mt-1" style={{ color: k.color }}>
      {k.value.toLocaleString()}
    </div>
  </div>
))}
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm rounded-md outline-none"
          style={{ border: "1px solid #E2E8F0", background: "#fff" }}
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="delivered">Delivered</option>
          <option value="read">Read</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #E2E8F0", background: "#fff" }}>
        {error && <div className="p-4 text-sm" style={{ color: "#B91C1C" }}>Failed to load: {error}</div>}
        {loading && !data && <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>Loading…</div>}
        {!loading && rows.length === 0 && !error && (
          <div className="p-8 text-center text-sm" style={{ color: "#64748B" }}>No messages match.</div>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead style={{ background: "#F8FAFC" }}>
              <tr>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Recipient</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Campaign</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Template</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Status</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Sent</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Delivered</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: "#475569" }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} style={{ borderTop: "1px solid #F1F5F9" }}>
                  <td className="px-4 py-2" style={{ color: "#0F172A" }}>
                    <div>{m.phone_e164 ?? "—"}</div>
                    <div className="text-xs font-mono" style={{ color: "#94A3B8" }}>{m.meta_message_id ?? "—"}</div>
                  </td>
                  <td className="px-4 py-2" style={{ color: "#475569" }}>{m.campaign_name ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: "#334155" }}>{m.branch_name ?? "—"}</td>
                  <td className="px-4 py-2">{statusBadge(m.status)}</td>
                  <td className="px-4 py-2 text-xs" style={{ color: "#64748B" }}>
                    {m.sent_at ? new Date(m.sent_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs" style={{ color: "#64748B" }}>
                    {m.delivered_at ? new Date(m.delivered_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs" style={{ color: "#B91C1C" }}>
                    {m.error_code ? `${m.error_code}: ${m.error_message ?? ""}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.pagination.total > 50 && (
        <div className="flex justify-between mt-4 text-sm">
          <button disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-3 py-1 rounded-md" style={{ border: "1px solid #E2E8F0", background: page === 1 ? "#F8FAFC" : "#fff" }}>
            ← Previous
          </button>
          <span style={{ color: "#64748B" }}>
            Page {page} of {Math.ceil(data.pagination.total / 50)}
          </span>
          <button
            disabled={page * 50 >= data.pagination.total}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded-md"
            style={{ border: "1px solid #E2E8F0", background: page * 50 >= data.pagination.total ? "#F8FAFC" : "#fff" }}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── App root — auth gate + shell ────────────────────────────────────────────

export default function App() {
  const { session, me, loading } = useAuth();

  if (window.location.pathname === "/reset-password") {
    return <ResetPasswordPage />;
  }
  if (window.location.pathname === "/accept-invite") {
    return <AcceptInvitePage />;
  }

  // Map screen names to URL paths and back — keeps refresh/back-button sane.
const VALID_SCREENS = ["dashboard", "contacts", "campaign", "templates", "logs", "users", "branches", "platform-create-tenant"] as const;
type ScreenName = typeof VALID_SCREENS[number];

function screenFromPath(): ScreenName {
  const path = window.location.pathname.slice(1); // strip leading '/'
  return (VALID_SCREENS as readonly string[]).includes(path)
    ? (path as ScreenName)
    : "dashboard";
}

// ... inside the App component ...
const [screen, setScreenRaw] = useState<ScreenName>(screenFromPath());

const setScreen = (next: ScreenName) => {
  setScreenRaw(next);
  const path = next === "dashboard" ? "/" : `/${next}`;
  window.history.pushState({}, "", path);
};

// Handle browser back/forward buttons
useEffect(() => {
  const onPopState = () => setScreenRaw(screenFromPath());
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auth gate — everything below assumes an authenticated session + /me
  if (loading) return <FullPageLoader label="Loading session…" />;
  if (!session) return <LoginScreen />;
  if (!me) return <FullPageLoader label="Fetching account…" />;

    const handleNavigate = (id: string) => {
    if (id === "contacts") setScreen("contacts");
    else if (id === "campaigns") setScreen("campaign");
    else if (id === "logs") setScreen("logs");
    else if (id === "templates") setScreen("templates");
    else if (id === "users") setScreen("users");
    else if (id === "branches") setScreen("branches");
    else if (id === "platform-create-tenant") setScreen("platform-create-tenant");
    else setScreen("dashboard");
  };

  const activeNav =
    screen === "contacts" ? "contacts" :
    screen === "campaign" ? "campaigns" :
    screen === "logs" ? "logs" :
    screen === "templates" ? "templates" :
    screen === "users" ? "users" :
    screen === "branches" ? "branches" :
    screen === "platform-create-tenant" ? "platform-create-tenant" :
    "dashboard";


  return (
    <ToastProvider>
    {<div
      className="flex h-screen w-full overflow-hidden"
      style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", background: "#F1F5F9" }}
    >
      <Sidebar
        active={activeNav}
        onNavigate={handleNavigate}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        <MobileTopbar onMenuOpen={() => setSidebarOpen(true)} />
        <main
          className="flex-1 w-full"
          style={{
            overflowY: "auto",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
                    {screen === "dashboard" && <DashboardScreen />}
          {screen === "contacts"  && <ContactsScreen />}
          {screen === "campaign"  && <BroadcastsScreen />}
          {screen === "logs"      && <MessagesScreen />}
          {screen === "templates" && <TemplatesScreen />}
          {screen === "users"     && <UsersScreen />}
          {screen === "branches"  && <BranchesScreen />}
          {screen === "platform-create-tenant" && <PlatformCreateTenantScreen onDone={() => setScreen("dashboard")} />}

        </main>
      </div>
    </div>}
    </ToastProvider>
  );
}
