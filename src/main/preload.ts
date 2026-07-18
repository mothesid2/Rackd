import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // Auth
  login: (username: string, password: string) =>
    ipcRenderer.invoke('auth:login', username, password),
  pinLogin: (pin: string) => ipcRenderer.invoke('auth:pinLogin', pin),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),

  // Session model (item 2): business-day open state + 15-min idle re-auth
  reprintPickup: (orderId: string) => ipcRenderer.invoke('receipt:reprintPickup', orderId),
  sessionState: () => ipcRenderer.invoke('session:state'),
  sessionTouch: () => ipcRenderer.invoke('session:touch'),
  sessionReauth: (pin: string) => ipcRenderer.invoke('session:reauth', pin),
  sessionCloseDay: () => ipcRenderer.invoke('session:closeDay'),
  changePassword: (oldPass: string, newPass: string) =>
    ipcRenderer.invoke('auth:changePassword', oldPass, newPass),
  listUsers: () => ipcRenderer.invoke('auth:listUsers'),
  createUser: (username: string, password: string, role: string) =>
    ipcRenderer.invoke('auth:createUser', username, password, role),
  deleteUser: (id: number) => ipcRenderer.invoke('auth:deleteUser', id),
  verifyManager: (username: string, password: string) =>
    ipcRenderer.invoke('auth:verifyManager', username, password),

  // Products
  getProducts: (filters?: object) => ipcRenderer.invoke('products:getAll', filters),
  getProductByBarcode: (barcode: string) => ipcRenderer.invoke('products:getByBarcode', barcode),
  searchProducts: (query: string) => ipcRenderer.invoke('products:search', query),
  addProduct: (product: object) => ipcRenderer.invoke('products:add', product),
  updateProduct: (id: number, data: object) => ipcRenderer.invoke('products:update', id, data),
  adjustStock: (id: number, delta: number, reason: string) =>
    ipcRenderer.invoke('products:adjustStock', id, delta, reason),
  importProductsCSV: (csvText: string) => ipcRenderer.invoke('products:importCSV', csvText),
  clearProducts: () => ipcRenderer.invoke('products:clearAll'),
  deleteProduct: (id: number) => ipcRenderer.invoke('products:delete', id),
  getProductSaleHistory: (id: number) => ipcRenderer.invoke('products:getSaleHistory', id),
  getReorderReport: (windowDays?: number) => ipcRenderer.invoke('products:reorderReport', windowDays),
  getVariants: (productId: number) => ipcRenderer.invoke('products:getVariants', productId),
  addVariants: (productId: number, rows: object[]) => ipcRenderer.invoke('products:addVariants', productId, rows),
  updateVariant: (id: number, data: object) => ipcRenderer.invoke('products:updateVariant', id, data),
  deleteVariant: (id: number) => ipcRenderer.invoke('products:deleteVariant', id),

  // Transactions
  getTransactions: (filters?: object) => ipcRenderer.invoke('transactions:getAll', filters),
  getTransaction: (id: number) => ipcRenderer.invoke('transactions:getOne', id),
  createTransaction: (data: object) => ipcRenderer.invoke('transactions:create', data),
  deleteTransaction: (id: number) => ipcRenderer.invoke('transactions:delete', id),
  lookupReceipt: (receiptNo: string, managerPin: string) => ipcRenderer.invoke('transactions:lookupReceipt', receiptNo, managerPin),
  refundItems: (payload: object) => ipcRenderer.invoke('transactions:refundItems', payload),
  getTodayOverview: () => ipcRenderer.invoke('transactions:todayOverview'),

  // Card terminal
  sendPayment: (payload: object) => ipcRenderer.invoke('terminal:sendPayment', payload),
  cancelPayment: () => ipcRenderer.invoke('terminal:cancel'),
  testTerminalConnection: () => ipcRenderer.invoke('terminal:test'),
  getTerminalConfig: () => ipcRenderer.invoke('terminal:getConfig'),
  saveTerminalConfig: (config: object) => ipcRenderer.invoke('terminal:saveConfig', config),
  getTerminalCertStatus: () => ipcRenderer.invoke('terminal:certStatus'),
  getLocalIps: () => ipcRenderer.invoke('terminal:localIps'),

  // Cash drawer
  popDrawer: (note?: string, opts?: object) => ipcRenderer.invoke('drawer:open', note, opts),
  getDrawerSummary: () => ipcRenderer.invoke('drawer:summary'),
  getDrawerLog: (limit?: number) => ipcRenderer.invoke('drawer:log', limit),
  recordCashDrop: (amount: number, note?: string) => ipcRenderer.invoke('drawer:drop', amount, note),
  listDrawerPorts: () => ipcRenderer.invoke('drawer:ports'),

  // Customers
  getCustomers: (query?: string) => ipcRenderer.invoke('customers:getAll', query),
  getCustomer: (id: number) => ipcRenderer.invoke('customers:getOne', id),
  addCustomer: (data: object) => ipcRenderer.invoke('customers:add', data),
  updateCustomer: (id: number, data: object) => ipcRenderer.invoke('customers:update', id, data),
  searchCustomers: (query: string) => ipcRenderer.invoke('customers:search', query),
  findCustomerForId: (q: object) => ipcRenderer.invoke('customers:findForId', q),
  getCustomerUpsell: (id: number) => ipcRenderer.invoke('customers:upsell', id),

  // SMS
  sendSmsBlast: (message: string, filter: object) =>
    ipcRenderer.invoke('sms:blast', message, filter),
  sendSingleSms: (phone: string, message: string) =>
    ipcRenderer.invoke('sms:single', phone, message),
  sendReceiptSms: (txnId: number, phone: string) =>
    ipcRenderer.invoke('sms:receipt', txnId, phone),

  // Invoices
  getInvoices: (filters?: object) => ipcRenderer.invoke('invoices:getAll', filters),
  getInvoice: (id: number) => ipcRenderer.invoke('invoices:getOne', id),
  createInvoice: (data: object) => ipcRenderer.invoke('invoices:create', data),
  attachInvoicePdf: (id: number, path: string) => ipcRenderer.invoke('invoices:attachPdf', id, path),
  deleteInvoice: (id: number) => ipcRenderer.invoke('invoices:delete', id),
  openInvoicePdf: (id: number) => ipcRenderer.invoke('invoices:openPdf', id),
  pickPdfFile: () => ipcRenderer.invoke('dialog:openPdf'),

  // X/Z Out
  getXReport: () => ipcRenderer.invoke('xzout:xReport'),
  runZReport: (pin: string) => ipcRenderer.invoke('xzout:zReport', pin),
  getPeriodReport: (opts?: object) => ipcRenderer.invoke('xzout:periodReport', opts),
  getLocationPeriodReport: (opts?: object) => ipcRenderer.invoke('xzout:locationPeriodReport', opts),
  getAgeLog: (opts?: object) => ipcRenderer.invoke('compliance:ageLog', opts),

  // Promos / birthdays
  getBirthdaysToday: () => ipcRenderer.invoke('promos:birthdaysToday'),
  runBirthdayPromos: () => ipcRenderer.invoke('promos:runBirthdays'),
  validatePromo: (code: string) => ipcRenderer.invoke('promos:validate', code),

  // Loyalty rewards
  getRewards: () => ipcRenderer.invoke('loyalty:rewards'),
  sendCloseToReward: (opts?: object) => ipcRenderer.invoke('loyalty:closeToReward', opts),
  expireStalePoints: () => ipcRenderer.invoke('loyalty:expireStale'),

  // Receipt
  printReceipt: (txnId: number) => ipcRenderer.invoke('receipt:print', txnId),
  getReceiptConfig: () => ipcRenderer.invoke('receipt:getConfig'),
  updateReceiptConfig: (data: object) => ipcRenderer.invoke('receipt:updateConfig', data),
  listPrinters: () => ipcRenderer.invoke('printer:list'),
  testPrint: () => ipcRenderer.invoke('printer:test'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  updateSetting: (key: string, value: string) =>
    ipcRenderer.invoke('settings:update', key, value),

  // Generic local database access (renderer never imports better-sqlite3).
  // Always pass values via the params array so they're bound, not interpolated.
  dbQuery: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
  dbGet: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:get', sql, params),
  dbRun: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:run', sql, params),

  // Cloud sync health + dead-letter admin
  syncTrigger: () => ipcRenderer.invoke('sync:trigger'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncDeadLetters: () => ipcRenderer.invoke('sync:dead-letters'),
  syncRetryDeadLetter: (id: number) => ipcRenderer.invoke('sync:retry-dead-letter', id),
  syncClearDeadLetter: (id: number) => ipcRenderer.invoke('sync:clear-dead-letter', id),

  // License
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  licenseRefresh: () => ipcRenderer.invoke('license:refresh'),
  licenseAssertWritable: (action: string) => ipcRenderer.invoke('license:assert-writable', action),

  // License activation (onboarding gate)
  licenseActivationState: () => ipcRenderer.invoke('license:activationState'),
  licenseActivate: (key: string) => ipcRenderer.invoke('license:activate', key),
  licenseSelectLocation: (key: string, locationId: string) => ipcRenderer.invoke('license:selectLocation', key, locationId),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),

  // Auto-update
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateGetChannel: () => ipcRenderer.invoke('update:getChannel'),
  updateSetChannel: (ch: string) => ipcRenderer.invoke('update:setChannel', ch),

  // Admin console (tenant/license provisioning — owner only)
  adminHasSecret: () => ipcRenderer.invoke('admin:hasSecret'),
  adminSetSecret: (pin: string, secret: string) => ipcRenderer.invoke('admin:setSecret', pin, secret),
  adminList: () => ipcRenderer.invoke('admin:list'),
  adminCreate: (payload: object) => ipcRenderer.invoke('admin:create', payload),
  adminCreateBusiness: (payload: object) => ipcRenderer.invoke('admin:createBusiness', payload),
  adminLocations: (tenantId: string) => ipcRenderer.invoke('admin:locations', tenantId),
  adminAddLocation: (tenantId: string, name: string) => ipcRenderer.invoke('admin:addLocation', tenantId, name),
  adminRenameLocation: (locationId: string, name: string) => ipcRenderer.invoke('admin:renameLocation', locationId, name),
  adminKiosks: (tenantId: string) => ipcRenderer.invoke('admin:kiosks', tenantId),
  adminResetKiosk: (tenantId: string, machineId: string) => ipcRenderer.invoke('admin:resetKiosk', tenantId, machineId),
  adminCancelReset: (tenantId: string, machineId: string) => ipcRenderer.invoke('admin:cancelReset', tenantId, machineId),
  adminUpdate: (payload: object) => ipcRenderer.invoke('admin:update', payload),
  adminDelete: (licenseKey: string) => ipcRenderer.invoke('admin:delete', licenseKey),
  adminSetAds: (licenseKey: string, displayConfig: object) => ipcRenderer.invoke('admin:setAds', licenseKey, displayConfig),
  adminFreeSeat: (licenseKey: string, machineId: string) => ipcRenderer.invoke('admin:freeSeat', licenseKey, machineId),
  adminAggregate: (range?: object) => ipcRenderer.invoke('admin:aggregate', range),
  adminMfrList: (tenantId: string) => ipcRenderer.invoke('admin:mfrList', tenantId),
  adminSetMfrCred: (payload: object) => ipcRenderer.invoke('admin:mfrCredsSet', payload),

  // Subscription billing (spec v2 §6) — Stripe via Edge Functions
  billingStatus: (licenseKey?: string) => ipcRenderer.invoke('billing:status', licenseKey),
  billingCheckout: (opts: object) => ipcRenderer.invoke('billing:checkout', opts),
  billingPortal: (licenseKey?: string) => ipcRenderer.invoke('billing:portal', licenseKey),

  // Demo build flag (Owner Console is demo-only, hidden on client installs)
  appIsDemo: () => ipcRenderer.invoke('app:isDemo'),

  // AI features (Claude) — manager-gated; no-op when ANTHROPIC_API_KEY is unset
  aiIsConfigured: () => ipcRenderer.invoke('ai:isConfigured'),
  aiComplete: (task: string, context: unknown) => ipcRenderer.invoke('ai:complete', task, context),

  // Advanced analytics (spec v2 §1 dead stock, §2 per-employee) — manager-gated
  getDeadStock: () => ipcRenderer.invoke('analytics:deadStock'),
  getEmployeePerformance: (opts?: object) => ipcRenderer.invoke('analytics:employeePerformance', opts),

  // Onboarding checklist (spec v2 §7)
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  dismissOnboarding: () => ipcRenderer.invoke('onboarding:dismiss'),

  // Pre-loaded SKU catalog (spec v2 §3)
  catalogLookup: (q: object) => ipcRenderer.invoke('catalog:lookup', q),
  catalogSaveLocal: (item: object) => ipcRenderer.invoke('catalog:saveLocal', item),
  catalogPreview: (payload: object) => ipcRenderer.invoke('catalog:preview', payload),
  catalogMerge: (payload: object) => ipcRenderer.invoke('catalog:merge', payload),
  catalogStats: () => ipcRenderer.invoke('catalog:stats'),
  catalogClearSource: (source: string) => ipcRenderer.invoke('catalog:clearSource', source),

  // Owner gate (owner-only config, PIN-protected)
  ownerHasPin: () => ipcRenderer.invoke('owner:hasPin'),
  ownerVerifyPin: (pin: string) => ipcRenderer.invoke('owner:verifyPin', pin),
  ownerSetPin: (newPin: string, currentPin?: string) => ipcRenderer.invoke('owner:setPin', newPin, currentPin),
  ownerResetPin: () => ipcRenderer.invoke('owner:resetPin'),
  ownerGetDisplayConfig: () => ipcRenderer.invoke('owner:getDisplayConfig'),
  ownerSetDisplayConfig: (pin: string, config: object) => ipcRenderer.invoke('owner:setDisplayConfig', pin, config),

  // Navigation
  navigate: (page: string) => ipcRenderer.invoke('navigate', page),

  // Window
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),

  // Print current page via native dialog
  printPage: () => ipcRenderer.invoke('printPage'),

  // Zebra barcode tag printing
  printBarcodeTags: (products: object[]) => ipcRenderer.invoke('zebra:printTags', products),

  // Customer display
  updateCustomerDisplay: (data: object) =>
    ipcRenderer.invoke('customerDisplay:update', data),
  // Customer-facing loyalty consent (customer taps Agree/Decline on their screen)
  sendCustomerConsent: (payload: object) =>
    ipcRenderer.invoke('customerDisplay:consent', payload),
  // Customer-facing tip selection (customer taps a tip on their screen)
  sendCustomerTip: (payload: object) =>
    ipcRenderer.invoke('customerDisplay:tip', payload),

  // Manufacturer rebates (manager rule CRUD)
  listManufacturers: () => ipcRenderer.invoke('rebates:listManufacturers'),
  listRebateRules: () => ipcRenderer.invoke('rebates:listRules'),
  saveRebateRule: (rule: object) => ipcRenderer.invoke('rebates:saveRule', rule),
  setRebateRuleActive: (uid: string, active: boolean) => ipcRenderer.invoke('rebates:setRuleActive', uid, active),
  activeRebateRules: () => ipcRenderer.invoke('rebates:activeRules'),

  // Permissions / staff
  permsMe: () => ipcRenderer.invoke('perms:me'),
  permsKeys: () => ipcRenderer.invoke('perms:keys'),
  permsPinLockState: () => ipcRenderer.invoke('perms:pinLockState'),
  permsListEmployees: () => ipcRenderer.invoke('perms:listEmployees'),
  permsSaveEmployee: (emp: object) => ipcRenderer.invoke('perms:saveEmployee', emp),
  permsSetPermission: (employeeUid: string, key: string, isGranted: boolean, value: number | null) =>
    ipcRenderer.invoke('perms:setPermission', employeeUid, key, isGranted, value),
  permsOverrideLog: (limit?: number) => ipcRenderer.invoke('perms:overrideLog', limit),
  permsCheck: (key: string, override?: string) => ipcRenderer.invoke('perms:check', key, override),

  // Time clock
  timeclockStatus: () => ipcRenderer.invoke('timeclock:status'),
  timeclockPunch: (employeeUid?: string, override?: string) => ipcRenderer.invoke('timeclock:punch', employeeUid, override),

  // Online storefront — pickup queue + compliance pickup
  storefrontQueue: () => ipcRenderer.invoke('storefront:queue'),
  storefrontAdvance: (args: object) => ipcRenderer.invoke('storefront:advance', args),
  storefrontCompletePickup: (args: object) => ipcRenderer.invoke('storefront:completePickup', args),
  recordAppliedRebates: (txnId: number, list: object[]) => ipcRenderer.invoke('rebates:recordApplied', txnId, list),
  recordMissedRebates: (txnId: number, list: object[]) => ipcRenderer.invoke('rebates:recordMissed', txnId, list),
  customerDisplayAvailable: () =>
    ipcRenderer.invoke('customerDisplay:isAvailable'),

  // Listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.off(channel, callback as Parameters<typeof ipcRenderer.off>[1]);
  },
});
