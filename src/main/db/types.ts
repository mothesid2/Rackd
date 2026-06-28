/**
 * Row shapes for the local SQLite tables. SQLite stores booleans as 0/1 and all
 * timestamps as ISO/`datetime('now')` TEXT, which is reflected here.
 *
 * These cover the local-first core (the tables named in the architecture spec).
 * Add more as features land; queryClient is generic so any table is queryable
 * even before a type exists for it.
 */

export interface EmployeeRow {
  id: number;
  name: string;
  pin: string | null;
  role: string;
  active: number;
  created_at: string;
}

export interface CashDrawerSessionRow {
  id: number;
  employee_id: number | null;
  opening_float: number;
  closing_amount: number | null;
  expected_amount: number | null;
  over_short: number | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
}

export type SyncOp = 'insert' | 'update' | 'delete';

export interface SyncQueueRow {
  id: number;
  table_name: string;
  record_id: string;
  operation: SyncOp;
  payload: string;
  attempts: number;
  last_attempted_at: string | null;
  synced: number; // 0/1
  error_message: string | null;
  dead_letter: number; // 0/1
  abandoned: number; // 0/1 — admin marked permanently abandoned
  created_at: string;
}

export interface ConflictRow {
  id: number;
  table_name: string;
  record_id: string;
  local_updated_at: string | null;
  remote_updated_at: string | null;
  local_payload: string | null;
  resolved: number; // 0/1
  created_at: string;
}

export interface TransactionRow {
  id: number;
  cashier_id: number | null;
  customer_id: number | null;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  payment_method: 'cash' | 'card' | 'split' | null;
  payment_status: string;
  created_at: string;
}

export interface TransactionItemRow {
  id: number;
  transaction_id: number;
  product_id: number | null;
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface CustomerRow {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  dob: string | null;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string | null;
}
