import { useCallback, useEffect, useRef, useState } from 'react';
import type { StorefrontApi } from './api';
import { Items } from './Items';
import { Orders } from './Orders';
import { BusinessControls, DashboardPanel, FeesPanel, ReportsPanel, SettingsPanel, StaffPanel } from './Panels';
import type { LocationRef, Permissions } from './types';
import { input, ListSkeleton, Notice, ToastHost, useResource } from './ui';

export interface StorefrontManagerProps {
  api: StorefrontApi;
  /** 'location' = one location (Manager Portal, standalone). 'business' = all locations plus business-wide controls (Owner Console). */
  mode: 'location' | 'business';
  locations: LocationRef[];
  initialLocation?: string;
  onToast?: (text: string, tone: 'ok' | 'error') => void;
}

type TabKey = 'dashboard' | 'orders' | 'items' | 'settings' | 'reports' | 'fees' | 'staff' | 'business';

export function StorefrontManager(props: StorefrontManagerProps) {
  return <div className="rsm-root"><ToastHost onToast={props.onToast}><Shell {...props} /></ToastHost></div>;
}

function Shell({ api, mode, locations, initialLocation }: StorefrontManagerProps) {
  const [loc, setLoc] = useState(initialLocation && locations.some((l) => l.id === initialLocation) ? initialLocation : locations[0]?.id ?? '');
  const [tab, setTab] = useState<TabKey>('dashboard');
  const perms = useResource<Permissions>(() => api.permissions(), []);
  const settings = useResource(async () => { if (!loc) return null; await api.ensureSettings(loc).catch(() => undefined); return api.settings(loc); }, [loc]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const p = perms.data;
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'dashboard', label: 'Dashboard', show: true },
    { key: 'orders', label: 'Orders', show: true },
    { key: 'items', label: 'Items', show: true },
    { key: 'settings', label: 'Settings', show: true },
    { key: 'reports', label: 'Reports', show: !!p?.reports_view },
    { key: 'fees', label: 'Fees & statements', show: !!p?.fees_view },
    { key: 'staff', label: 'Staff', show: !!p?.manage_staff },
    { key: 'business', label: 'Business', show: mode === 'business' && !!p?.owner },
  ];
  const visible = tabs.filter((t) => t.show);
  useEffect(() => { if (!visible.some((t) => t.key === tab)) setTab('dashboard'); }, [visible, tab]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    const i = visible.findIndex((t) => t.key === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const t = visible[(next + visible.length) % visible.length];
    setTab(t.key); tabRefs.current[t.key]?.focus();
  }, [visible, tab]);

  if (perms.loading && !p) return <ListSkeleton rows={3} />;
  if (!p) return <Notice tone="error">{perms.error ?? 'Could not load your access.'}</Notice>;
  if (!p.view) return <Notice>You do not have access to the online storefront. Ask the business owner.</Notice>;
  if (locations.length === 0) return <Notice>No locations found.</Notice>;

  const rollup = mode === 'business' && (tab === 'reports' || tab === 'fees');
  const body = (() => {
    const base = { api, location: loc, perms: p };
    switch (tab) {
      case 'dashboard': return <DashboardPanel {...base} onGo={(t) => setTab(t as TabKey)} />;
      case 'orders': return <Orders {...base} />;
      case 'items': return <Items {...base} settings={settings.data} reloadSettings={() => void settings.reload()} />;
      case 'settings': return <SettingsPanel {...base} settings={settings.data} reloadSettings={() => void settings.reload()} />;
      case 'reports': return <ReportsPanel {...base} businessWide={rollup} />;
      case 'fees': return <FeesPanel {...base} businessWide={rollup} />;
      case 'staff': return <StaffPanel {...base} />;
      case 'business': return <BusinessControls api={api} />;
    }
  })();

  return (
    <div className="grid gap-4 text-ink">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-display font-bold text-2xl flex-1">Online Storefront</h1>
        {locations.length > 1 && tab !== 'business' && (
          <>
            <label htmlFor="sf-loc" className="sr-only">Location</label>
            <select id="sf-loc" className={`${input} max-w-[16rem]`} value={loc} onChange={(e) => setLoc(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </>
        )}
      </header>
      {rollup && <Notice>Showing all locations together.</Notice>}
      <div role="tablist" aria-label="Storefront sections" className="flex gap-1 overflow-x-auto border-b border-line" onKeyDown={onKey}>
        {visible.map((t) => (
          <button key={t.key} ref={(el) => { tabRefs.current[t.key] = el; }} role="tab" id={`sf-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="sf-panel"
            tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}
            className={`min-h-[44px] px-4 whitespace-nowrap text-sm font-semibold border-b-2 ${tab === t.key ? 'border-ember text-ink' : 'border-transparent text-smoke hover:text-ink'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id="sf-panel" aria-labelledby={`sf-tab-${tab}`}>{body}</div>
    </div>
  );
}
