# Owner Console expansion — permission & data model (spec item 8)

This is the proposed model for the expanded Owner Console, and a map of what is
built now vs. deferred. The owner console is the private platform cockpit; every
power runs through the service-role `admin` Edge Function, gated by `ADMIN_SECRET`.

## Data model

Everything reuses existing cloud mirrors; migration **046** adds only a reporting
RPC and an audit table.

| Concern | Source of truth | Cloud table | How the owner reaches it |
|---|---|---|---|
| Staff list | local `users` (POS) | `employees_cloud` (synced, PK `tenant_id,uid`) | `admin` action `staff` |
| Permission grants | local `employee_permissions` | `employee_permissions_cloud` (PK `tenant_id,uid`, unique per `employee_uid+permission_key`) | `admin` actions `staff` / `setStaffPermission` |
| Passwords | bcrypt in `employees_cloud.password_hash` | same | `admin` action `resetStaffPassword` |
| Per-location POS revenue | local `transactions` | `transactions_cloud` (**already carries `location_id`**, migration 016) | RPC `store_sales_by_location` via `admin` action `revenueByLocation` |
| Audit trail | — (new) | `owner_audit_log` (append-only, service-role only) | `admin` action `auditLog` |

### Why writes are safe (convergence)

The POS is the source of truth and syncs bidirectionally. Permission and password
edits made in the console write to the **cloud mirror**, and the POS applies them
on its next pull:

- `applyEmployeePermission` upserts `ON CONFLICT(uid)`. `setStaffPermission`
  **updates the existing cloud row in place** (found by `employee_uid+permission_key`,
  preserving its `uid`) or inserts a new grant with a fresh uuid. Either way the POS
  converges — no duplicate rows, because the POS also keys by `employee_uid+permission_key`.
- `applyEmployee` upserts `ON CONFLICT(uid)` and reads `password_hash` +
  `must_change_password`. `resetStaffPassword` sets both, so the register forces a
  change on next login.

### Audit (never silent)

`owner_audit_log` records `reset_password` and `set_permission` with tenant, target
employee, and detail JSON. It has **no RLS policies** — only the service-role `admin`
function reads/writes it. Surfaced read-only via the `auditLog` action.

## Built now

- **Staff & permissions tab** — every employee per business, with a live toggle grid
  for all 8 permission keys (admins are shown as all-granted, locked). Edits apply on
  the register's next sync.
- **Reset password** — per user; returns a one-time temporary password (shown once),
  forces a change on next login, and is audited.
- **Revenue tab** — per-location in-store POS revenue (last 30 days): revenue,
  transactions, refunds per location, plus an "Unattributed" bucket for legacy rows
  with no `location_id`.
- **Web Orders** — the former "Online orders" tab, renamed (spec item 9).

## Deferred (documented, not yet built)

- **Ads / display config** — the `setAds` action already exists (writes
  `licenses.display_config`); a UI panel to edit it per location is a follow-up.
- **Mobile / cloud toggles & multi-location settings** — these are business-level
  feature flags. Recommended model: a `business_settings` table keyed by `tenant_id`
  with JSON flags (e.g. `{ "mobile_ordering": true, "multi_location": true }`), edited
  via a new `setBusinessSettings` action. Not built pending confirmation of the exact
  flags in scope.
