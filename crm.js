// ============================================================
// CONFIG & STATE
// ============================================================
const SUPABASE_URL = 'https://ilrylhseqnllmejebozq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlscnlsaHNlcW5sbG1lamVib3pxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NDk1MTIsImV4cCI6MjA5ODMyNTUxMn0.ga1b6-xCpXYa-p6axyLMoXj6oHVHEKTFoDEtmVIc3Uw';


// GMAIL OAUTH CONFIG—fill these in after Google Cloud setup
const GOOGLE_OAUTH_CLIENT_ID = '500395306800-26vlgl3b34p83t8ik3b4u0hcrk7qq0u8.apps.googleusercontent.com';
const APPS_SCRIPT_URL        = 'https://script.google.com/macros/s/AKfycbw4XGkFjwmillnNNEBKKI008Slwy-xd_ZDouIf0pVpkzmL1Olun-Lbda7FY3XA_uDm0ww/exec';
const GMAIL_SCOPES = 'https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts';
const PIPELINES = {
  'group-employer': { name: 'Group / Employer', stages: ['New Lead','Researched','Outreach Sent','Responded','Discovery Call','Proposal','Enrolled','Active Client'] },
  'individual-family': { name: 'Individual & Family', stages: ['New Lead','Contacted','Needs Assessment','Quoted','Application','Enrolled','Active Client'] },
  'agent-insured': { name: 'Agent Recruiting — Insured America', stages: ['Identified','Contacted','Applied','Interested','Interview','Licensing Support','Contracted','Active Agent'] },
  'agent-kannon': { name: 'Agent Recruiting — Kannon Financial', stages: ['Identified','Contacted','Applied','Interested','Interview','Licensing Support','Contracted','Active Agent'] }
};

const CONTACT_TYPES = ['Group/Employer','Individual/Family','Recruit','Agent — Insured America','Agent — Kannon Financial'];

let supabaseClient = null;
let campaignTab = 'drip';
let campaignItemsMap = {};
let currentUser = null;
let currentAgent = null;        // agents table row
let _appInitialized = false;    // prevents re-init on token refresh
let currentAgentCompanies = []; // company names agent belongs to
let allAgents = [];             // for admin panel + dropdowns
let allAgencies = [];
let allCompanies = [];
let contacts = [];
let deals = [];
let dealActivities = [];
let dealTasks = [];
let draggedDeal = null;
let currentPipeline = 'group-employer';
let contactSearch = '';
let contactTypeFilter = '';
let contactStatusFilter = 'active'; // 'active' | 'needs_attention' | 'all'
let opensFilter = [];
let _quickFilterLabel = '';
let contactPage = 0;
let contactSort = 'created_at_desc';
let applications = [];
let dialerQueue = [];
let dialerIndex = 0;
let totalContactCountFull = 0; // True DB count bypassing 1000-row cap
let previewRole = null; // system_owner can preview other role views
let calView = 'month';  // 'month' | 'week' | 'day'
let calDate = new Date();
let calAppointments = [];
let naItems = []; // unified Needs Attention items (replies, complaints, no-shows, cancels)

// ============================================================
// INIT
// ============================================================
async function init() {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  document.getElementById('auth-screen').style.display = 'flex';

  // Handle OAuth redirect
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    await loadAgentProfile();
    if (currentAgent) { showApp(); } else { showAuthError('Your account is not set up in the CRM yet. Contact Ken to be added.'); }
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session) currentUser = session.user; // always keep currentUser fresh
    if (event === 'SIGNED_OUT') { _appInitialized = false; return; }
    if (event === 'SIGNED_IN' && session && !_appInitialized) {
      _appInitialized = true;
      await loadAgentProfile();
      if (currentAgent) { showApp(); } else { showAuthError('Your account is not set up in the CRM yet. Contact Ken to be added.'); }
    }
    // TOKEN_REFRESHED / USER_UPDATED — currentUser already updated above, no re-init needed
  });
}

// ============================================================
// AGENT PROFILE
// ============================================================
async function loadAgentProfile() {
  // Try by auth_user_id first
  let { data: agent } = await supabaseClient
    .from('agents')
    .select('*, agencies(name)')
    .eq('auth_user_id', currentUser.id)
    .maybeSingle();

  if (!agent) {
    // First login — link by email
    const { data: byEmail } = await supabaseClient
      .from('agents')
      .select('*, agencies(name)')
      .eq('email', currentUser.email)
      .maybeSingle();
    if (byEmail) {
      await supabaseClient.from('agents').update({ auth_user_id: currentUser.id }).eq('id', byEmail.id);
      agent = byEmail;
    }
  }

  currentAgent = agent;

  if (agent) {
    // Load agent's companies
    const { data: ac } = await supabaseClient
      .from('agent_companies')
      .select('companies(name, slug)')
      .eq('agent_id', agent.id);
    currentAgentCompanies = (ac || []).map(r => r.companies);

    // Load meta tables
    const [{ data: ags }, { data: agc }, { data: cos }] = await Promise.all([
      supabaseClient.from('agents').select('*, agencies(name)').order('name'),
      supabaseClient.from('agencies').select('*, companies(name)').order('name'),
      supabaseClient.from('companies').select('*').order('name')
    ]);
    allAgents = ags || [];
    allAgencies = agc || [];
    allCompanies = cos || [];
  }
}

// ============================================================
// AUTH
// ============================================================
async function signInWithGoogle() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if (error) showAuthError(error.message);
}

async function signIn() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showAuthError('Enter your email and password.'); return; }
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) { showAuthError(error.message); return; }
  currentUser = data.user;
  await loadAgentProfile();
  if (currentAgent) { showApp(); } else { showAuthError('Your account is not yet set up. Contact Ken to be added to the CRM.'); }
}

async function signOut() {
  await supabaseClient.auth.signOut();
  currentUser = null; currentAgent = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.color = 'var(--danger)'; el.style.display = 'block';
}

// ============================================================
// APP SHELL
// ============================================================
async function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  const roleLabels = { system_owner: 'System Owner', agency_owner: 'Agency Owner', agent: 'Agent' };
  const roleLabel = roleLabels[currentAgent.role] || currentAgent.role;

  // Topbar user info
  document.getElementById('user-name-display').textContent = currentAgent.name;
  document.getElementById('user-role-badge').textContent = roleLabel;

  // Sidebar user info
  const nameParts = (currentAgent.name || '').trim().split(' ');
  const initials = ((nameParts[0] || '')[0] || '') + ((nameParts[1] || '')[0] || '');
  document.getElementById('sidebar-avatar').textContent = initials.toUpperCase() || '?';
  document.getElementById('sidebar-user-name').textContent = currentAgent.name;
  document.getElementById('sidebar-user-role').textContent = roleLabel;

  // Render role-based sidebar nav
  renderSidebarNav();

  // System owner gets role-preview tabs in topbar
  if (currentAgent.role === 'system_owner') {
    const right = document.getElementById('topbar-page-title');
    if (right && !document.getElementById('role-switcher')) {
      const sw = document.createElement('div');
      sw.id = 'role-switcher';
      sw.style.cssText = 'display:flex;gap:2px;background:var(--surface-0);padding:2px;border-radius:8px;border:0.5px solid var(--border);margin-left:12px;';
      sw.innerHTML = `
        <button id="rsw-owner" onclick="switchPreviewRole('system_owner')" style="padding:4px 11px;border-radius:6px;font-size:11px;border:none;cursor:pointer;background:var(--surface-2);color:var(--text-primary);font-weight:500;">System owner</button>
        <button id="rsw-agency" onclick="switchPreviewRole('agency_owner')" style="padding:4px 11px;border-radius:6px;font-size:11px;border:none;cursor:pointer;background:none;color:var(--text-muted);">Agency owner</button>
        <button id="rsw-agent" onclick="switchPreviewRole('agent')" style="padding:4px 11px;border-radius:6px;font-size:11px;border:none;cursor:pointer;background:none;color:var(--text-muted);">Agent</button>
      `;
      right.insertAdjacentElement('afterend', sw);
    }
  }

  await loadData();
  showPage('dashboard');
  showAIBubble();

  const _urlParams = new URLSearchParams(window.location.search);
  if (_urlParams.get('gmail') === 'connected') {
    window.history.replaceState({}, '', window.location.pathname);
    currentAgent.gmail_connected = true;
    currentAgent.calendar_connected = true;
    renderDashboard();
    showToast('✓ Gmail & Calendar connected!');
  } else if (currentAgent.role === 'agent' && !currentAgent.gmail_connected) {
    setTimeout(() => showGmailSetup(false), 500);
  } else if (currentAgent.gmail_connected && !currentAgent.calendar_connected) {
    setTimeout(() => showToast('🗓 Connect your Google Calendar in Settings → Gmail & Calendar for full sync.'), 1500);
  }
}

const PAGE_TITLES = {
  dashboard: 'Dashboard', pipelines: 'Pipelines', contacts: 'Contacts',
  opens: 'Email Opens', campaigns: 'Email Campaigns', compliance: 'Compliance',
  admin: 'Admin', dialer: 'Work My Leads', settings: 'Settings', appointments: 'Appointments',
  scripts: 'Script Manager'
};

function showPage(page) {
  ['dashboard','pipelines','contacts','opens','campaigns','compliance','admin','dialer','settings','appointments','oversight','scripts'].forEach(p => {
    const el = document.getElementById('page-' + p);
    if (el) el.style.display = p === page ? 'block' : 'none';
    const nav = document.getElementById('nav-' + p);
    if (nav) nav.classList.toggle('active', p === page);
  });
  const titleEl = document.getElementById('topbar-page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;
  if (page === 'dashboard')    renderDashboard();
  if (page === 'pipelines')    renderPipelines();
  if (page === 'contacts')     renderContacts();
  if (page === 'opens')        renderOpens();
  if (page === 'campaigns')    renderCampaigns();
  if (page === 'compliance')   renderCompliance();
  if (page === 'admin')        renderAdmin();
  if (page === 'dialer')       renderDialer();
  if (page === 'settings')     renderSettings();
  if (page === 'appointments') renderAppointments();
  if (page === 'oversight')    renderOversight();
  if (page === 'scripts')      renderScriptManagerPage();
}

// ============================================================
// SIDEBAR NAV — role-adaptive
// ============================================================
function getNavBadges() {
  const notStarted = contacts.filter(c => !c.sequence_status || c.sequence_status === 'not_started').length;
  const inactiveAgents = allAgents ? allAgents.filter(a => a.status !== 'active').length : 0;
  return { notStarted, inactiveAgents };
}

function renderSidebarNav() {
  const container = document.getElementById('sidebar-nav-container');
  if (!container) return;
  const role = previewRole || currentAgent.role;
  const b = getNavBadges();

  const navConfig = {
    system_owner: [
      { label: 'Overview', items: [
        { icon: 'ti-layout-dashboard', text: 'Dashboard',          page: 'dashboard'    },
        { icon: 'ti-calendar-event',   text: 'Appointments',       page: 'appointments' },
      ]},
      { label: 'Manage', items: [
        { icon: 'ti-users',            text: 'All contacts',       page: 'contacts'  },
        { icon: 'ti-layout-kanban',    text: 'Pipelines',          page: 'pipelines' },
        { icon: 'ti-bolt',             text: 'Work my leads',      page: 'dialer',   badge: b.notStarted || null, badgeType: 'green' },
      ]},
      { label: 'Agency & team', items: [
        { icon: 'ti-building-community', text: 'Agencies & agents', page: 'admin',   badge: b.inactiveAgents || null, badgeType: 'red' },
        { icon: 'ti-alert-triangle',     text: 'Oversight',         page: 'oversight' },
        { icon: 'ti-script',             text: 'Script Manager',    page: 'scripts'   },
      ]},
      { label: 'Funnels', items: [
        { icon: 'ti-send',             text: 'Email Campaigns',    page: 'campaigns' },
        { icon: 'ti-mail-opened',      text: 'Email Opens',        page: 'opens'     },
      ]},
      { label: 'System', items: [
        { icon: 'ti-shield-check',     text: 'Compliance',         page: 'compliance'},
        { icon: 'ti-settings',         text: 'Settings',           page: 'settings'  },
      ]},
    ],
    agency_owner: [
      { label: 'My agency', items: [
        { icon: 'ti-layout-dashboard', text: 'Dashboard',          page: 'dashboard'    },
        { icon: 'ti-users',            text: 'Contacts',           page: 'contacts'     },
        { icon: 'ti-layout-kanban',    text: 'Pipelines',          page: 'pipelines'    },
        { icon: 'ti-calendar-event',   text: 'Appointments',       page: 'appointments' },
        { icon: 'ti-bolt',             text: 'Work my leads',      page: 'dialer',   badge: b.notStarted || null, badgeType: 'green' },
      ]},
      { label: 'Funnels', items: [
        { icon: 'ti-send',             text: 'Email Campaigns',    page: 'campaigns' },
        { icon: 'ti-mail-opened',      text: 'Email Opens',        page: 'opens'     },
      ]},
      { label: 'Team', items: [
        { icon: 'ti-building-community', text: 'Agents & hiring',  page: 'admin',    badge: b.inactiveAgents || null, badgeType: 'red' },
        { icon: 'ti-alert-triangle',     text: 'Oversight',        page: 'oversight' },
        { icon: 'ti-shield-check',       text: 'Compliance',       page: 'compliance'},
        { icon: 'ti-script',             text: 'Script Manager',   page: 'scripts'   },
      ]},
      { label: 'Account', items: [
        { icon: 'ti-settings',         text: 'Settings',           page: 'settings'  },
      ]},
    ],
    agent: [
      { label: 'My work', items: [
        { icon: 'ti-layout-dashboard', text: 'Dashboard',          page: 'dashboard'    },
        { icon: 'ti-bolt',             text: 'Work my leads',      page: 'dialer',   badge: b.notStarted || null, badgeType: 'green' },
        { icon: 'ti-users',            text: 'My contacts',        page: 'contacts'     },
        { icon: 'ti-layout-kanban',    text: 'My pipeline',        page: 'pipelines'    },
        { icon: 'ti-calendar-event',   text: 'Appointments',       page: 'appointments' },
      ]},
      { label: 'Funnels', items: [
        { icon: 'ti-send',             text: 'Email Campaigns',    page: 'campaigns' },
        { icon: 'ti-mail-opened',      text: 'Email Opens',        page: 'opens'     },
      ]},
      { label: 'Compliance', items: [
        { icon: 'ti-alert-triangle',   text: 'Oversight',          page: 'oversight' },
        { icon: 'ti-shield-check',     text: 'Compliance',         page: 'compliance'},
      ]},
      { label: 'Account', items: [
        { icon: 'ti-settings',         text: 'Settings',           page: 'settings'  },
      ]},
    ],
  };

  const sections = navConfig[role] || navConfig.agent;
  container.innerHTML = sections.map(sec => `
    <div class="sidebar-section-label">${sec.label}</div>
    ${sec.items.map(item => `
      <button id="nav-${item.page}" onclick="showPage('${item.page}')">
        <i class="ti ${item.icon} nav-icon"></i>${item.text}
        ${item.badge ? `<span class="${item.badgeType === 'green' ? 'nav-badge-green' : 'nav-badge'}">${item.badge}</span>` : ''}
      </button>
    `).join('')}
  `).join('');
}

// ============================================================
// DATA — role-filtered
// ============================================================
async function loadData() {
  let cq = supabaseClient.from('contacts').select('*');
  // agencyAgentIds declared here so count query below can reuse it
  let agencyAgentIds = [currentAgent.id];

  if (currentAgent.role === 'agent') {
    cq = cq.eq('agent_id', currentAgent.id);
  } else if (currentAgent.role === 'agency_owner') {
    // Fetch all agents in this agency so contacts without agency_id are included
    const { data: agencyAgentRows } = await supabaseClient
      .from('agents').select('id').eq('agency_id', currentAgent.agency_id);
    agencyAgentIds = [...new Set([
      currentAgent.id,
      ...((agencyAgentRows || []).map(a => a.id))
    ])];
    cq = cq.in('agent_id', agencyAgentIds);
  }
  // system_owner: no filter — sees all

  let dq = supabaseClient.from('deals').select('*');
  if (currentAgent.role === 'agent') dq = dq.eq('agent_id', currentAgent.id);
  else if (currentAgent.role === 'agency_owner') dq = dq.in('agent_id', agencyAgentIds);

  const queries = [
    cq.order('created_at', { ascending: false }).limit(10000),
    dq.order('created_at', { ascending: false })
  ];
  if (currentAgent.role === 'system_owner' || currentAgent.role === 'agency_owner') {
    queries.push(supabaseClient.from('agent_applications').select('*').order('created_at', { ascending: false }));
  }
  const results = await Promise.all(queries);
  contacts = results[0].data || [];
  deals = results[1].data || [];
  const { data: actData } = await supabaseClient.from('deal_activities').select('*').order('created_at', { ascending: false });
  dealActivities = actData || [];
  applications = (results[2] && results[2].data) || [];
  // Agency owner: scope deals to only those linked to their contacts (deals table has no agent_id)
  if (currentAgent.role === 'agency_owner') {
    const contactIds = new Set(contacts.map(c => c.id));
    deals = deals.filter(d => !d.contact_id || contactIds.has(d.contact_id));
  }

  // Get TRUE total count for ALL roles — bypasses PostgREST 1000-row cap
  let cntQ = supabaseClient.from('contacts').select('*', { count: 'exact', head: true });
  if (currentAgent.role === 'agent') {
    cntQ = cntQ.eq('agent_id', currentAgent.id);
  } else if (currentAgent.role === 'agency_owner') {
    cntQ = cntQ.in('agent_id', agencyAgentIds);
  }
  // system_owner: no filter
  const { count: trueCount } = await cntQ;
  totalContactCountFull = trueCount || 0;
  const { data: taskData } = await supabaseClient.from('deal_tasks').select('*').eq('user_id', currentUser.id).order('due_date', { ascending: true });
  dealTasks = taskData || [];
}

// ============================================================
// DASHBOARD — role-adaptive
// ============================================================
function renderDashboard() {
  const role = previewRole || currentAgent.role;
  if (role === 'system_owner') {
    renderDashboardOwner();
  } else if (role === 'agency_owner') {
    renderDashboardAgency();
  } else {
    renderDashboardAgent();
  }
}

function _dashGreeting(name) {
  const hour = new Date().getHours();
  const g = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (name || '').split(' ')[0] || 'there';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return { g, firstName, dateStr };
}

function _ctitle(icon, text) {
  return `<div class="dash-card-title"><i class="ti ${icon}"></i>${text}</div>`;
}

function _seqTable(contacts, totalContacts) {
  const maxStep = totalContacts || 1;
  const step1 = contacts.filter(c => c.sequence_step >= 1).length;
  const step2 = contacts.filter(c => c.sequence_step >= 2).length;
  const step3 = contacts.filter(c => c.sequence_step >= 3).length;
  const replied = contacts.filter(c => c.sequence_status === 'Replied').length;
  return `
    <div class="seq-row"><div><div class="seq-label">Email 1 — Introduction</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step1/maxStep*100)}%"></div></div></div><div class="seq-count">${step1}</div></div>
    <div class="seq-row"><div><div class="seq-label">Email 2 — Follow-up</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step2/maxStep*100)}%"></div></div></div><div class="seq-count">${step2}</div></div>
    <div class="seq-row"><div><div class="seq-label">Email 3 — Book a Call</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step3/maxStep*100)}%"></div></div></div><div class="seq-count">${step3}</div></div>
    <div class="seq-row"><div><div class="seq-label" style="color:#a78bfa;">Replied / Interested</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(replied/maxStep*100)}%;background:#8b5cf6;"></div></div></div><div class="seq-count" style="color:#a78bfa;">${replied}</div></div>
    <div style="margin-top:10px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage('opens')">View Email Opens &rarr;</button></div>`;
}

function renderDashAICard() {
  const el = document.getElementById('dash-ai-card');
  if (!el) return;
  const msgs = aiHistory.slice(-4);
  const msgsHtml = msgs.length === 0
    ? `<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Hi ${(currentAgent.name||'').split(' ')[0]} — ask me anything about your CRM data, contacts, or pipeline.</div>`
    : msgs.map(m => `<div style="background:${m.role==='user'?'var(--bg-accent)':'var(--surface-3)'};border:0.5px solid ${m.role==='user'?'rgba(200,168,75,0.25)':'var(--border)'};border-radius:7px;padding:8px 11px;font-size:12px;line-height:1.5;color:var(--text-primary);margin-bottom:5px;">${m.content.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')}</div>`).join('');
  el.innerHTML = `
    <div style="flex:1;overflow-y:auto;margin-bottom:8px;">${msgsHtml}</div>
    <div style="display:flex;gap:6px;">
      <input id="dash-ai-input" type="text" placeholder="Ask me to query, fix, or explain anything…" style="flex:1;border-radius:20px;padding:7px 12px;font-size:12px;background:var(--surface-3);border-color:var(--border);" onkeydown="if(event.key==='Enter')sendDashAIMessage()" />
      <button onclick="sendDashAIMessage()" style="width:30px;height:30px;border-radius:50%;background:var(--fill-accent);border:none;color:#000;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0;">&#10148;</button>
    </div>`;
}

function sendDashAIMessage() {
  const input = document.getElementById('dash-ai-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  sendAIMessage(text);
  setTimeout(renderDashAICard, 200);
}

function renderDashboardOwner() {
  const el = document.getElementById('page-dashboard');
  const { g, firstName, dateStr } = _dashGreeting(currentAgent.name);

  const totalContacts = totalContactCountFull || contacts.length;
  const inSequence   = contacts.filter(c => c.sequence_status === 'Active').length;
  const replied      = contacts.filter(c => c.sequence_status === 'Replied').length;
  const bounced      = contacts.filter(c => c.email_status === 'bounced').length;
  const optedOut     = contacts.filter(c => c.opt_out_email).length;
  const activeAgents = allAgents.filter(a => a.status === 'active' || !a.status).length;
  const pendingApps  = applications.length;
  const delivPct     = totalContacts > 0 ? Math.round((1 - bounced / totalContacts) * 100) : 100;

  const agencyMap = {};
  contacts.forEach(c => { if (c.agency_id) agencyMap[c.agency_id] = (agencyMap[c.agency_id] || 0) + 1; });
  const agencyRows = allAgencies.map(ag => ({
    name: ag.name || 'Unknown', id: ag.id,
    contactCount: agencyMap[ag.id] || 0,
    agentCount: allAgents.filter(a => a.agency_id === ag.id).length,
    replied: contacts.filter(c => c.agency_id === ag.id && c.sequence_status === 'Replied').length,
    openRate: agencyMap[ag.id] > 0 ? Math.round(contacts.filter(c => c.agency_id === ag.id && c.sequence_status === 'Replied').length / (agencyMap[ag.id] || 1) * 100) : 0,
  })).sort((a, b) => b.contactCount - a.contactCount);

  el.innerHTML = `
    <div class="dash-header">
      <div><div class="dash-greeting">${g}, ${firstName}</div><div class="dash-date">${dateStr}</div></div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="shareBookingLink()"><i class="ti ti-calendar"></i> Booking link</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('contacts');openAddContact()"><i class="ti ti-plus"></i> Add Lead</button>
        <button class="btn btn-outline btn-sm" onclick="syncGoogleContacts()"><i class="ti ti-refresh"></i> Sync</button>
      </div>
    </div>
    <div id="dash-needs-attention"></div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));">
      <div class="stat-card"><div class="stat-num">${totalContacts.toLocaleString()}</div><div class="stat-label">Total contacts</div><div class="stat-delta">+${contacts.filter(c=>{ const d=new Date(c.created_at); return (Date.now()-d)<30*86400000; }).length} this month</div></div>
      <div class="stat-card" style="border-left-color:#34d399;background:rgba(52,211,153,0.05);"><div class="stat-num">${activeAgents}</div><div class="stat-label">Active agents</div><div class="stat-delta">${pendingApps > 0 ? pendingApps+' pending' : 'All active'}</div></div>
      <div class="stat-card" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.05);"><div class="stat-num">${delivPct}%</div><div class="stat-label">Deliverability</div><div class="${bounced > 0 ? 'stat-delta-warn' : 'stat-delta'}">${bounced > 0 ? bounced+' bounces' : 'Clean list'}</div></div>
      <div class="stat-card" style="border-left-color:${bounced > 0 ? '#f87171' : '#34d399'};background:${bounced > 0 ? 'rgba(248,113,113,0.05)' : 'rgba(52,211,153,0.05)'};"><div class="stat-num">${bounced}</div><div class="stat-label">Bounces</div><div class="${bounced > 0 ? 'stat-delta-warn' : 'stat-delta'}">${bounced > 0 ? 'Needs review' : 'None flagged'}</div></div>
    </div>
    <div class="dash-grid">
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card">
          ${_ctitle('ti-activity', 'System health')}
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Supabase database</div><div class="action-item-sub">Project: ilrylhseqnllmejebozq</div></div><span class="badge badge-active"><i class="ti ti-check"></i> Operational</span></div>
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Vercel deploy</div><div class="action-item-sub">Auto-deploy on push</div></div><span class="badge badge-active"><i class="ti ti-check"></i> Live</span></div>
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Email sequences</div><div class="action-item-sub">Apps Script trigger</div></div><span class="badge badge-active"><i class="ti ti-check"></i> Running</span></div>
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Bounce flags</div><div class="action-item-sub">${bounced} flagged contacts</div></div>${bounced > 0 ? `<button class="btn btn-outline btn-sm" onclick="showPage('compliance')">Review</button>` : `<span class="badge badge-active"><i class="ti ti-check"></i> Clean</span>`}</div>
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Opted out</div><div class="action-item-sub">${optedOut} suppressed</div></div><span class="badge badge-completed">${optedOut}</span></div>
          ${pendingApps > 0 ? `<div class="action-item"><div class="action-item-info"><div class="action-item-name">Agent applications</div><div class="action-item-sub">${pendingApps} pending review</div></div><button class="btn btn-primary btn-sm" onclick="showPage('admin')">Review</button></div>` : ''}
        </div>
        <div class="dash-card">
          ${_ctitle('ti-building-community', 'Agency snapshot')}
          ${agencyRows.length === 0 ? `<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No agencies yet.</p>` : `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr>
              <th style="text-align:left;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Agency</th>
              <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Agents</th>
              <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Contacts</th>
              <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Replies</th>
              <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Open rate</th>
            </tr></thead>
            <tbody>${agencyRows.map(ag => `<tr>
              <td style="padding:7px 0;border-bottom:0.5px solid var(--border);font-weight:500;color:var(--text-primary);">${ag.name}</td>
              <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);color:var(--text-secondary);">${ag.agentCount}</td>
              <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);font-weight:500;">${ag.contactCount.toLocaleString()}</td>
              <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);color:var(--text-success);">${ag.replied}</td>
              <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);color:var(--text-accent);">${ag.openRate}%</td>
            </tr>`).join('')}</tbody>
          </table>`}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card" style="flex:1;display:flex;flex-direction:column;min-height:320px;">
          ${_ctitle('ti-robot', 'AI assistant')}
          <div id="dash-ai-card" style="flex:1;display:flex;flex-direction:column;background:var(--surface-1);border:0.5px solid rgba(200,168,75,0.2);border-radius:8px;padding:11px;overflow:hidden;"></div>
          <div style="margin-top:8px;text-align:right;">
            <button class="btn btn-outline btn-sm" onclick="toggleAIPanel()"><i class="ti ti-external-link"></i> Open full panel</button>
          </div>
        </div>
        <div class="dash-card">
          ${_ctitle('ti-mail-opened', 'Outreach sequence')}
          ${_seqTable(contacts, totalContacts)}
        </div>
      </div>
    </div>
  `;
  renderDashAICard();
  loadNeedsAttention();
}

function renderDashboardAgency() {
  const el = document.getElementById('page-dashboard');
  const { g, firstName, dateStr } = _dashGreeting(currentAgent.name);
  const agencyName = currentAgent.agencies?.name || 'Your agency';

  const totalContacts = totalContactCountFull || contacts.length;
  const inSequence   = contacts.filter(c => c.sequence_status === 'Active').length;
  const replied      = contacts.filter(c => c.sequence_status === 'Replied').length;
  const pendingApps  = applications.length;
  const openRatePct  = totalContacts > 0 ? Math.round(replied / totalContacts * 100) : 0;

  const myAgents = allAgents.filter(a => a.agency_id === currentAgent.agency_id);
  const agentCMap = {}, agentRMap = {}, agentDMap = {};
  contacts.forEach(c => { if (c.agent_id) agentCMap[c.agent_id] = (agentCMap[c.agent_id] || 0) + 1; });
  contacts.filter(c => c.sequence_status === 'Replied').forEach(c => { if (c.agent_id) agentRMap[c.agent_id] = (agentRMap[c.agent_id] || 0) + 1; });
  // Deals table has user_id, not agent_id — cross-ref through contacts
  contacts.forEach(c => {
    const agentDeals = deals.filter(d => d.contact_id === c.id).length;
    if (agentDeals > 0 && c.agent_id) agentDMap[c.agent_id] = (agentDMap[c.agent_id] || 0) + agentDeals;
  });
  const ranked = myAgents.map(a => ({ ...a, cnt: agentCMap[a.id] || 0, rep: agentRMap[a.id] || 0, dls: agentDMap[a.id] || 0 })).sort((a, b) => b.cnt - a.cnt);
  const medals = ['🥇','🥈','🥉'];

  // Campaign-level stats from deals by type/stage
  const activeCampaigns = [
    { name: 'State Farm sequence', contacts: contacts.filter(c=>c.type==='Recruit').length, open: openRatePct },
    { name: 'B2B group track', contacts: contacts.filter(c=>c.type==='Group/Employer').length, open: 0 },
    { name: 'B2C individual track', contacts: contacts.filter(c=>c.type==='Individual/Family').length, open: 0 },
  ].filter(c => c.contacts > 0);

  el.innerHTML = `
    <div class="dash-header">
      <div><div class="dash-greeting">${g}, ${firstName}</div><div class="dash-date">${dateStr} &nbsp; | &nbsp; <span style="color:var(--text-muted);">${agencyName}</span></div></div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="shareBookingLink()"><i class="ti ti-calendar"></i> Booking link</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('contacts');openAddContact()"><i class="ti ti-plus"></i> Add Lead</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('dialer')"><i class="ti ti-bolt"></i> Work leads</button>
      </div>
    </div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:8px;">
      <div class="stat-card"><div class="stat-num">${totalContacts.toLocaleString()}</div><div class="stat-label">Agency contacts</div></div>
      <div class="stat-card" style="border-left-color:#34d399;background:rgba(52,211,153,0.05);"><div class="stat-num">${inSequence}</div><div class="stat-label">In sequence</div></div>
      <div class="stat-card" style="border-left-color:#c8a84b;background:rgba(200,168,75,0.05);"><div class="stat-num">${openRatePct}%</div><div class="stat-label">Open rate</div></div>
      <div class="stat-card" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.05);"><div class="stat-num">${pendingApps}</div><div class="stat-label">Pending hires</div><div class="${pendingApps > 0 ? 'stat-delta-warn' : 'stat-delta'}">${pendingApps > 0 ? 'Needs review' : 'None pending'}</div></div>
    </div>
    ${(() => {
      const _aN = new Date();
      const _aWL = contacts.filter(c => c.sequence_status === 'not started' && c.notes && c.notes.includes('[Web Lead') && Math.floor((_aN - new Date(c.created_at)) / 86400000) <= 30).length;
      const _aSt = contacts.filter(c => c.sequence_status === 'Active' && Math.floor((_aN - new Date(c.last_called_at || 0)) / 86400000) >= 5).length;
      const _aDr = contacts.filter(c => c.sequence_status === 'Drip').length;
      const _aF  = ['Enrolled','Active Client','Contracted','Active Agent'];
      const _aAM = {}; dealActivities.forEach(a => { if (!_aAM[a.deal_id] || new Date(a.created_at) > new Date(_aAM[a.deal_id])) _aAM[a.deal_id] = a.created_at; });
      const _aSD = deals.filter(d => !_aF.includes(d.stage) && Math.floor((_aN - new Date(_aAM[d.id] || d.created_at)) / 86400000) >= 7).length;
      return '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px;" title="Exceptions — click any to open Oversight">'
        + '<div style="padding:7px 12px;border-radius:8px;border:0.5px solid #fecaca;background:rgba(239,68,68,0.05);border-left:3px solid #ef4444;cursor:pointer;" onclick="showPage(\'oversight\')">'
        + '<div style="font-size:16px;font-weight:700;color:#ef4444;line-height:1.2;">' + _aWL + '</div>'
        + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Web leads untouched</div></div>'
        + '<div style="padding:7px 12px;border-radius:8px;border:0.5px solid #fde68a;background:rgba(245,158,11,0.05);border-left:3px solid #f59e0b;cursor:pointer;" onclick="showPage(\'oversight\')">'
        + '<div style="font-size:16px;font-weight:700;color:#f59e0b;line-height:1.2;">' + _aSt + '</div>'
        + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Stalled in sequence</div></div>'
        + '<div style="padding:7px 12px;border-radius:8px;border:0.5px solid #bfdbfe;background:rgba(59,130,246,0.05);border-left:3px solid #3b82f6;cursor:pointer;" onclick="showPage(\'oversight\')">'
        + '<div style="font-size:16px;font-weight:700;color:#3b82f6;line-height:1.2;">' + _aDr + '</div>'
        + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">In drip campaign</div></div>'
        + '<div style="padding:7px 12px;border-radius:8px;border:0.5px solid #e9d5ff;background:rgba(139,92,246,0.05);border-left:3px solid #8b5cf6;cursor:pointer;" onclick="showPage(\'oversight\')">'
        + '<div style="font-size:16px;font-weight:700;color:#8b5cf6;line-height:1.2;">' + _aSD + '</div>'
        + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Stalled pipeline deals</div></div>'
        + '</div>';
    })()}
    <div class="dash-grid">
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card">
          ${_ctitle('ti-trophy', 'Agent leaderboard — this month')}
          ${ranked.length === 0
            ? `<p style="font-size:13px;color:var(--text-muted);text-align:center;padding:16px 0;">No agents yet.</p>`
            : `<table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr>
                  <th style="text-align:left;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Agent</th>
                  <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Leads</th>
                  <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Replies</th>
                  <th style="text-align:right;font-size:10px;font-weight:500;color:var(--text-muted);padding:5px 0;border-bottom:0.5px solid var(--border);text-transform:uppercase;letter-spacing:0.5px;">Deals</th>
                </tr></thead>
                <tbody>${ranked.map((a,i) => `<tr>
                  <td style="padding:7px 0;border-bottom:0.5px solid var(--border);">${medals[i]||''} ${a.name||a.email}</td>
                  <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);font-weight:500;">${a.cnt}</td>
                  <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);color:var(--text-success);">${a.rep}</td>
                  <td style="text-align:right;padding:7px 0;border-bottom:0.5px solid var(--border);color:var(--text-accent);">${a.dls}</td>
                </tr>`).join('')}</tbody>
              </table>`}
        </div>
        ${pendingApps > 0 ? `
        <div class="dash-card">
          ${_ctitle('ti-clipboard-list', `Pending applications <span style="background:rgba(251,191,36,0.2);color:var(--text-warning);border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">${pendingApps}</span>`)}
          ${applications.slice(0,4).map(app => `
          <div class="action-item">
            <div class="action-item-info">
              <div class="action-item-name">${app.name || app.email}</div>
              <div class="action-item-sub">${app.license_type || 'Track not set'} &middot; ${new Date(app.created_at).toLocaleDateString()}</div>
            </div>
            <button class="btn btn-outline btn-sm" onclick="showPage('admin')">Review</button>
          </div>`).join('')}
        </div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card">
          ${_ctitle('ti-mail', 'Campaign performance')}
          ${activeCampaigns.length === 0
            ? `<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No active campaigns.</p>`
            : activeCampaigns.map(c => `
          <div class="activity-item">
            <div class="activity-dot"></div>
            <div style="flex:1;">
              <div class="activity-text"><strong>${c.name}</strong> — ${c.contacts.toLocaleString()} contacts${c.open ? ' &middot; ' + c.open + '% open' : ''}</div>
            </div>
            <span class="badge badge-active">Active</span>
          </div>`).join('')}
          <div style="margin-top:10px;">
            <button class="btn btn-outline btn-sm btn-full" onclick="showPage('campaigns')"><i class="ti ti-plus"></i> Create campaign</button>
          </div>
        </div>
        <div class="dash-card">
          ${_ctitle('ti-mail-opened', 'Outreach sequence')}
          ${_seqTable(contacts, totalContacts)}
        </div>
      </div>
    </div>
  `;
}








function renderDashboardAgent() {
  const el = document.getElementById('page-dashboard');
  const { g, firstName, dateStr } = _dashGreeting(currentAgent.name);

  const totalContacts = totalContactCountFull || contacts.length;
  const hotLeads      = contacts.filter(c => c.sequence_status === 'Replied' || c.sequence_status === 'Interested');
  const freshLeads    = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started' || c.sequence_status === 'not_started' || c.sequence_status === 'Fresh');
  const inSequence    = contacts.filter(c => c.sequence_status === 'Active').length;
  const activeDeals   = deals.filter(d => !['Enrolled','Active Client','Active Agent','Contracted'].includes(d.stage)).length;

  const today         = new Date().toISOString().slice(0, 10);
  const openTasks     = (typeof dealTasks !== 'undefined' ? dealTasks : []).filter(t => !t.completed);
  const tasksDueCount = openTasks.filter(t => t.due_date && t.due_date <= today).length;

  const todayAppts = (calAppointments || []).filter(a => {
    const d = (a.start_time || a.scheduled_at || a.date || '').slice(0, 10);
    return d === today;
  });

  const stageOrder = PIPELINES['group-employer'].stages.slice(0, 4);
  const stageMap   = {};
  deals.forEach(d => { if (!stageMap[d.stage]) stageMap[d.stage] = []; stageMap[d.stage].push(d); });
  const initials = name => (name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  // Oversight mini-bar counts
  const _ovNow = new Date();
  const _ovWebLeads = contacts.filter(c => c.sequence_status === 'not started' && c.notes && c.notes.includes('[Web Lead') && Math.floor((_ovNow - new Date(c.created_at)) / 86400000) <= 30).length;
  const _ovStalled  = contacts.filter(c => c.sequence_status === 'Active' && Math.floor((_ovNow - new Date(c.last_called_at || 0)) / 86400000) >= 5).length;
  const _ovDrip     = contacts.filter(c => c.sequence_status === 'Drip').length;
  const _ovFinal    = ['Enrolled','Active Client','Contracted','Active Agent'];
  const _ovActMap   = {};
  dealActivities.forEach(a => { if (!_ovActMap[a.deal_id] || new Date(a.created_at) > new Date(_ovActMap[a.deal_id])) _ovActMap[a.deal_id] = a.created_at; });
  const _ovStalledDeals = deals.filter(d => !_ovFinal.includes(d.stage) && Math.floor((_ovNow - new Date(_ovActMap[d.id] || d.created_at)) / 86400000) >= 7).length;

  el.innerHTML = `
    <div class="dash-header" style="margin-bottom:10px;">
      <div><div class="dash-greeting">${g}, ${firstName}</div><div class="dash-date">${dateStr}</div></div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-outline btn-sm" onclick="shareBookingLink()"><i class="ti ti-calendar"></i> Booking link</button>
        <button class="btn btn-primary btn-sm" onclick="startDialerSession()" style="background:var(--accent);border-color:var(--accent);font-weight:700;"><i class="ti ti-bolt"></i> Work Leads</button>
      </div>
    </div>

    <div class="stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:8px;">
      <div class="stat-card"><div class="stat-num">${totalContacts.toLocaleString()}</div><div class="stat-label">Total contacts</div></div>
      <div class="stat-card" style="border-left-color:#34d399;background:rgba(52,211,153,0.05);"><div class="stat-num">${inSequence}</div><div class="stat-label">In sequence</div></div>
      <div class="stat-card" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.05);cursor:pointer;" onclick="showPage('pipelines')"><div class="stat-num">${activeDeals}</div><div class="stat-label">Active deals</div></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:8px;" title="Exceptions — click any to open Oversight">
      <div style="padding:7px 12px;border-radius:8px;border:0.5px solid #fecaca;background:rgba(239,68,68,0.05);border-left:3px solid #ef4444;cursor:pointer;" onclick="showPage('oversight')">
        <div style="font-size:16px;font-weight:700;color:#ef4444;line-height:1.2;">${_ovWebLeads}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Web leads untouched</div>
      </div>
      <div style="padding:7px 12px;border-radius:8px;border:0.5px solid #fde68a;background:rgba(245,158,11,0.05);border-left:3px solid #f59e0b;cursor:pointer;" onclick="showPage('oversight')">
        <div style="font-size:16px;font-weight:700;color:#f59e0b;line-height:1.2;">${_ovStalled}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Stalled in sequence</div>
      </div>
      <div style="padding:7px 12px;border-radius:8px;border:0.5px solid #bfdbfe;background:rgba(59,130,246,0.05);border-left:3px solid #3b82f6;cursor:pointer;" onclick="showPage('oversight')">
        <div style="font-size:16px;font-weight:700;color:#3b82f6;line-height:1.2;">${_ovDrip}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">In drip campaign</div>
      </div>
      <div style="padding:7px 12px;border-radius:8px;border:0.5px solid #e9d5ff;background:rgba(139,92,246,0.05);border-left:3px solid #8b5cf6;cursor:pointer;" onclick="showPage('oversight')">
        <div style="font-size:16px;font-weight:700;color:#8b5cf6;line-height:1.2;">${_ovStalledDeals}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Stalled pipeline deals</div>
      </div>
    </div>

    <div class="dash-card" style="margin-bottom:10px;background:var(--surface-1);border-color:var(--border);">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
        <button onclick="showPage('dialer')" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;border:1px solid rgba(167,139,250,0.35);background:rgba(167,139,250,0.1);color:var(--text-primary);font-size:13px;cursor:pointer;">
          🔥 <strong style="color:#a78bfa;">${hotLeads.length}</strong> Hot Lead${hotLeads.length !== 1 ? 's' : ''}
        </button>
        <button onclick="viewEmailOpeners()" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;border:1px solid rgba(56,189,248,0.35);background:rgba(56,189,248,0.1);color:var(--text-primary);font-size:13px;cursor:pointer;">
          📧 <strong style="color:#38bdf8;" id="dash-opens-count">—</strong> Email Opens
        </button>
        <button onclick="viewFreshLeads()" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;border:1px solid rgba(245,158,11,0.35);background:rgba(245,158,11,0.1);color:var(--text-primary);font-size:13px;cursor:pointer;">
          🌱 <strong style="color:#f59e0b;">${freshLeads.length}</strong> Fresh Lead${freshLeads.length !== 1 ? 's' : ''}
        </button>
        <button onclick="showPage('contacts');openAddContact()" style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;border-radius:20px;border:none;background:#16a34a;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 0 8px rgba(22,163,74,0.4);"><i class="ti ti-plus"></i> Add new lead</button>
      </div>
    </div>

    <div id="dash-needs-attention"></div>

    <div class="dash-grid" style="align-items:stretch;margin-bottom:10px;">

      <div style="display:grid;grid-template-rows:1fr 1fr;gap:10px;">
        <div class="dash-card" style="overflow:auto;">
          ${_ctitle('ti-calendar-event', "Today's appointments" + (todayAppts.length > 0 ? ' <span style="background:rgba(52,211,153,0.15);color:#34d399;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">' + todayAppts.length + '</span>' : ''))}
          ${todayAppts.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px 0;"><i class="ti ti-calendar" style="font-size:22px;display:block;margin-bottom:4px;"></i>No appointments today</div>
               <div style="margin-top:6px;"><button class="btn btn-outline btn-sm btn-full" onclick="shareBookingLink()">Share booking link</button></div>`
            : todayAppts.map(a => {
                const apptName = a.prospect_name || a.name || 'Appointment';
                const apptTime = a.start_time
                  ? new Date(a.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                  : (a.scheduled_at ? new Date(a.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
                const apptType = a.appointment_type || a.type || '';
                return `<div class="action-item" style="padding:6px 0;">
                  <div class="action-item-info">
                    <div class="action-item-name" style="font-size:12px;">${apptName}</div>
                    <div class="action-item-sub">${apptTime}${apptType ? ' &middot; ' + apptType : ''}</div>
                  </div>
                  <span class="badge badge-active">Today</span>
                </div>`;
              }).join('')}
        </div>
        ${typeof renderTasksWidget === 'function' ? renderTasksWidget() : '<div class="dash-card"></div>'}
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card" style="flex:1;display:flex;flex-direction:column;overflow:auto;">
          ${_ctitle('ti-flame', 'Hot leads' + (hotLeads.length > 0 ? ' <span style="background:rgba(167,139,250,0.2);color:#a78bfa;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">' + hotLeads.length + '</span>' : ''))}
          ${hotLeads.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:16px 0;"><i class="ti ti-inbox" style="font-size:24px;display:block;margin-bottom:6px;"></i>No hot leads yet — keep working your contacts!<br><button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="startDialerSession()"><i class="ti ti-bolt"></i> Start a lead session</button></div>`
            : hotLeads.slice(0, 8).map(c => {
                const noteLines   = (c.notes || '').trim().split('\n');
                // Prefer reply subject line (starts with "Subject:") then any non-bracket line
                const rawSnippetLine = noteLines.find(l => l.trim().startsWith('Subject:')) || noteLines.find(l => l.trim() && !l.startsWith('[')) || '';
                const noteSnippet = rawSnippetLine.replace(/^Subject:\s*/i, '');
                const stepCtx     = c.sequence_step ? 'Email ' + c.sequence_step + ' sent' : '';
                return `<div style="padding:8px 0;border-bottom:0.5px solid var(--border);">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <div style="width:28px;height:28px;border-radius:50%;background:var(--surface-3);border:0.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:var(--text-secondary);flex-shrink:0;">${initials(c.name)}</div>
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:12px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name || '&#8212;'}</div>
                      <div style="font-size:11px;color:var(--text-muted);">${c.company || c.email || '&#8212;'}</div>
                    </div>
                    <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;white-space:nowrap;background:${c.sequence_status==='Interested'?'rgba(251,191,36,0.15)':'rgba(52,211,153,0.15)'};color:${c.sequence_status==='Interested'?'#f59e0b':'#34d399'};">${c.sequence_status}</span>
                  </div>
                  ${stepCtx || noteSnippet
                    ? '<div style="margin:4px 0 0 36px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">'
                      + (stepCtx ? '<span style="font-size:10px;background:rgba(99,102,241,0.12);color:#818cf8;border-radius:6px;padding:1px 6px;white-space:nowrap;">' + stepCtx + '</span>' : '')
                      + (noteSnippet ? '<span style="font-size:11px;color:' + (c.sequence_status==='Replied'?'#34d399':'var(--text-muted)') + ';font-style:italic;">&ldquo;' + (noteSnippet.length > 70 ? noteSnippet.slice(0, 70) + '...' : noteSnippet) + '&rdquo;</span>' : '')
                      + '</div>'
                    : ''}
                  <div style="margin:6px 0 0 36px;display:flex;gap:6px;">
                    <button class="btn btn-outline btn-sm" style="font-size:11px;" onclick="openCallScript('${c.id}')">&#128222; Call</button>
                    <button class="btn btn-outline btn-sm" style="font-size:11px;" onclick="viewContact('${c.id}','')">View &rarr;</button>
                  </div>
                </div>`;
              }).join('')}
          ${hotLeads.length > 0 ? `<div style="margin-top:auto;padding-top:8px;">
            ${hotLeads.length > 8 ? `<button class="btn btn-outline btn-sm btn-full" style="margin-bottom:6px;" onclick="showPage('contacts')">See all ${hotLeads.length} hot leads &rarr;</button>` : ''}
            <button class="btn btn-primary btn-sm btn-full" onclick="startDialerSession('replied')"><i class="ti ti-bolt"></i> Call all hot leads now</button>
          </div>` : ''}
        </div>
        ${!currentAgent.gmail_connected ? `<div class="dash-card" style="border-color:rgba(251,191,36,0.4);background:rgba(251,191,36,0.04);">
          ${_ctitle('ti-mail', 'Gmail not connected')}
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Connect Gmail to send outreach emails directly from Kannon.</div>
          <button class="btn btn-primary btn-sm" onclick="showGmailSetup(true)">Connect Gmail</button>
        </div>` : ''}
      </div>

    </div>

    <div class="dash-card" style="margin-top:0;">
      ${_ctitle('ti-layout-kanban', 'Pipeline snapshot')}
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;">
        ${stageOrder.map(stage => {
          const stagDeals = stageMap[stage] || [];
          return `<div style="background:var(--surface-1);border-radius:8px;padding:8px;border:0.5px solid var(--border);">
            <div style="font-size:10px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">${stage}</div>
            ${stagDeals.length === 0
              ? '<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">&#8212;</div>'
              : stagDeals.slice(0, 3).map(d => `<div style="background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:5px 7px;margin-bottom:3px;"><div style="font-size:11px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.title}</div>${d.value ? `<div style="font-size:11px;color:var(--text-success);">$${parseFloat(d.value).toLocaleString()}</div>` : ''}</div>`).join('')}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:10px;">
        <button class="btn btn-outline btn-sm btn-full" onclick="showPage('pipelines')"><i class="ti ti-external-link"></i> Full pipeline view</button>
      </div>
    </div>
  `;

  loadDashEmailOpens();
  loadNeedsAttention();
  _initEmailOpenRealtime();
}

async function loadDashEmailOpens() {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  let openQ = supabaseClient.from('email_opens').select('*').gte('opened_at', cutoff).order('opened_at', { ascending: false }).limit(50);
  if (currentAgent && currentAgent.role !== 'system_owner') openQ = openQ.eq('agent_id', currentAgent.id);
  const { data: opens, error } = await openQ;
  window._dashOpens = (error || !opens) ? [] : opens;
  const el = document.getElementById('dash-opens-count');
  if (el) el.textContent = window._dashOpens.length || '0';
}

function _initEmailOpenRealtime() {
  if (window._emailOpenRealtimeChannel) return;
  window._emailOpenRealtimeChannel = supabaseClient
    .channel('email-opens-rt')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'email_opens' }, function(payload) {
      var row = payload.new;
      if (!window._dashOpens) window._dashOpens = [];
      window._dashOpens.unshift(row);
      var el = document.getElementById('dash-opens-count');
      if (el) el.textContent = window._dashOpens.length || '0';
      var email = (row.contact_email || '').toLowerCase();
      var contact = contacts.find(function(c) { return (c.email||'').toLowerCase() === email; });
      var name = contact ? (contact.name || email) : (email || 'Someone');
      showToast('📬 ' + name + ' just opened your email!');
      if (dialerQueue.length > 0 && dialerIndex >= 0) {
        var cur = dialerQueue[dialerIndex];
        if (cur && (cur.email||'').toLowerCase() === email) {
          renderDialer();
        }
      }
    })
    .subscribe();
}

function viewEmailOpeners() {
  const opens = window._dashOpens || [];
  opensFilter = [...new Set(opens.map(o => (o.contact_email || '').toLowerCase()).filter(Boolean))];
  _quickFilterLabel = 'Recent Email Openers';
  contactSearch = '';
  contactTypeFilter = '';
  showPage('contacts');
  renderContacts();
}

function viewFreshLeads() {
  const fresh = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started' || c.sequence_status === 'not_started' || c.sequence_status === 'Fresh');
  opensFilter = [...new Set(fresh.map(c => (c.email || '').toLowerCase()).filter(Boolean))];
  _quickFilterLabel = 'Fresh Leads';
  contactSearch = '';
  contactTypeFilter = '';
  showPage('contacts');
  renderContacts();
}

function _dashTimeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}


// [legacy vars kept for reference — now split into three functions above]
function renderDashboard_UNUSED() {
  const totalContacts = contacts.length;
  const inSequence = contacts.filter(c => c.sequence_status === 'Active').length;
  const replied = contacts.filter(c => c.sequence_status === 'Replied').length;
  const activeDeals = deals.filter(d => !['Enrolled','Active Client','Active Agent','Contracted'].includes(d.stage)).length;
  const totalValue = deals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);
  const step1 = contacts.filter(c => c.sequence_step >= 1).length;
  const step2 = contacts.filter(c => c.sequence_step >= 2).length;
  const step3 = contacts.filter(c => c.sequence_step >= 3).length;
  const maxStep = totalContacts || 1;
  const notStarted = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started').slice(0, 5);
  const recentDeals = [...deals].slice(0, 5);
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const firstName = (currentAgent.name || '').split(' ')[0] || 'there';

  const scopeNote = currentAgent.role === 'agent'
    ? `<span style="font-size:13px;color:var(--muted);margin-left:10px;">Your contacts only</span>`
    : currentAgent.role === 'agency_owner'
    ? `<span style="font-size:13px;color:var(--muted);margin-left:10px;">${currentAgent.agencies?.name || 'Your agency'}</span>`
    : '';

  document.getElementById('page-dashboard').innerHTML = `
    <div class="dash-header">
      <div>
        <div class="dash-greeting">${greeting}, ${firstName}! &#128075; ${scopeNote}</div>
        <div class="dash-date">${dateStr}</div>
      </div>
      <button class="btn btn-outline" onclick="shareBookingLink()">&#128197; Share Booking Link</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${totalContacts}</div><div class="stat-label">Total Contacts</div></div>
      <div class="stat-card" style="border-left-color:#3b82f6;"><div class="stat-num">${inSequence}</div><div class="stat-label">In Outreach Sequence</div></div>
      <div class="stat-card" style="border-left-color:#8b5cf6;"><div class="stat-num">${replied}</div><div class="stat-label">Replied / Interested</div></div>
      <div class="stat-card" style="border-left-color:#10b981;"><div class="stat-num">${activeDeals}</div><div class="stat-label">Active Deals</div></div>
      <div class="stat-card" style="border-left-color:#f59e0b;"><div class="stat-num">$${totalValue > 0 ? totalValue.toLocaleString() : '0'}</div><div class="stat-label">Pipeline Value</div></div>
    </div>

    <div class="quick-actions">
      <button class="qa-btn" onclick="showPage('contacts'); openAddContact()">&#43; Add Lead</button>
      <button class="qa-btn" onclick="shareBookingLink()">&#128197; Book Meeting</button>
      <button class="qa-btn" onclick="showPage('opens')">&#128140; Email Opens</button>
      <button class="qa-btn" onclick="showPage('pipelines')">&#128202; Pipelines</button>
      <button class="qa-btn" onclick="showPage('contacts')">&#128101; All Contacts</button>
      <button class="qa-btn" onclick="syncGoogleContacts()">&#128257; Sync Google</button>
      ${(currentAgent.role === 'system_owner' || currentAgent.role === 'agency_owner') ? `<button class="qa-btn" onclick="showPage('admin')">&#9881;&#65039; Admin</button>` : ''}
    </div>

    <div class="dash-grid">
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="dash-card">
          <div class="dash-card-title">&#9888;&#65039; Action Items <span style="background:#fef3c7;color:#92400e;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700;">${notStarted.length} not started</span></div>
          ${notStarted.length === 0
            ? '<div style="font-size:13px;color:var(--muted);text-align:center;padding:20px 0;">&#127881; All contacts are in the sequence!</div>'
            : notStarted.map(c => `
              <div class="action-item">
                <div class="action-item-info">
                  <div class="action-item-name">${c.name || '—'}</div>
                  <div class="action-item-sub">${c.company || c.email || '—'}</div>
                </div>
                <button class="btn btn-outline btn-sm" onclick="viewContact('${c.id}','')">View</button>
              </div>`).join('')}
          ${notStarted.length > 0 ? `<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage('contacts')">View all &rarr;</button></div>` : ''}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">&#128295; Automation Status</div>
          <div class="action-item">
            <div class="action-item-info"><div class="action-item-name">Email Outreach</div><div class="action-item-sub">Apps Script trigger</div></div>
            <span class="badge badge-active">&#10003; Active</span>
          </div>
          <div class="action-item">
            <div class="action-item-info"><div class="action-item-name">Email Open Tracking</div><div class="action-item-sub">Supabase Edge Function</div></div>
            <span class="badge badge-active">&#10003; Active</span>
          </div>
          <div class="action-item">
            <div class="action-item-info"><div class="action-item-name">Google Contacts Sync</div><div class="action-item-sub">Daily 2am • Two-way</div></div>
            <span class="badge badge-active">&#10003; Active</span>
          </div>
          <div class="action-item">
            <div class="action-item-info">
              <div class="action-item-name">Your Gmail</div>
              <div class="action-item-sub">${currentAgent.gmail_connected ? (currentAgent.gmail_email || 'Connected') : 'Not connected — replies not tracked'}</div>
            </div>
            ${currentAgent.gmail_connected ? '<span class="badge badge-active">&#10003; Connected</span>' : '<button class="btn btn-accent btn-sm" onclick="showGmailSetup(true)">Connect</button>'}
          </div>
        </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="dash-card">
          <div class="dash-card-title">&#128140; Outreach Sequence Status</div>
          <div class="seq-row"><div><div class="seq-label">Email 1 — Introduction</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step1/maxStep*100)}%"></div></div></div><div class="seq-count">${step1}</div></div>
          <div class="seq-row"><div><div class="seq-label">Email 2 — Follow-up (Day 3)</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step2/maxStep*100)}%"></div></div></div><div class="seq-count">${step2}</div></div>
          <div class="seq-row"><div><div class="seq-label">Email 3 — Book a Call (Day 7)</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(step3/maxStep*100)}%"></div></div></div><div class="seq-count">${step3}</div></div>
          <div class="seq-row"><div><div class="seq-label" style="color:#5b21b6;font-weight:700;">Replied / Interested &#127881;</div><div class="seq-bar-track"><div class="seq-bar-fill" style="width:${Math.round(replied/maxStep*100)}%;background:#8b5cf6;"></div></div></div><div class="seq-count" style="color:#5b21b6;">${replied}</div></div>
          <div style="margin-top:12px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage('opens')">View Email Opens &rarr;</button></div>
        </div>
        <div class="dash-card">
          <div class="dash-card-title">&#128337; Recent Deals</div>
          ${recentDeals.length === 0
            ? '<div style="font-size:13px;color:var(--muted);text-align:center;padding:20px 0;">No deals yet. Add your first deal!</div>'
            : recentDeals.map(d => {
                const contact = contacts.find(c => c.id === d.contact_id);
                return `<div class="activity-item"><div class="activity-dot"></div><div>
                  <div class="activity-text"><strong>${d.title}</strong></div>
                  <div class="activity-time">${contact ? contact.name : 'No contact'} &middot; ${d.stage}${d.value ? ' &middot; $' + parseFloat(d.value).toLocaleString() : ''}</div>
                </div></div>`;
              }).join('')}
        </div>
      </div>
    </div>
  `;
}

function switchPreviewRole(role) {
  previewRole = role;
  // Update tab highlight
  ['owner','agency','agent'].forEach(r => {
    const btn = document.getElementById('rsw-' + (r === 'owner' ? 'owner' : r === 'agency' ? 'agency' : 'agent'));
    if (!btn) return;
    const isActive = (role === 'system_owner' && r === 'owner') || (role === 'agency_owner' && r === 'agency') || (role === 'agent' && r === 'agent');
    btn.style.background = isActive ? 'var(--surface-2)' : 'none';
    btn.style.color = isActive ? 'var(--text-primary)' : 'var(--text-muted)';
    btn.style.fontWeight = isActive ? '500' : '400';
  });
  renderSidebarNav();
  renderDashboard();
}

function shareBookingLink() { manageBookingTypes(); }

async function sendBookingLinkEmail(toEmail, firstName, lastName, personalNote, contactTypeRaw) {
  if (!toEmail || !toEmail.includes('@')) { showToast('Enter a valid email address.'); return; }
  if (!firstName) { showToast("Enter the recipient's first name."); return; }

  // Must have Gmail connected
  if (!currentAgent.gmail_connected) {
    showToast('⚠ Connect your Gmail first (Settings → Gmail Connect)', 5000);
    return;
  }

  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'PASTE_APPS_SCRIPT_URL_HERE') {
    showToast('⚠ Apps Script URL not configured.'); return;
  }

  const toName = [firstName, lastName].filter(Boolean).join(' ');

  // Parse type — recruits encode pipeline as "Recruit|agent-kannon"
  const typeRaw      = contactTypeRaw || 'Individual/Family';
  const typeParts    = typeRaw.split('|');
  const contactType  = typeParts[0];   // e.g. 'Recruit' or 'Individual/Family'
  const pipelineMap  = {
    'Individual/Family': { pipeline: 'individual-family', stage: 'Contacted' },
    'Group/Employer':    { pipeline: 'group-employer',    stage: 'Outreach Sent' },
    'Recruit|agent-kannon':   { pipeline: 'agent-kannon',   stage: 'Contacted' },
    'Recruit|agent-insured':  { pipeline: 'agent-insured',  stage: 'Contacted' },
  };
  const pipeInfo = pipelineMap[typeRaw] || pipelineMap['Individual/Family'];
  const btn = document.querySelector('#booking-modal-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    // ── Step 1: Find or create contact directly in Supabase ──
    let contactId = null;
    const { data: existing, error: lookupErr } = await supabaseClient
      .from('contacts')
      .select('id, name, type')
      .eq('email', toEmail.toLowerCase())
      .eq('agent_id', currentAgent.id)
      .limit(1);

    if (existing && existing.length > 0) {
      contactId = existing[0].id;
    } else {
      const { data: created, error: createErr } = await supabaseClient
        .from('contacts')
        .insert({
          name:             toName || toEmail.split('@')[0],
          email:            toEmail.toLowerCase(),
          user_id:          currentUser.id,
          agent_id:         currentAgent.id,
          agency_id:        currentAgent.agency_id || null,
          type:             contactType,
          sequence_status:  'Drip',
        })
        .select()
        .single();

      if (createErr) {
        showToast(`⚠ Contact not saved: ${createErr.message}`, 5000);
      } else if (created) {
        contactId = created.id;
        contacts.unshift(created);
      }
    }

    // ── Step 2: Send email via Apps Script ───────────────────
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('action',    'send_booking_link');
    url.searchParams.set('agent_id',  currentAgent.id);
    url.searchParams.set('to',        toEmail);
    url.searchParams.set('to_name',   toName);
    if (contactId) url.searchParams.set('contact_id', contactId);
    if (personalNote) url.searchParams.set('note', personalNote);

    const res  = await fetch(url.toString());
    const data = await res.json();

    if (data.status === 'ok') {
      showToast(`✓ Booking link sent to ${toName || toEmail} via your Gmail`);
      document.getElementById('booking-email-to').value    = '';
      document.getElementById('booking-first-name').value  = '';
      document.getElementById('booking-last-name').value   = '';
      document.getElementById('booking-contact-status').textContent = '';
      document.getElementById('booking-email-note').value  = getDefaultBookingNote();
      // Refresh contacts page if currently visible
      if (document.getElementById('page-contacts')?.style.display !== 'none') renderContacts();
    } else {
      showToast(`⚠ Send failed: ${data.message || 'Unknown error'}`);
    }
  } catch(e) {
    showToast(`⚠ Error: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send" style="margin-right:4px;"></i>Send via Gmail'; }
  }
}

function getDefaultBookingNote(typeRaw, intent) {
  const agentName = currentAgent.name || 'I';
  const type   = typeRaw || document.getElementById('booking-contact-type')?.value || 'Individual/Family';
  const intnt  = intent  || document.getElementById('booking-intent')?.value        || 'just-met';

  // ── Intent-based opening ────────────────────────────────────
  const openers = {
    'just-met':   'It was great meeting you!',
    'after-call': 'It was so great speaking with you today!',
    'follow-up':  'I wanted to follow up on our previous conversation.',
    'referral':   'I was given your information by a mutual contact and wanted to personally reach out.',
    'reconnect':  'I wanted to reach back out and reconnect — it has been a while!',
    'social':     'I came across your profile and wanted to personally reach out.',
  };
  const opener = openers[intnt] || openers['just-met'];

  // ── Type-based pitch ────────────────────────────────────────
  const pitches = {
    'Individual/Family': {
      'just-met':   "As we discussed, I'd love to find a time to sit down and go over your coverage options. Whether it's health, life, or planning for retirement — I want to make sure you and your family are fully protected.",
      'after-call': "As promised, I'm sending over my booking link so we can get our next conversation on the calendar. I have some great options I think will be a perfect fit for you.",
      'follow-up':  "I wanted to circle back and see if you'd be open to a quick conversation about your coverage options. I work with families every day to find plans that offer real protection without breaking the budget.",
      'referral':   "They spoke very highly of you and I think there's a real opportunity for me to help. I'd love to connect and learn more about what you're looking for when it comes to your coverage and financial future.",
      'reconnect':  "A lot has changed in the insurance landscape and I have some new options I think you'd want to know about. I'd love to reconnect and make sure you're still in the best possible position.",
      'social':     "I work with individuals and families to find the right health, life, and financial coverage — and I think I might be able to help you too. I'd love to learn more about your situation.",
    },
    'Group/Employer': {
      'just-met':   "As I mentioned, I specialize in helping businesses like yours design competitive group health and benefits packages — ones that help you attract and retain great talent, often at a lower cost than you'd expect.",
      'after-call': "As we discussed, I'm going to put together some options for your team. In the meantime, let's get a formal meeting on the calendar so I can walk you through everything in detail.",
      'follow-up':  "I wanted to follow up and see if there's a good time to connect about your company's group benefits. We've helped a number of businesses in your area reduce costs while improving coverage for their teams.",
      'referral':   "They thought we'd be a great fit, and I think so too. We work with businesses of all sizes to build group health and benefits packages that make a real difference for your team.",
      'reconnect':  "I wanted to reach back out — we have some new group plan options that weren't available before, and I think they could be a real win for your organization.",
      'social':     "I came across your company and I think there's a real opportunity for us to work together. We help businesses design competitive group benefits packages that attract top talent and keep employees happy.",
    },
    'Recruit|agent-kannon': {
      'just-met':   "As I mentioned, we are growing the Kannon Financial Group team and I genuinely think you'd be a great fit. I'd love to share more about the opportunity, the income potential, and what makes our team different.",
      'after-call': "I really enjoyed our conversation today! I think there's a tremendous opportunity here for you and I'd love to dive deeper into the details and answer any questions you have.",
      'follow-up':  "I wanted to follow up on my previous message about the opportunity at Kannon Financial Group. We're looking for driven individuals who want to build something meaningful — and I think you're exactly the kind of person we want on our team.",
      'referral':   "A mutual connection thought you'd be a great fit for what we're building at Kannon Financial Group — and based on what I know about you, I agree. I'd love to share more about the opportunity.",
      'reconnect':  "I wanted to reach back out — we've had some exciting developments at Kannon Financial Group and I think the timing might be right for us to have a conversation about your career goals.",
      'social':     "I came across your background and I think you'd be a fantastic addition to the Kannon Financial Group team. We're growing fast and I'd love to tell you more about what we're building.",
    },
    'Recruit|agent-insured': {
      'just-met':   "As I mentioned, The Insured America Agency is growing and I think you'd be a tremendous fit. I'd love to share more about the career path, the support system, and the income potential that comes with it.",
      'after-call': "Loved our conversation today! I'm excited about the possibility of you joining The Insured America Agency team and I'd love to get a proper sit-down on the calendar to walk you through everything.",
      'follow-up':  "I wanted to follow up about the career opportunity at The Insured America Agency. We offer industry-leading training, a proven system, and a real path to financial independence — and I'd love to tell you more.",
      'referral':   "A mutual contact thought you'd be a perfect fit for what we're doing at The Insured America Agency. We're looking for motivated individuals who are serious about building a career — and I'd love to connect.",
      'reconnect':  "I wanted to reach back out — a lot has changed at The Insured America Agency and I have some exciting updates I think you'd want to hear. I'd love to reconnect and catch up.",
      'social':     "Your background caught my attention and I immediately thought of the opportunity we have at The Insured America Agency. I'd love to reach out personally and share more about what we're building.",
    },
  };

  const typePitches = pitches[type] || pitches['Individual/Family'];
  const pitch = typePitches[intnt] || typePitches['just-met'];

  return `${opener}\n\n${pitch}\n\nUse the link below to grab a time that works for you — takes just a couple minutes and there is no obligation, just a conversation.\n\nLooking forward to speaking with you!\n\n${agentName}`;
}

function updateBookingNote() {
  const noteEl  = document.getElementById('booking-email-note');
  const typeEl  = document.getElementById('booking-contact-type');
  const intentEl = document.getElementById('booking-intent');
  if (!noteEl) return;
  noteEl.value = getDefaultBookingNote(typeEl?.value, intentEl?.value);
}

function updateBookingNoteForType(typeRaw) { updateBookingNote(); }

async function generateAIBookingMessage() {
  const email     = document.getElementById('booking-email-to')?.value.trim()   || '';
  const firstName = document.getElementById('booking-first-name')?.value.trim() || '';
  const lastName  = document.getElementById('booking-last-name')?.value.trim()  || '';
  const typeRaw   = document.getElementById('booking-contact-type')?.value       || 'Individual/Family';
  const intent    = document.getElementById('booking-intent')?.value             || 'just-met';
  const noteEl    = document.getElementById('booking-email-note');
  const aiBtn     = document.getElementById('booking-ai-btn');

  const contactName = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0] || 'this person';
  const agentName   = currentAgent.name || 'I';

  const intentLabels = {
    'just-met':   'We just met in person',
    'after-call': 'We just spoke on the phone',
    'follow-up':  'Following up on a prior conversation',
    'referral':   'This is a referral — a mutual contact passed along their info',
    'reconnect':  'Reconnecting after a long time with no contact',
    'social':     'Connected via social media or met online',
  };
  const typeLabels = {
    'Individual/Family':     'Individual or family prospect looking for health, life, or financial coverage',
    'Group/Employer':        'Business owner or HR decision-maker for group employee benefits',
    'Recruit|agent-kannon':  'Potential recruit for the Kannon Financial Group agent team',
    'Recruit|agent-insured': 'Potential recruit for the Insured America agent team',
  };

  // Fetch contact notes if the contact already exists
  let contactNotes = '';
  if (email && email.includes('@')) {
    try {
      const { data } = await supabaseClient
        .from('contacts').select('notes')
        .eq('email', email.toLowerCase()).eq('agent_id', currentAgent.id).limit(1);
      if (data && data.length > 0 && data[0].notes) contactNotes = data[0].notes.trim();
    } catch(e) { /* ignore — notes are optional */ }
  }

  if (aiBtn)  { aiBtn.disabled = true; aiBtn.textContent = '✨ Generating…'; }
  if (noteEl) { noteEl.style.opacity = '0.5'; }

  const prompt = `You are writing a brief, personal email message on behalf of ${agentName}, an independent insurance and financial agent at Kannon Financial Group.

Recipient name: ${contactName}
Contact type: ${typeLabels[typeRaw] || typeLabels['Individual/Family']}
How we connected: ${intentLabels[intent] || intentLabels['just-met']}
${contactNotes ? `Notes about this person: ${contactNotes}` : 'No prior notes on file — treat this as early-stage contact.'}

Write ONLY the personal message body (2–4 sentences). Rules:
- Do NOT include a greeting like "Hi ${firstName}," — the email template handles that automatically
- Do NOT include any sign-off or signature — handled by the template
- Write in first person as ${agentName}
- Sound genuine and warm, NOT like a sales script or template
- Be specific to the intent/situation where possible
- Naturally lead toward the reason for sharing a booking link
- If there are notes with specifics (renewal dates, coverage needs, situation details), reference them naturally
Output ONLY the message body text. No labels, no quotes, just the paragraph(s).`;

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
      body: JSON.stringify({ message: prompt, context: '', history: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (noteEl && data.text) {
      const body = data.text.trim();
      noteEl.value = `${body}\n\nUse the link below to grab a time that works for you — takes just a couple minutes and there is no obligation, just a conversation.\n\nLooking forward to speaking with you!\n\n${agentName}`;
    }
  } catch(e) {
    showToast('AI generation failed: ' + e.message);
  } finally {
    if (aiBtn)  { aiBtn.disabled = false; aiBtn.textContent = '✨ Generate with AI'; }
    if (noteEl) { noteEl.style.opacity = '1'; }
  }
}

let _bookingLookupTimer = null;
async function bookingLinkLookupContact(email) {
  const statusEl = document.getElementById('booking-contact-status');
  const firstEl  = document.getElementById('booking-first-name');
  const lastEl   = document.getElementById('booking-last-name');
  if (!statusEl) return;

  clearTimeout(_bookingLookupTimer);
  if (!email || !email.includes('@')) {
    statusEl.textContent = '';
    if (firstEl) firstEl.value = '';
    if (lastEl)  lastEl.value  = '';
    return;
  }

  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Looking up…';

  _bookingLookupTimer = setTimeout(async () => {
    const { data } = await supabaseClient
      .from('contacts')
      .select('id,name,type')
      .eq('email', email.toLowerCase())
      .eq('agent_id', currentAgent.id)
      .limit(1);

    if (data && data.length > 0) {
      const c = data[0];
      const parts = (c.name || '').split(' ');
      if (firstEl) firstEl.value = parts[0] || '';
      if (lastEl)  lastEl.value  = parts.slice(1).join(' ') || '';
      // Auto-fill contact type dropdown
      const typeEl = document.getElementById('booking-contact-type');
      if (typeEl) {
        let dropVal = c.type || 'Individual/Family';
        if (c.type === 'Recruit') dropVal = 'Recruit|agent-insured'; // pipeline col removed; default to Insured America
        typeEl.value = dropVal;
      }
      statusEl.style.color = '#16a34a';
      statusEl.textContent = `✓ Existing contact: ${c.name} (${c.type || 'Individual/Family'})`;
      updateBookingNote();
    } else {
      if (firstEl && !firstEl.value) firstEl.value = '';
      statusEl.style.color = 'var(--muted)';
      statusEl.textContent = 'Not in your contacts — will be created on send.';
    }
  }, 400);
}

// ============================================================
// WORK MY LEADS — Power Dialer
// ============================================================
// ── Work My Leads: cooldown helpers ─────────────────────────────
function dialerCooldownReady(contact, cooldownHours) {
  if (!cooldownHours || !contact.last_called_at) return true;
  return (Date.now() - new Date(contact.last_called_at).getTime()) / 3600000 >= cooldownHours;
}
function dialerSmartCooldown(contact) {
  const s = contact.sequence_status;
  if (s === 'Interested') return 0;
  if (s === 'Replied')    return 48;
  if (s === 'Active')     return 72;
  return 24;
}

function startDialerSession(filterType) {
  if (!filterType) {
    function bCnt(arr, h) {
      const ready = arr.filter(c => dialerCooldownReady(c, h)).length;
      return { ready, cooling: arr.length - ready, total: arr.length };
    }
    function bLbl(ready, cooling) {
      return cooling > 0
        ? `${ready} ready &nbsp;&middot;&nbsp; <span style="color:#94a3b8;font-weight:400;">${cooling} cooling &#10052;</span>`
        : `${ready}`;
    }
    const interested = contacts.filter(c => c.sequence_status === 'Interested');
    const replied    = contacts.filter(c => c.sequence_status === 'Replied');
    const active     = contacts.filter(c => c.sequence_status === 'Active');
    const fresh      = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started' || c.sequence_status === 'not_started');
    const pipeline   = contacts.filter(function(c) { return deals.some(function(d) { return d.contact_id === c.id; }); });
    const iC = bCnt(interested, 0);
    const rC = bCnt(replied, 48);
    const aC = bCnt(active, 72);
    const fC = bCnt(fresh, 24);
    const pC = { ready: pipeline.length, cooling: 0, total: pipeline.length };
    const allCount = totalContactCountFull || contacts.length;
    const typeBtns = CONTACT_TYPES.map(t => {
      const arr = contacts.filter(c => c.type === t);
      if (!arr.length) return '';
      const ready = arr.filter(c => dialerCooldownReady(c, dialerSmartCooldown(c))).length;
      const cooling = arr.length - ready;
      return `<button class="btn btn-outline btn-sm" onclick="closeModal();startDialerSession('type:${t}')" ${!ready ? 'disabled style="opacity:0.45;"' : ''}>
        ${t} <span style="font-size:11px;color:#94a3b8;">(${ready}${cooling ? '/'+arr.length : ''})</span>
      </button>`;
    }).join('');
    showModal('&#9889; Start a Lead Session', `
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px;">Choose which leads to work. Cooldown windows prevent over-contacting.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${pC.total > 0 ? `<button class="btn btn-full" style="background:#10b981;color:#fff;" onclick="closeModal();startDialerSession('pipeline')">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#127807; Work My Pipeline &mdash; Warm Contacts</span>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;">${pC.total}</span>
          </div>
        </button>` : ''}
        ${iC.total > 0 ? `<button class="btn btn-accent btn-full" onclick="closeModal();startDialerSession('interested')" ${!iC.ready ? 'disabled style="opacity:0.5;"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#129657; Interested &mdash; Ready to Quote</span>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;">${bLbl(iC.ready,iC.cooling)}</span>
          </div>
        </button>` : ''}
        ${rC.total > 0 ? `<button class="btn btn-accent btn-full" onclick="closeModal();startDialerSession('replied')" ${!rC.ready ? 'disabled style="opacity:0.5;"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#128293; Hot Leads &mdash; Replied <span style="font-size:11px;font-weight:400;opacity:0.8;">(48h cooldown)</span></span>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;">${bLbl(rC.ready,rC.cooling)}</span>
          </div>
        </button>` : ''}
        ${aC.total > 0 ? `<button class="btn btn-primary btn-full" onclick="closeModal();startDialerSession('active')" ${!aC.ready ? 'disabled style="opacity:0.5;"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#128140; Active Sequence &mdash; Supplement Email <span style="font-size:11px;font-weight:400;opacity:0.8;">(72h)</span></span>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;">${bLbl(aC.ready,aC.cooling)}</span>
          </div>
        </button>` : ''}
        <button class="btn btn-primary btn-full" onclick="closeModal();startDialerSession('not_started')" ${!fC.ready ? 'disabled style="opacity:0.5;"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#128101; Fresh Leads &mdash; Not Yet Contacted <span style="font-size:11px;font-weight:400;opacity:0.8;">(24h)</span></span>
            <span style="font-size:12px;font-weight:600;white-space:nowrap;">${bLbl(fC.ready,fC.cooling)}</span>
          </div>
        </button>
        <button class="btn btn-outline btn-full" onclick="closeModal();startDialerSession('all')">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px;">
            <span>&#128203; All My Contacts (no cooldown filter)</span>
            <span style="font-size:12px;font-weight:600;">${allCount}</span>
          </div>
        </button>
        ${typeBtns ? `<div style="border-top:1px solid #e2e8f0;margin-top:4px;padding-top:12px;">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Or work by contact type</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${typeBtns}</div>
        </div>` : ''}
      </div>
    `, null, { hideConfirm: true });
    return;
  }

  // Build queue respecting cooldown windows
  let queue;
  if (filterType === 'pipeline')
    queue = contacts.filter(function(c) { return deals.some(function(d) { return d.contact_id === c.id; }); });
  else if (filterType === 'interested')
    queue = contacts.filter(c => c.sequence_status === 'Interested' && dialerCooldownReady(c, 0));
  else if (filterType === 'replied')
    queue = contacts.filter(c => c.sequence_status === 'Replied' && dialerCooldownReady(c, 48));
  else if (filterType === 'active')
    queue = contacts.filter(c => c.sequence_status === 'Active' && dialerCooldownReady(c, 72));
  else if (filterType === 'not_started')
    queue = contacts.filter(c => (!c.sequence_status || c.sequence_status === 'Not Started' || c.sequence_status === 'not_started') && dialerCooldownReady(c, 24));
  else if (filterType.startsWith('type:')) {
    const t = filterType.slice(5);
    queue = contacts.filter(c => c.type === t && dialerCooldownReady(c, dialerSmartCooldown(c)));
  } else {
    queue = [...contacts];
  }

  if (!window._dashOpens) loadDashEmailOpens();
  queue.sort((a, b) => _dialerScore(b) - _dialerScore(a));
  if (queue.length === 0) {
    showToast('No contacts ready in this queue — all are in cooldown!');
    return;
  }
  dialerQueue = queue;
  dialerIndex = 0;
  showPage('dialer');
}

// ── Social Outreach Helpers ────────────────────────────────────────────
async function logOutreach(contactId, platform, prefillNote) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) { showToast('Contact not found'); return; }
  const platforms = ['Phone Call','Text / SMS','LinkedIn','Facebook','Instagram','X / Twitter','WhatsApp','TikTok','Telegram','In Person','Other'];
  const opts = platforms.map(p => '<option value="' + p + '"' + (p === (platform||'Phone Call') ? ' selected' : '') + '>' + p + '</option>').join('');
  showModal('Log Outreach \u2014 ' + (c.name || 'Contact'),
    '<div style="margin-bottom:10px;">'
    + '<label style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">Channel</label>'
    + '<select id="log-platform" style="width:100%;box-sizing:border-box;">' + opts + '</select></div>'
    + '<div><label style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">What happened</label>'
    + '<textarea id="log-note" rows="4" placeholder="e.g. Left voicemail, will follow up Friday." style="width:100%;box-sizing:border-box;">' + (prefillNote || '') + '</textarea></div>',
    async function() {
      const plat = document.getElementById('log-platform').value;
      const note = document.getElementById('log-note').value.trim();
      if (!note) { showToast('Please describe what happened'); return false; }
      // Determine activity type from platform
      const platActivityMap = {
        'Phone Call': 'call_made', 'Text / SMS': 'note_added', 'LinkedIn': 'note_added',
        'Facebook': 'note_added', 'Instagram': 'note_added', 'X / Twitter': 'note_added',
        'WhatsApp': 'note_added', 'TikTok': 'note_added', 'Telegram': 'note_added',
        'In Person': 'note_added', 'Other': 'note_added'
      };
      const actType = platActivityMap[plat] || 'note_added';
      // Log to activities table
      await supabaseClient.rpc('log_activity', {
        p_contact_id:    contactId,
        p_agent_id:      currentAgent.id,
        p_activity_type: actType,
        p_subject:       plat,
        p_body_snippet:  note,
        p_metadata:      { channel: plat }
      });
      // Also update notes field for backward compat (dialer snippets, dashboard)
      const ts = new Date().toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
      const entry = '[' + plat + ' \u2022 ' + ts + ']\n' + note;
      const newNotes = c.notes ? entry + '\n\n' + c.notes.trim() : entry;
      const { error } = await supabaseClient.from('contacts').update({ notes: newNotes }).eq('id', contactId);
      if (error) { showToast('Error: ' + error.message); return false; }
      c.notes = newNotes;
      const qi = dialerQueue ? dialerQueue.findIndex(x => x.id === contactId) : -1;
      if (qi > -1) dialerQueue[qi].notes = newNotes;
      showToast('\u2713 Outreach logged \u2014 ' + plat);
      if (plat === 'Phone Call') {
        const now2 = new Date().toISOString();
        const cnt = (c.call_count || 0) + 1;
        await supabaseClient.from('contacts').update({ last_called_at: now2, call_count: cnt }).eq('id', contactId);
        c.last_called_at = now2; c.call_count = cnt;
        const qi2 = dialerQueue ? dialerQueue.findIndex(x => x.id === contactId) : -1;
        if (qi2 > -1) { dialerQueue[qi2].last_called_at = now2; dialerQueue[qi2].call_count = cnt; }
      }
      if (typeof renderDialer === 'function' && dialerQueue && dialerQueue.length) renderDialer();
    }
  );
}

async function stampPhoneCall(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;
  const now = new Date().toISOString();
  const newCount = (c.call_count || 0) + 1;
  await supabaseClient.from('contacts').update({ last_called_at: now, call_count: newCount }).eq('id', contactId);
  c.last_called_at = now;
  c.call_count = newCount;
  const qi = dialerQueue ? dialerQueue.findIndex(x => x.id === contactId) : -1;
  if (qi > -1) { dialerQueue[qi].last_called_at = now; dialerQueue[qi].call_count = newCount; }
}

function openWhatsApp(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) { showToast('Contact not found'); return; }
  const num = (c.whatsapp_number || c.phone || '').replace(/[^0-9+]/g, '');
  const firstName = (c.name || '').split(' ')[0] || 'there';
  const agentFirst = (currentAgent.name || 'your advisor').split(' ')[0];
  const defaultMsg = 'Hi ' + firstName + ', this is ' + agentFirst + ' from Kannon Financial Group. I wanted to reach out regarding your financial goals \u2014 would love to connect when you have a moment!';
  showModal('WhatsApp \u2014 ' + (c.name || 'Contact'),
    '<div style="margin-bottom:10px;">'
    + '<label style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">WhatsApp Number</label>'
    + '<input type="tel" id="wa-num" value="' + num + '" placeholder="+14065550000" style="width:100%;box-sizing:border-box;" /></div>'
    + '<div><label style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">Message</label>'
    + '<textarea id="wa-msg" rows="5" style="width:100%;box-sizing:border-box;">' + defaultMsg + '</textarea></div>'
    + '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">&#128172; Opens WhatsApp with your message pre-filled and logs the outreach.</div>',
    async function() {
      const phone = document.getElementById('wa-num').value.replace(/[^0-9+]/g, '');
      const msg   = document.getElementById('wa-msg').value.trim();
      if (!phone) { showToast('Please enter a WhatsApp number'); return false; }
      if (!msg)   { showToast('Please enter a message'); return false; }
      window.open('https://wa.me/' + phone.replace(/^[+]/, '') + '?text=' + encodeURIComponent(msg), '_blank');
      const ts = new Date().toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
      const entry = '[WhatsApp \u2022 ' + ts + ']\n' + msg;
      const newNotes = c.notes ? entry + '\n\n' + c.notes.trim() : entry;
      await supabaseClient.from('contacts').update({ notes: newNotes }).eq('id', contactId);
      c.notes = newNotes;
      showToast('\u2713 WhatsApp opened + outreach logged');
    }
  );
}

function _parseLastInteraction(contact) {
  if (!contact.notes) return null;
  const m = contact.notes.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  const parts = m[1].split(' • ');
  if (parts.length < 2) return null;
  const channel = parts[0].trim();
  const dateStr = parts.slice(1).join(' • ').trim();
  const d = new Date(dateStr);
  if (isNaN(d)) return { label: channel, sub: 'recently' };
  if (channel === 'Appointment Scheduled') {
    const apptFmt = d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { label: 'Appt for', sub: apptFmt };
  }
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  const relDate = diffDays === 0 ? 'today' : diffDays === 1 ? 'yesterday' : diffDays + 'd ago';
  return { label: channel, sub: relDate };
}

function _dialerScore(contact) {
  // Higher score = work first in queue
  let score = 0;
  const statusMap = { Replied: 1000, Interested: 900, Active: 500 };
  score += (statusMap[contact.sequence_status] || 0);
  const opens = window._dashOpens || [];
  const op = opens.find(o => (o.contact_email || '').toLowerCase() === (contact.email || '').toLowerCase());
  if (op) {
    const hrs = (Date.now() - new Date(op.opened_at).getTime()) / 3600000;
    score += hrs < 2 ? 200 : hrs < 24 ? 100 : 40;
  }
  score += (contact.sequence_step || 0) * 5;
  if (contact.last_called_at) {
    const days = (Date.now() - new Date(contact.last_called_at).getTime()) / 86400000;
    score += Math.min(Math.floor(days) * 3, 30);
  }
  return score;
}

function _dialerSignal(contact) {
  const opens = window._dashOpens || [];
  const op = opens.find(o => (o.contact_email || '').toLowerCase() === (contact.email || '').toLowerCase());
  if (contact.sequence_status === 'Replied') {
    var _rLines = (contact.notes || '').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var _rCtx = _rLines.find(function(l) { return !l.startsWith('['); }) || '';
    var _rSub = _rCtx ? _rCtx.slice(0, 150) : 'Check notes below — schedule an appointment or run intake';
    return { icon: 'ti-flame', label: 'Replied — Ready for next step', sub: _rSub, color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)' };
  }
  if (contact.sequence_status === 'Interested') {
    return { icon: 'ti-heart-handshake', label: 'Expressed interest', sub: 'Send intake form or book an appointment', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' };
  }
  if (op) {
    const hrs = Math.floor((Date.now() - new Date(op.opened_at).getTime()) / 3600000);
    const t = hrs < 1 ? 'just now' : hrs < 24 ? hrs + 'h ago' : Math.floor(hrs / 24) + 'd ago';
    return { icon: 'ti-mail-opened', label: 'Opened your email ' + t, sub: "Follow up now while you're top of mind", color: '#38bdf8', bg: 'rgba(56,189,248,0.08)', border: 'rgba(56,189,248,0.25)' };
  }
  if ((contact.sequence_step || 0) > 0) {
    return { icon: 'ti-clock', label: 'Email ' + contact.sequence_step + ' sent, awaiting response', sub: 'Touch base by phone to supplement the email', color: '#a78bfa', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.25)' };
  }
  return { icon: 'ti-plant-2', label: 'Fresh lead, first contact', sub: 'Introduce yourself and start the conversation', color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.25)' };
}

function _dialerActionRow(contact, isLast) {
  const skipBtn = '<button class="btn btn-outline" onclick="dialerSkip()" style="margin-left:auto;">Skip &rarr;</button>';
  const nextBtn = '<button class="btn btn-primary" onclick="dialerNext(true)">' + (isLast ? '&#127942; Finish' : 'Next &rarr;') + '</button>';

  // Call button — teal + special label if they opened an email
  const _arOpens = window._dashOpens || [];
  const _arOpen = contact.email && _arOpens.some(function(o) { return (o.contact_email||'').toLowerCase() === contact.email.toLowerCase(); });
  const callBtn = contact.phone
    ? '<button class="btn btn-primary" onclick="openCallScript(\'' + contact.id + '\')" style="flex:1;font-size:14px;padding:11px 16px;' + (_arOpen ? 'background:#0f766e;' : '') + '">&#128222; Call' + (_arOpen ? ' — They Opened!' : '') + '</button>'
    : '<button class="btn btn-outline" disabled style="flex:1;font-size:13px;opacity:0.45;cursor:not-allowed;" title="No phone on file — click Edit to add one">&#128222; No phone — add in Edit</button>';
  const schedBtn  = '<button class="btn btn-primary" onclick="showScheduleModal(\'' + contact.id + '\')" style="flex:1;font-size:14px;padding:11px 16px;background:#1a3a5c;color:#fff;">&#128197; Schedule Appointment</button>';
  const sendLinkBtn = '<button class="btn btn-primary" onclick="dialerSendBookingLink(\'' + contact.id + '\')" style="flex:1;font-size:14px;padding:11px 16px;background:#0e7490;color:#fff;" title="Email the prospect a self-scheduling link">&#128139; Send Booking Link</button>';

  const contactDeal = deals.find(function(d) { return d.contact_id === contact.id; });

  // === PIPELINE (has deal) — View/Deal, no Reset ===
  if (contactDeal) {
    const _wLabels = {'individual-family':'Individual & Family','group-employer':'Group & Employer','agent-kannon':'Career — Kannon','agent-insured':'Career — IA'};
    const _wPL = _wLabels[contactDeal.pipeline] || contactDeal.pipeline || 'Pipeline';
    const _wSt = contactDeal.stage || '';
    const _wNx = contactDeal.next_step || '';
    return '<div style="margin-bottom:16px;">'
      + '<div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:9px 13px;margin-bottom:10px;font-size:12px;">'
      + '<span style="color:#10b981;font-weight:700;">&#127807; Pipeline:</span> <span style="color:var(--text-primary);">' + _wPL + ' &#8594; <strong>' + _wSt + '</strong></span>'
      + (_wNx ? '<span style="color:var(--muted);"> &nbsp;&middot;&nbsp; Next: ' + _wNx + '</span>' : '')
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:8px;">' + callBtn + schedBtn + sendLinkBtn + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button class="btn btn-outline btn-sm" style="border-color:#10b981;color:#10b981;" onclick="showIntakeForm(\'' + contact.id + '\')">&#129309; Interested</button>'
      + '<button class="btn btn-outline btn-sm" style="border-color:#dc2626;color:#dc2626;" onclick="showNotInterested(\'' + contact.id + '\')">&#10006; Not Interested</button>'
      + '<button class="btn btn-outline btn-sm" onclick="viewContact(\'' + contact.id + '\',\'\')">&#128140; View / Deal</button>'
      + skipBtn + nextBtn
      + '</div></div>';
  }

  // === ALL OTHER TYPES — View only, Reset included ===
  return '<div style="margin-bottom:16px;">'
    + '<div style="display:flex;gap:8px;margin-bottom:8px;">' + callBtn + schedBtn + sendLinkBtn + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="btn btn-outline btn-sm" style="border-color:#10b981;color:#10b981;" onclick="showIntakeForm(\'' + contact.id + '\')">&#129309; Interested</button>'
    + '<button class="btn btn-outline btn-sm" style="border-color:#dc2626;color:#dc2626;" onclick="showNotInterested(\'' + contact.id + '\')">&#10006; Not Interested</button>'
    + '<button class="btn btn-outline btn-sm" onclick="viewContact(\'' + contact.id + '\',\'\')">&#128140; View</button>'
    + '<button class="btn btn-outline btn-sm" style="color:var(--text-muted);border-color:var(--border);" onclick="showResetStatus(\'' + contact.id + '\')">&#8635; Reset</button>'
    + skipBtn + nextBtn
    + '</div></div>';
}

// ============================================================
// CALL SCRIPTS ENGINE
// ============================================================
window._dialerScripts       = null;
window._dialerScriptActive  = false;
window._dialerScriptNode    = null;
window._dialerScriptHistory = [];

async function _loadDialerScripts() {
  if (window._dialerScripts) return window._dialerScripts;
  const agencyId = (currentAgent && currentAgent.agency_id) || null;
  const { data, error } = await supabaseClient.rpc('get_call_scripts', {
    p_contact_type: null, p_situation: null, p_company: null, p_agency_id: agencyId
  });
  if (error) { console.error('Script load:', error); return []; }
  window._dialerScripts = data || [];
  return window._dialerScripts;
}

function _selectDialerScript(contact, allScripts) {
  var deal = deals.find(function(d) { return d.contact_id === contact.id; });
  var situation = 'cold';
  if (deal) situation = 'pipeline';
  else if (contact.sequence_status === 'Replied' || contact.sequence_status === 'Interested') situation = 'warm';
  var company = 'IA';
  if (deal && deal.pipeline === 'agent-kannon') company = 'KFG';
  var ctype = contact.type || 'Individual & Family';
  if (ctype === 'Group/Employer') ctype = 'Business Owner';
  var roots = allScripts.filter(function(s) { return !s.parent_id; });
  var best = null; var bestScore = -1;
  roots.forEach(function(s) {
    var sc = 0;
    if (s.contact_type === ctype) sc += 8; else if (!s.contact_type) sc += 1;
    if (s.situation === situation) sc += 6; else if (s.situation === 'any') sc += 2; else if (!s.situation) sc += 1;
    if (s.company === company) sc += 4; else if (s.company === 'both') sc += 2; else if (!s.company) sc += 1;
    if (sc > bestScore) { bestScore = sc; best = s; }
  });
  return best;
}

function _substituteVars(text, contact) {
  if (!text) return '';
  var firstName  = (contact.name || '').split(' ')[0] || 'there';
  var agentFirst = (currentAgent && currentAgent.name || '').split(' ')[0] || 'your advisor';
  var state      = contact.state || '';
  var company    = contact.company || (window.currentAgency && currentAgency.name) || '';
  return text
    .replace(/\[FIRST_NAME\]/g, firstName)
    .replace(/\[AGENT_FIRST\]/g, agentFirst)
    .replace(/\[STATE\]/g, state)
    .replace(/\[COMPANY\]/g, company);
}

async function openCallScript(contactId) {
  var c = contacts.find(function(x) { return x.id === contactId; });
  if (!c) return;
  var allScripts = await _loadDialerScripts();
  var root = _selectDialerScript(c, allScripts);
  if (!root) {
    // No script available — just dial directly
    stampPhoneCall(contactId);
    if (c.phone) window.open('tel:' + c.phone.replace(/[^0-9+]/g, ''));
    showToast('No script for this contact type — calling directly.');
    return;
  }
  window._dialerScriptActive     = true;
  window._dialerScriptNode       = root;
  window._dialerScriptHistory    = [];
  window._dialerScriptContactId  = contactId;
  renderDialer();
}

function placeDialerCall() {
  var contactId = window._dialerScriptContactId || (dialerQueue && dialerQueue[dialerIndex] && dialerQueue[dialerIndex].id);
  if (!contactId) return;
  var c = contacts.find(function(x) { return x.id === contactId; });
  if (!c) return;
  stampPhoneCall(contactId);
  if (c.phone) window.open('tel:' + c.phone.replace(/[^0-9+]/g, ''));
  showToast('&#128222; Dialing ' + (c.name || c.phone) + '...');
}

function closeCallScript() {
  window._dialerScriptActive  = false;
  window._dialerScriptNode    = null;
  window._dialerScriptHistory = [];
  renderDialer();
}

function navigateScript(nodeId) {
  var node = (window._dialerScripts || []).find(function(s) { return s.id === nodeId; });
  if (!node) return;
  if (window._dialerScriptNode) window._dialerScriptHistory.push(window._dialerScriptNode);
  window._dialerScriptNode = node;
  var panel = document.getElementById('dialer-script-panel');
  if (panel) panel.innerHTML = _buildScriptPanelBody();
}

function scriptBack() {
  if (!window._dialerScriptHistory || !window._dialerScriptHistory.length) return;
  window._dialerScriptNode = window._dialerScriptHistory.pop();
  var panel = document.getElementById('dialer-script-panel');
  if (panel) panel.innerHTML = _buildScriptPanelBody();
}

function selectAlternateScript(rootId) {
  var node = (window._dialerScripts || []).find(function(s) { return s.id === rootId; });
  if (!node) return;
  window._dialerScriptNode    = node;
  window._dialerScriptHistory = [];
  var panel = document.getElementById('dialer-script-panel');
  if (panel) panel.innerHTML = _buildScriptPanelBody();
}

function _buildScriptPanelBody() {
  var node    = window._dialerScriptNode;
  var scripts = window._dialerScripts || [];
  var history = window._dialerScriptHistory || [];
  var contact = dialerQueue && dialerQueue[dialerIndex];
  if (!node || !contact) return '';

  var children = scripts.filter(function(s) { return s.parent_id === node.id; });
  var bodyHtml = _substituteVars(node.script_body || '', contact)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>');
  var isRoot  = !node.parent_id;
  var activeRootId = isRoot ? node.id : (history.length ? history[0].id : node.id);
  var roots   = scripts.filter(function(s) { return !s.parent_id; });

  // Short display name for sidebar
  function shortName(r) {
    return (r.name || '')
      .replace(/^Cold Call — /,'').replace(/^Warm — /,'')
      .replace(/ \(Under 65\)/,'').replace(/ \(IA\)/,'').replace(/ \(KFG\)/,'')
      .replace(/^Recruit — /,'').replace(' Health','')
      .replace('Experienced Agent','Experienced')
      .replace('Individual & Family','Ind & Family')
      .replace('Medicare Supplement','Medicare Supp')
      .replace('Medicare Advantage','Medicare Adv')
      .replace('Group & Employer','Group/Employer')
      || 'Script';
  }

  // Grouped script sidebar
  var groups = [
    { label: 'Health / IA', prefix: ['11111111-0000-0000-0000-00000000000','1','2','3','4'].join(''),
      ids: ['11111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000004'] },
    { label: 'Financial / KFG',
      ids: ['11111111-0000-0000-0000-000000000005','11111111-0000-0000-0000-000000000006','11111111-0000-0000-0000-000000000007'] },
    { label: 'Recruit',
      ids: ['11111111-0000-0000-0000-000000000008','11111111-0000-0000-0000-000000000009','11111111-0000-0000-0000-000000000010','11111111-0000-0000-0000-000000000011'] },
    { label: 'Follow-Up',
      ids: ['11111111-0000-0000-0000-000000000012','11111111-0000-0000-0000-000000000013'] }
  ];
  var groupedIds = groups.reduce(function(a,g){ return a.concat(g.ids); },[]);

  var sidebarHtml = '';
  groups.forEach(function(g) {
    var grp = roots.filter(function(r){ return g.ids.indexOf(r.id) >= 0; });
    if (!grp.length) return;
    sidebarHtml += '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px 3px;">' + g.label + '</div>';
    grp.forEach(function(r) {
      var active = r.id === activeRootId;
      sidebarHtml += '<button onclick="selectAlternateScript(\'' + r.id + '\')" style="display:block;width:100%;text-align:left;padding:5px 10px;font-size:11px;font-weight:' + (active?'700':'400') + ';border:none;border-left:2px solid ' + (active?'var(--accent)':'transparent') + ';background:' + (active?'rgba(99,102,241,0.12)':'transparent') + ';color:' + (active?'var(--accent)':'var(--text-primary)') + ';cursor:pointer;border-radius:0 4px 4px 0;margin-bottom:1px;">' + shortName(r) + '</button>';
    });
  });
  // Custom scripts not in any group
  roots.filter(function(r){ return groupedIds.indexOf(r.id)<0; }).forEach(function(r) {
    var active = r.id === activeRootId;
    sidebarHtml += '<button onclick="selectAlternateScript(\'' + r.id + '\')" style="display:block;width:100%;text-align:left;padding:5px 10px;font-size:11px;font-weight:' + (active?'700':'400') + ';border:none;border-left:2px solid ' + (active?'var(--accent)':'transparent') + ';background:' + (active?'rgba(99,102,241,0.12)':'transparent') + ';color:' + (active?'var(--accent)':'var(--text-primary)') + ';cursor:pointer;">' + shortName(r) + '</button>';
  });

  // Phone for call button
  var phoneDisplay = contact.phone || '';
  var phoneDial    = phoneDisplay.replace(/[^0-9+]/g,'');

  // ── TOP HEADER BAR ──
  var html = '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);background:var(--surface-1);flex-shrink:0;">';
  html += '<span style="font-size:12px;font-weight:700;color:var(--text-primary);flex:1;">&#128222; Call Script</span>';
  if (phoneDial) {
    html += '<button onclick="placeDialerCall()" style="display:flex;align-items:center;gap:5px;padding:5px 14px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">&#128222; Dial ' + (phoneDisplay || '') + '</button>';
  }
  html += '<button onclick="closeCallScript()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px;line-height:1;padding:2px 4px;" title="Close script panel">&#10005;</button>';
  html += '</div>';

  // ── BODY: sidebar + content ──
  html += '<div style="display:flex;flex:1;overflow:hidden;">';

  // Sidebar
  html += '<div style="width:145px;min-width:145px;border-right:1px solid var(--border);overflow-y:auto;background:var(--surface-3);padding:4px 0;">' + sidebarHtml + '</div>';

  // Content column
  html += '<div style="display:flex;flex-direction:column;flex:1;overflow:hidden;">';

  // Content header (back btn + script name)
  html += '<div style="display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--surface-2);flex-shrink:0;">';
  if (history.length > 0) {
    html += '<button onclick="scriptBack()" style="background:none;border:1px solid var(--border);border-radius:5px;cursor:pointer;color:var(--muted);font-size:11px;padding:3px 8px;flex-shrink:0;">&#8592; Back</button>';
  }
  if (!isRoot) {
    html += '<span style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0;">Objection &rsaquo;</span>';
  }
  html += '<span style="font-size:12px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (node.name || 'Script') + '</span>';
  html += '</div>';

  // Script body text
  html += '<div style="flex:1;overflow-y:auto;padding:14px 16px;font-size:12.5px;line-height:1.85;color:var(--text-primary);">' + bodyHtml + '</div>';

  // Objection buttons
  if (children.length > 0) {
    html += '<div style="border-top:1px solid var(--border);padding:12px;background:var(--surface-2);flex-shrink:0;">';
    html += '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;">They say...</div>';
    children.forEach(function(child) {
      html += '<button onclick="navigateScript(\'' + child.id + '\')" style="display:block;width:100%;text-align:left;margin-bottom:5px;font-size:11.5px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface-3);color:var(--text-primary);cursor:pointer;">&#8594;&nbsp; ' + (child.trigger_text || child.name || 'Objection') + '</button>';
    });
    html += '</div>';
  } else if (!isRoot) {
    html += '<div style="border-top:1px solid var(--border);padding:10px 12px;text-align:center;flex-shrink:0;"><span style="font-size:11px;color:var(--muted);">&#127919; Aim to close — appointment, quote, or next step.</span></div>';
  }

  html += '</div>'; // content column
  html += '</div>'; // body
  return html;
}

// ============================================================
// SCRIPT MANAGER (Admin)
// ============================================================
window._smScripts = null;
window._smSelectedId = null;

async function renderScriptManagerPage() {
  var el = document.getElementById('page-scripts');
  if (!el) return;
  window._smPageMode = true;
  el.innerHTML = '<div style="padding:32px;color:var(--muted);font-size:13px;">Loading scripts…</div>';
  var agencyId = (currentAgent && currentAgent.agency_id) || null;
  var { data, error } = await supabaseClient.rpc('get_call_scripts', {
    p_contact_type: null, p_situation: null, p_company: null, p_agency_id: agencyId
  });
  var allScripts = error ? [] : (data || []);
  window._smScripts = allScripts;
  window._smSelectedId = null;
  var roots = allScripts.filter(function(s) { return !s.parent_id; });
  var treeHtml = roots.map(function(r) { return _smTreeNode(r, allScripts, 0); }).join('');
  el.innerHTML = '<div style="display:flex;height:calc(100vh - 80px);overflow:hidden;">'
    + '<div style="width:300px;min-width:300px;border-right:1px solid var(--border);overflow-y:auto;padding:16px;background:var(--surface-2);">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Call Scripts</div>'
    + '<button class="btn btn-primary btn-sm" onclick="smAddRoot()" style="font-size:11px;padding:4px 10px;">+ New Script</button>'
    + '</div>'
    + '<div id="sm-tree">' + treeHtml + '</div>'
    + '</div>'
    + '<div style="flex:1;overflow-y:auto;padding:28px;" id="sm-editor">'
    + '<div style="color:var(--muted);font-size:13px;text-align:center;padding:80px 20px;">Select a script on the left to edit it.</div>'
    + '</div>'
    + '</div>';
}

async function _smRefreshManager() {
  if (window._smPageMode) {
    var selId = window._smSelectedId;
    await renderScriptManagerPage();
    if (selId) setTimeout(function() { smSelectNode(selId); }, 80);
  } else {
    await openScriptManager();
  }
}

async function openScriptManager() {
  window._smPageMode = false;
  window._smScripts = null; // force refresh
  var allScripts = await (async function() {
    var agencyId = (currentAgent && currentAgent.agency_id) || null;
    var { data, error } = await supabaseClient.rpc('get_call_scripts', {
      p_contact_type: null, p_situation: null, p_company: null, p_agency_id: agencyId
    });
    return (error ? [] : (data || []));
  })();
  window._smScripts = allScripts;
  window._smSelectedId = null;
  _renderScriptManagerModal(allScripts);
}

function _renderScriptManagerModal(allScripts) {
  var roots = allScripts.filter(function(s) { return !s.parent_id; });
  var treeHtml = roots.map(function(r) { return _smTreeNode(r, allScripts, 0); }).join('');
  showModal('&#128221; Call Script Manager', `
    <div style="display:flex;gap:0;height:580px;">
      <div style="width:300px;min-width:300px;border-right:1px solid var(--border);overflow-y:auto;padding:12px;background:var(--surface-3);border-radius:0 0 0 12px;">
        <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Script Tree</div>
        <div id="sm-tree">${treeHtml}</div>
        <div style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" onclick="smAddRoot()" style="width:100%;font-size:12px;">+ Add Root Script</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px;" id="sm-editor">
        <div style="color:var(--muted);font-size:13px;text-align:center;padding:60px 20px;">Select a script on the left to edit it.</div>
      </div>
    </div>
  `, null, { wide: true, hideConfirm: true, cancelLabel: 'Close' });
}

function _smTreeNode(node, allScripts, depth) {
  var children = allScripts.filter(function(s) { return s.parent_id === node.id; });
  var indent = depth * 14;
  var label = depth === 0 ? (node.name || 'Script') : (node.trigger_text || node.name || 'Objection');
  var icon = depth === 0 ? '&#128221;' : (depth === 1 ? '&#8594;' : '&#8680;');
  var html = '<div style="padding:5px 8px 5px ' + (8 + indent) + 'px;border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;margin-bottom:2px;" '
    + 'id="sm-node-' + node.id + '" onclick="smSelectNode(\'' + node.id + '\')">'
    + '<span style="flex-shrink:0;">' + icon + '</span>'
    + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);">' + label + '</span>'
    + '</div>';
  if (children.length > 0) {
    html += children.map(function(c) { return _smTreeNode(c, allScripts, depth + 1); }).join('');
  }
  return html;
}

function smSelectNode(nodeId) {
  var scripts = window._smScripts || [];
  var node = scripts.find(function(s) { return s.id === nodeId; });
  if (!node) return;
  window._smSelectedId = nodeId;
  // highlight
  document.querySelectorAll('[id^="sm-node-"]').forEach(function(el) {
    el.style.background = el.id === 'sm-node-' + nodeId ? 'var(--accent-light, rgba(99,102,241,0.1))' : '';
    el.style.fontWeight = el.id === 'sm-node-' + nodeId ? '700' : '';
  });
  var isRoot = !node.parent_id;
  var children = scripts.filter(function(s) { return s.parent_id === nodeId; });
  var editor = document.getElementById('sm-editor');
  if (!editor) return;
  editor.innerHTML = `
    <div style="margin-bottom:14px;">
      <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${isRoot ? 'Root Script' : 'Objection / Rebuttal'}</div>
      <input id="sm-name" value="${(node.name||'').replace(/"/g,'&quot;')}" placeholder="Script name" style="width:100%;margin-bottom:8px;" />
      ${!isRoot ? `<input id="sm-trigger" value="${(node.trigger_text||'').replace(/"/g,'&quot;')}" placeholder="Trigger text (what prospect says)" style="width:100%;margin-bottom:8px;" />` : ''}
      <textarea id="sm-body" rows="12" style="width:100%;font-size:12px;font-family:inherit;line-height:1.7;">${(node.script_body||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
      <div style="font-size:10px;color:var(--muted);margin-top:4px;">Variables: [FIRST_NAME] [AGENT_FIRST] [STATE] [COMPANY]</div>
    </div>
    ${isRoot ? `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
      <div><label style="font-size:11px;font-weight:700;color:var(--muted);">Contact Type</label>
        <input id="sm-ctype" value="${(node.contact_type||'').replace(/"/g,'&quot;')}" placeholder="e.g. Individual &amp; Family" style="width:100%;" /></div>
      <div><label style="font-size:11px;font-weight:700;color:var(--muted);">Situation</label>
        <select id="sm-sit" style="width:100%;">
          <option value="cold" ${node.situation==='cold'?'selected':''}>cold</option>
          <option value="warm" ${node.situation==='warm'?'selected':''}>warm</option>
          <option value="pipeline" ${node.situation==='pipeline'?'selected':''}>pipeline</option>
          <option value="any" ${node.situation==='any'?'selected':''}>any</option>
        </select></div>
      <div><label style="font-size:11px;font-weight:700;color:var(--muted);">Company</label>
        <select id="sm-co" style="width:100%;">
          <option value="IA" ${node.company==='IA'?'selected':''}>IA</option>
          <option value="KFG" ${node.company==='KFG'?'selected':''}>KFG</option>
          <option value="both" ${node.company==='both'?'selected':''}>both</option>
        </select></div>
    </div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="smSaveNode('${nodeId}')">&#10003; Save</button>
      <button class="btn btn-outline btn-sm" onclick="smAddChild('${nodeId}')">+ Add Objection</button>
      <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);" onclick="smDeleteNode('${nodeId}')">&#128465; Delete</button>
    </div>
    ${children.length > 0 ? `<div style="margin-top:12px;font-size:11px;color:var(--muted);">${children.length} objection${children.length>1?'s':''} attached to this node.</div>` : ''}
  `;
}

async function smSaveNode(nodeId) {
  var updates = {
    name:        (document.getElementById('sm-name') || {}).value || '',
    script_body: (document.getElementById('sm-body') || {}).value || ''
  };
  var trigEl = document.getElementById('sm-trigger');
  if (trigEl) updates.trigger_text = trigEl.value || '';
  var ctypeEl = document.getElementById('sm-ctype');
  if (ctypeEl) {
    updates.contact_type = ctypeEl.value || null;
    updates.situation = (document.getElementById('sm-sit') || {}).value || 'cold';
    updates.company   = (document.getElementById('sm-co')  || {}).value || 'IA';
  }
  var { error } = await supabaseClient.rpc('sm_update_script', {
    p_id:           nodeId,
    p_name:         updates.name         || null,
    p_script_body:  updates.script_body  || null,
    p_trigger_text: updates.trigger_text || null,
    p_contact_type: updates.contact_type || null,
    p_situation:    updates.situation    || null,
    p_company:      updates.company      || null
  });
  if (error) { showToast('Error saving: ' + error.message); return; }
  // Update cache
  var node = (window._smScripts || []).find(function(s) { return s.id === nodeId; });
  if (node) Object.assign(node, updates);
  // Invalidate dialer cache
  window._dialerScripts = null;
  showToast('&#10003; Script saved!');
  // Refresh tree label
  var treeNode = document.getElementById('sm-node-' + nodeId);
  if (treeNode) {
    var span = treeNode.querySelector('span:last-child');
    if (span) span.textContent = updates.name || 'Script';
  }
}

async function smAddRoot() {
  var agencyId = (currentAgent && currentAgent.agency_id) || null;
  var { data, error } = await supabaseClient.rpc('sm_insert_script', {
    p_name: 'New Script', p_script_body: 'Enter your script here...',
    p_situation: 'cold', p_company: 'IA', p_sort_order: 99,
    p_agency_id: agencyId
  });
  if (error) { showToast('Error: ' + error.message); return; }
  window._smScripts = null;
  window._dialerScripts = null;
  window._smSelectedId = data.id;
  await _smRefreshManager();
}

async function smAddChild(parentId) {
  var agencyId = (currentAgent && currentAgent.agency_id) || null;
  var parent = (window._smScripts || []).find(function(s) { return s.id === parentId; });
  var { data, error } = await supabaseClient.rpc('sm_insert_script', {
    p_parent_id:    parentId,
    p_name:         'New Objection',
    p_trigger_text: 'They say...',
    p_script_body:  'Enter your rebuttal here...',
    p_contact_type: parent ? parent.contact_type : null,
    p_situation:    parent ? parent.situation    : null,
    p_company:      parent ? parent.company      : null,
    p_sort_order:   99,
    p_agency_id:    agencyId
  });
  if (error) { showToast('Error: ' + error.message); return; }
  window._smScripts = null;
  window._dialerScripts = null;
  window._smSelectedId = data.id;
  await _smRefreshManager();
}

async function smDeleteNode(nodeId) {
  var scripts = window._smScripts || [];
  var children = scripts.filter(function(s) { return s.parent_id === nodeId; });
  var msg = children.length > 0
    ? 'This will also delete ' + children.length + ' child objection(s). Are you sure?'
    : 'Delete this script node?';
  if (!confirm(msg)) return;
  var { error } = await supabaseClient.rpc('sm_delete_script', { p_id: nodeId });
  if (error) { showToast('Error: ' + error.message); return; }
  window._smScripts = null;
  window._dialerScripts = null;
  window._smSelectedId = null;
  await _smRefreshManager();
}

function _smOpenProfile(contactId, key) {
  const c = contacts.find(function(x) { return x.id === contactId; });
  if (!c || !c[key]) return;
  const h = c[key];
  var url = '';
  if (key === 'linkedin_url') url = h.indexOf('http') === 0 ? h : 'https://linkedin.com/in/' + h;
  else if (key === 'facebook_url') url = h.indexOf('http') === 0 ? h : 'https://facebook.com/' + h;
  else if (key === 'instagram_handle') url = 'https://instagram.com/' + h.replace(/^@/, '');
  else if (key === 'twitter_handle') url = 'https://x.com/' + h.replace(/^@/, '');
  else if (key === 'tiktok_handle') url = 'https://tiktok.com/@' + h.replace(/^@/, '');
  else if (key === 'telegram_handle') url = 'https://t.me/' + h.replace(/^@/, '');
  else if (key === 'whatsapp_number') url = 'https://wa.me/' + h.replace(/[^0-9]/g, '');
  if (url) window.open(url, '_blank');
}

function showDialerSocialMedia(contactId) {
  const c = contacts.find(function(x) { return x.id === contactId; });
  if (!c) return;
  const _smP = [
    { key: 'linkedin_url',     label: 'LinkedIn'    },
    { key: 'facebook_url',     label: 'Facebook'    },
    { key: 'instagram_handle', label: 'Instagram'   },
    { key: 'twitter_handle',   label: 'X / Twitter' },
    { key: 'tiktok_handle',    label: 'TikTok'      },
    { key: 'telegram_handle',  label: 'Telegram'    },
    { key: 'whatsapp_number',  label: 'WhatsApp'    },
  ];
  const rows = _smP.map(function(p) {
    const val = c[p.key] || '';
    const agentHas = !!(currentAgent[p.key]);
    const canOpen = agentHas && !!val;
    const tipText = !agentHas
      ? 'Add your own ' + p.label + ' in Settings to enable this'
      : (!val ? 'No handle on file for this contact' : 'Open their profile on ' + p.label);
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">'
      + '<div style="width:90px;font-size:12px;font-weight:700;color:var(--muted);">' + p.label + '</div>'
      + '<input type="text" id="sm-' + p.key + '" value="' + val.replace(/"/g, '&quot;') + '" placeholder="—" style="flex:1;font-size:13px;" />'
      + (canOpen
          ? '<button class="btn btn-outline btn-sm" onclick="_smOpenProfile(\'' + contactId + '\',\'' + p.key + '\')" title="' + tipText + '">Open</button>'
          : '<button class="btn btn-outline btn-sm" disabled style="opacity:0.35;cursor:not-allowed;" title="' + tipText + '">Open</button>')
      + '</div>';
  }).join('');
  showModal('&#128241; Social Media — ' + (c.name || 'Contact'),
    '<div style="padding-top:4px;">' + rows + '</div>',
    async function() {
      const updates = {};
      _smP.forEach(function(p) {
        const el = document.getElementById('sm-' + p.key);
        if (el) {
          let v = el.value.trim() || null;
          if (v && p.key !== 'linkedin_url' && p.key !== 'facebook_url' && p.key !== 'whatsapp_number') {
            v = v.replace(/^@/, '');
          }
          updates[p.key] = v;
        }
      });
      const { error } = await supabaseClient.from('contacts').update(updates).eq('id', contactId);
      if (error) { showToast('Save failed: ' + error.message); return false; }
      const idx = contacts.findIndex(function(x) { return x.id === contactId; });
      if (idx >= 0) Object.assign(contacts[idx], updates);
      renderDialer();
    },
    { confirmLabel: 'Save Handles' }
  );
}

async function showNotInterested(contactId) {
  const c = contacts.find(x => x.id === contactId);
  const name = c ? (c.name || 'this contact') : 'this contact';
  if (!confirm('Mark ' + name + ' as Not Interested?\nThis will remove them from your active sequence.')) return;
  try {
    await supabaseClient.from('contacts').update({ sequence_status: 'NotInterested' }).eq('id', contactId);
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx > -1) contacts[idx].sequence_status = 'NotInterested';
    const qi = dialerQueue.findIndex(c => c.id === contactId);
    if (qi > -1) dialerQueue[qi].sequence_status = 'NotInterested';
    showToast('Marked as Not Interested');
    dialerNext();
  } catch(e) { showToast('Error updating contact'); }
}

const INTAKE_FIELD_DEFS = {
  // ── Shared ──────────────────────────────────────────────────────────────
  name:                  { label: 'Full Name',              type: 'text',   section: 'Contact Info' },
  email:                 { label: 'Email',                  type: 'email',  section: 'Contact Info' },
  phone:                 { label: 'Phone',                  type: 'tel',    section: 'Contact Info' },
  dob:                   { label: 'Date of Birth',          type: 'date',   section: 'Contact Info' },
  best_time:             { label: 'Best Time to Reach',     type: 'select', section: 'Contact Info',
                           options: ['Morning','Afternoon','Evening','Anytime'] },
  marital_status:        { label: 'Marital Status',         type: 'select', section: 'Contact Info',
                           options: ['Single','Married','Divorced','Widowed'] },
  // ── Financial Services ───────────────────────────────────────────────────
  household_income:      { label: 'Household Income',       type: 'select', section: 'Finances',
                           options: ['Under $30k','$30k–$50k','$50k–$75k','$75k–$100k','$100k–$150k','$150k+'] },
  dependents_count:      { label: '# of Dependents',        type: 'number', section: 'Finances' },
  dependents_ages:       { label: 'Dependent Ages',         type: 'text',   section: 'Finances',
                           placeholder: 'e.g. 5, 8, 12' },
  has_life_insurance:    { label: 'Has Life Insurance?',    type: 'select', section: 'Life Insurance',
                           options: ['Yes','No','Not sure'] },
  life_coverage_amount:  { label: 'Coverage Amount',        type: 'text',   section: 'Life Insurance',
                           placeholder: 'e.g. $250,000' },
  has_investments:       { label: 'Has Investments?',       type: 'select', section: 'Investments',
                           options: ['Yes','No','Not sure'] },
  goal_debt:             { label: 'Goal: Debt Freedom',     type: 'checkbox', section: 'Goals' },
  goal_protection:       { label: 'Goal: Family Protection',type: 'checkbox', section: 'Goals' },
  goal_retirement:       { label: 'Goal: Retirement',       type: 'checkbox', section: 'Goals' },
  goal_college:          { label: 'Goal: College Funding',  type: 'checkbox', section: 'Goals' },
  goal_business:         { label: 'Goal: Business Planning',type: 'checkbox', section: 'Goals' },
  notes_financial:       { label: 'Notes',                  type: 'textarea', section: 'Notes' },
  // ── Health – Individual/Family ──────────────────────────────────────────
  household_size:        { label: 'Household Size',         type: 'number', section: 'Household' },
  member_ages:           { label: 'Member Ages',            type: 'text',   section: 'Household',
                           placeholder: 'e.g. 35, 32, 7' },
  aca_income:            { label: 'Est. Annual Income (ACA)',type: 'select', section: 'Household',
                           options: ['Under $20k','$20k–$40k','$40k–$60k','$60k–$80k','$80k–$100k','$100k+'] },
  currently_insured:     { label: 'Currently Insured?',     type: 'select', section: 'Current Coverage',
                           options: ['Yes','No'] },
  current_carrier:       { label: 'Current Carrier',        type: 'text',   section: 'Current Coverage' },
  current_premium:       { label: 'Current Monthly Premium',type: 'text',   section: 'Current Coverage',
                           placeholder: 'e.g. $450' },
  employer_plan_available:{ label: 'Employer Plan Available?', type: 'select', section: 'Current Coverage',
                            options: ['Yes','No'] },
  coverage_start_date:   { label: 'Desired Start Date',     type: 'date',   section: 'Coverage Needs' },
  health_priority:       { label: 'Priority',               type: 'select', section: 'Coverage Needs',
                           options: ['Lowest premium','Best network','Low deductible','Rx coverage','Dental/Vision'] },
  notes_health:          { label: 'Notes',                  type: 'textarea', section: 'Notes' },
  // ── Health – Group/Employer ─────────────────────────────────────────────
  business_name:         { label: 'Business Name',          type: 'text',   section: 'Business' },
  employee_count:        { label: '# of Employees',         type: 'number', section: 'Business' },
  enrollment_count:      { label: 'Expected Enrollment',    type: 'number', section: 'Business' },
  avg_age_range:         { label: 'Avg Employee Age Range', type: 'select', section: 'Business',
                           options: ['Under 30','30–40','40–50','50+','Mixed'] },
  has_current_plan:      { label: 'Has Current Group Plan?',type: 'select', section: 'Current Coverage',
                           options: ['Yes','No'] },
  current_group_carrier: { label: 'Current Group Carrier',  type: 'text',   section: 'Current Coverage' },
  group_start_date:      { label: 'Desired Start Date',     type: 'date',   section: 'Coverage Needs' },
  cov_medical:           { label: 'Medical',                type: 'checkbox', section: 'Coverage Needs' },
  cov_dental:            { label: 'Dental',                 type: 'checkbox', section: 'Coverage Needs' },
  cov_vision:            { label: 'Vision',                 type: 'checkbox', section: 'Coverage Needs' },
  cov_life:              { label: 'Group Life',             type: 'checkbox', section: 'Coverage Needs' },
  cov_disability:        { label: 'Short/Long Term Disability', type: 'checkbox', section: 'Coverage Needs' },
  notes_group:           { label: 'Notes',                  type: 'textarea', section: 'Notes' },
  // ── Career – KFG (Primerica) ────────────────────────────────────────────
  current_employer:      { label: 'Current Employer',       type: 'text',   section: 'Background' },
  current_occupation:    { label: 'Current Occupation',     type: 'text',   section: 'Background' },
  current_income:        { label: 'Current Annual Income',  type: 'select', section: 'Background',
                           options: ['Under $30k','$30k–$50k','$50k–$75k','$75k–$100k','$100k+'] },
  licensed_life:         { label: 'Licensed — Life?',       type: 'select', section: 'Licensing',
                           options: ['Yes','No','In progress'] },
  licensed_health:       { label: 'Licensed — Health?',     type: 'select', section: 'Licensing',
                           options: ['Yes','No','In progress'] },
  full_part_time:        { label: 'Full-time or Part-time?',type: 'select', section: 'Availability',
                           options: ['Full-time','Part-time','Either'] },
  income_goal_12mo:      { label: 'Income Goal (12 mo)',    type: 'select', section: 'Goals',
                           options: ['Under $30k','$30k–$60k','$60k–$100k','$100k–$150k','$150k+'] },
  why_interested:        { label: 'Why Interested?',        type: 'textarea', section: 'Goals' },
  notes_career:          { label: 'Notes',                  type: 'textarea', section: 'Notes' },
  // ── Career – Insured America ────────────────────────────────────────────
  states_licensed:       { label: 'States Licensed',        type: 'text',   section: 'Licensing',
                           placeholder: 'e.g. TX, FL, GA' },
  monthly_production:    { label: 'Monthly Production ($)',  type: 'text',   section: 'Production',
                           placeholder: 'e.g. $5,000' },
  own_book:              { label: 'Own Book of Business?',  type: 'select', section: 'Production',
                           options: ['Yes','No'] },
  products_sold:         { label: 'Products Sold',          type: 'text',   section: 'Production',
                           placeholder: 'e.g. ACA, Medicare, Life' },
};

const INTAKE_TYPE_DEFAULTS = {
  'financial':       ['dob','marital_status','best_time','household_income','dependents_count','dependents_ages',
                      'has_life_insurance','life_coverage_amount','has_investments',
                      'goal_debt','goal_protection','goal_retirement'],
  'health-individual':['dob','best_time','household_size','member_ages','aca_income',
                       'currently_insured','current_carrier','current_premium',
                       'employer_plan_available','coverage_start_date','health_priority'],
  'health-group':    ['business_name','best_time','employee_count','enrollment_count','avg_age_range',
                      'has_current_plan','current_group_carrier','group_start_date',
                      'cov_medical','cov_dental','cov_vision'],
  'career-kfg':      ['dob','best_time','current_employer','current_occupation','current_income',
                      'licensed_life','licensed_health','full_part_time','income_goal_12mo','why_interested'],
  'career-ia':       ['best_time','current_employer','licensed_life','licensed_health',
                      'states_licensed','monthly_production','own_book','products_sold','full_part_time'],
};

const INTAKE_TYPE_LABELS = {
  'financial':        'Life & Financial',
  'health-individual':'Health – Individual/Family',
  'health-group':     'Health – Group/Employer',
  'career-kfg':       'Career – KFG (Primerica)',
  'career-ia':        'Career – Insured America',
};

// All field IDs grouped by logical section for the checklist panel
const INTAKE_ALL_FIELDS = [
  { section: 'Contact Info',    ids: ['name','email','phone','dob','marital_status','best_time'] },
  { section: 'Finances',        ids: ['household_income','dependents_count','dependents_ages','has_investments'] },
  { section: 'Life Insurance',  ids: ['has_life_insurance','life_coverage_amount'] },
  { section: 'Goals',           ids: ['goal_debt','goal_protection','goal_retirement','goal_college','goal_business',
                                       'income_goal_12mo','why_interested'] },
  { section: 'Household',       ids: ['household_size','member_ages','aca_income'] },
  { section: 'Business',        ids: ['business_name','employee_count','enrollment_count','avg_age_range'] },
  { section: 'Current Coverage',ids: ['currently_insured','current_carrier','current_premium',
                                       'employer_plan_available','has_current_plan','current_group_carrier'] },
  { section: 'Coverage Needs',  ids: ['coverage_start_date','health_priority','group_start_date',
                                       'cov_medical','cov_dental','cov_vision','cov_life','cov_disability'] },
  { section: 'Background',      ids: ['current_employer','current_occupation','current_income'] },
  { section: 'Licensing',       ids: ['licensed_life','licensed_health','states_licensed'] },
  { section: 'Availability',    ids: ['full_part_time'] },
  { section: 'Production',      ids: ['monthly_production','own_book','products_sold'] },
  { section: 'Notes',           ids: ['notes_financial','notes_health','notes_group','notes_career'] },
];

let _intakeContactId = null;
let _intakeFormType = 'financial';
let _intakeChecked = new Set();

function _intakeTypeFromContact(c) {
  if (!c) return 'financial';
  const t = (c.type || c.contact_type || '').toLowerCase();
  if (t.includes('individual') || t.includes('family')) return 'health-individual';
  if (t.includes('group') || t.includes('employer')) return 'health-group';
  if (t.includes('insured america') || t.includes('insuredamerica')) return 'career-ia';
  if (t.includes('kannon') || t.includes('kfg') || t.includes('recruit') || t.includes('primerica')) return 'career-kfg';
  return 'financial';
}

async function showIntakeForm(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) { showToast('Contact not found'); return; }
  _intakeContactId = contactId;
  _intakeFormType  = _intakeTypeFromContact(c);
  _intakeChecked   = new Set(INTAKE_TYPE_DEFAULTS[_intakeFormType] || []);

  const initials = (c.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();

  const overlay = document.createElement('div');
  overlay.id = 'intakeOverlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9999;',
    'background:rgba(10,20,40,0.65);backdrop-filter:blur(2px);',
    'display:flex;align-items:center;justify-content:center;padding:16px;',
  ].join('');

  const box = document.createElement('div');
  box.id = 'intakeBox';
  box.style.cssText = [
    'background:#ffffff;border-radius:14px;',
    'box-shadow:0 24px 80px rgba(0,0,0,0.45);',
    'display:flex;flex-direction:column;',
    'width:min(1140px,96vw);max-height:93vh;overflow:hidden;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  ].join('');

  box.innerHTML = `
    <!-- HEADER -->
    <div style="padding:18px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
                background:linear-gradient(135deg,#1a3a5c 0%,#1e4976 100%);">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:42px;height:42px;border-radius:50%;
                    background:rgba(255,255,255,0.18);
                    display:flex;align-items:center;justify-content:center;
                    font-weight:700;font-size:15px;color:#fff;letter-spacing:.5px;flex-shrink:0;">
          ${initials}
        </div>
        <div>
          <div style="font-weight:700;font-size:16px;color:#fff;letter-spacing:.1px;">${c.name || 'Contact'}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-top:2px;">
            Intake Form${(c.type || c.contact_type) ? ' &middot; ' + (c.type || c.contact_type) : ''}
          </div>
        </div>
      </div>
      <button onclick="closeIntakeForm()"
        style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);
               border-radius:8px;cursor:pointer;font-size:18px;
               color:rgba(255,255,255,0.8);width:34px;height:34px;
               display:flex;align-items:center;justify-content:center;line-height:1;"
        onmouseover="this.style.background='rgba(255,255,255,0.25)'"
        onmouseout="this.style.background='rgba(255,255,255,0.12)'">&times;</button>
    </div>

    <!-- TYPE TAB BAR -->
    <div id="intakeTypeBar"
      style="padding:0 20px;border-bottom:2px solid #e8edf3;
             display:flex;gap:0;flex-wrap:wrap;flex-shrink:0;background:#fff;"></div>

    <!-- SPLIT BODY -->
    <div style="display:flex;flex:1;overflow:hidden;">
      <div id="intakeFieldList"
        style="width:260px;min-width:220px;border-right:1px solid #e8edf3;
               overflow-y:auto;flex-shrink:0;background:#f6f8fb;padding-bottom:8px;"></div>
      <div id="intakeFormPanel"
        style="flex:1;overflow-y:auto;padding:24px 28px;background:#ffffff;"></div>
    </div>

    <!-- FOOTER -->
    <div style="padding:14px 22px;border-top:1px solid #e2e8f0;
                display:flex;align-items:center;gap:10px;justify-content:flex-end;
                flex-shrink:0;background:#f8fafc;">
      <button onclick="closeIntakeForm()"
        style="padding:8px 18px;border-radius:8px;border:1px solid #d1d5db;
               background:#fff;color:#6b7280;font-size:13px;font-weight:500;cursor:pointer;"
        onmouseover="this.style.background='#f3f4f6'"
        onmouseout="this.style.background='#fff'">Cancel</button>

      <button id="intakeSendBtn" onclick="sendIntakeLink()"
        style="padding:8px 18px;border-radius:8px;border:1px solid #2563eb;
               background:#fff;color:#2563eb;font-size:13px;font-weight:500;
               cursor:pointer;display:flex;align-items:center;gap:7px;"
        onmouseover="this.style.background='#eff6ff'"
        onmouseout="this.style.background='#fff'">&#9993; Send Link via Gmail</button>

      <button onclick="saveIntakeToCRM()"
        style="padding:8px 22px;border-radius:8px;border:none;
               background:linear-gradient(135deg,#1a3a5c,#1e4976);
               color:#fff;font-size:13px;font-weight:600;cursor:pointer;
               display:flex;align-items:center;gap:7px;
               box-shadow:0 2px 8px rgba(26,58,92,0.3);"
        onmouseover="this.style.boxShadow='0 4px 16px rgba(26,58,92,0.45)'"
        onmouseout="this.style.boxShadow='0 2px 8px rgba(26,58,92,0.3)'">&#10003; Save to CRM</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  _intakeRenderTypeBar();
  _intakeRenderFieldList();
  _intakeRenderForm();
}

function closeIntakeForm() {
  const el = document.getElementById('intakeOverlay');
  if (el) el.remove();
}

function _intakeRenderTypeBar() {
  const bar = document.getElementById('intakeTypeBar');
  if (!bar) return;
  bar.innerHTML = Object.entries(INTAKE_TYPE_LABELS).map(([k, label]) => {
    const active = _intakeFormType === k;
    return `<button onclick="setIntakeFormType('${k}')" id="intakeTypeBtn_${k}"
      style="padding:10px 16px;border:none;
             border-bottom:3px solid ${active ? '#1a3a5c' : 'transparent'};
             background:none;cursor:pointer;
             font-size:12.5px;font-weight:${active ? '700' : '500'};
             color:${active ? '#1a3a5c' : '#64748b'};
             white-space:nowrap;transition:color .15s;"
      onmouseover="if('${k}'!==_intakeFormType){this.style.color='#1e293b';this.style.background='#f8fafc';}"
      onmouseout="if('${k}'!==_intakeFormType){this.style.color='#64748b';this.style.background='none';}">
      ${label}
    </button>`;
  }).join('');
}

function setIntakeFormType(type) {
  _intakeFormType = type;
  _intakeChecked  = new Set(INTAKE_TYPE_DEFAULTS[type] || []);
  _intakeRenderTypeBar();
  _intakeRenderFieldList();
  _intakeRenderForm();
}

function _intakeRenderFieldList() {
  const panel = document.getElementById('intakeFieldList');
  if (!panel) return;
  let html = '';
  for (const grp of INTAKE_ALL_FIELDS) {
    const visibleIds = grp.ids.filter(id => INTAKE_FIELD_DEFS[id]);
    if (!visibleIds.length) continue;
    const checkedCount = visibleIds.filter(id => _intakeChecked.has(id)).length;
    html += `
      <div style="padding:10px 14px 4px;font-size:10px;font-weight:700;
                  text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;
                  display:flex;align-items:center;justify-content:space-between;">
        <span>${grp.section}</span>
        ${checkedCount ? `<span style="background:#1a3a5c;color:#fff;border-radius:10px;padding:1px 7px;font-size:9px;">${checkedCount}</span>` : ''}
      </div>`;
    for (const id of visibleIds) {
      const def = INTAKE_FIELD_DEFS[id];
      const chk = _intakeChecked.has(id);
      const bg     = chk ? 'rgba(26,58,92,0.07)' : 'transparent';
      const bgHov  = chk ? 'rgba(26,58,92,0.13)' : '#edf2f7';
      html += `
        <label style="display:flex;align-items:center;gap:9px;padding:6px 14px;cursor:pointer;
                       font-size:12.5px;color:${chk ? '#1a3a5c' : '#374151'};
                       font-weight:${chk ? '600' : '400'};background:${bg};transition:background .1s;"
               onmouseover="this.style.background='${bgHov}'"
               onmouseout="this.style.background='${bg}'">
          <input type="checkbox" ${chk ? 'checked' : ''} onchange="toggleIntakeField('${id}',this.checked)"
            style="width:14px;height:14px;flex-shrink:0;accent-color:#1a3a5c;cursor:pointer;" />
          <span>${def.label}</span>
        </label>`;
    }
    html += `<div style="margin:4px 14px;border-bottom:1px solid #e8edf3;"></div>`;
  }
  panel.innerHTML = html;
}

function toggleIntakeField(id, checked) {
  if (checked) _intakeChecked.add(id);
  else         _intakeChecked.delete(id);
  _intakeRenderFieldList();
  _intakeRenderForm();
}

function _intakeRenderForm() {
  const panel = document.getElementById('intakeFormPanel');
  if (!panel) return;
  const c = contacts.find(x => x.id === _intakeContactId) || {};
  const prefill = {
    name:          c.name  || '',
    email:         c.email || '',
    phone:         c.phone || '',
    dob:           c.dob   || c.date_of_birth || '',
    business_name: c.company || '',
  };

  const sections = {};
  for (const grp of INTAKE_ALL_FIELDS) {
    for (const id of grp.ids) {
      if (_intakeChecked.has(id) && INTAKE_FIELD_DEFS[id]) {
        if (!sections[grp.section]) sections[grp.section] = [];
        sections[grp.section].push(id);
      }
    }
  }

  if (!Object.keys(sections).length) {
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;
                  justify-content:center;min-height:200px;padding-top:40px;text-align:center;">
        <div style="font-size:32px;margin-bottom:12px;opacity:.3;">&#9776;</div>
        <div style="font-size:14px;font-weight:500;color:#64748b;">Select fields from the left panel</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:6px;">Check the fields you want to capture.</div>
      </div>`;
    return;
  }

  let html = `<div style="max-width:580px;">`;
  for (const [sec, ids] of Object.entries(sections)) {
    html += `
      <div style="margin-bottom:28px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;
                    padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
          <div style="width:3px;height:16px;background:#1a3a5c;border-radius:2px;flex-shrink:0;"></div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;
                      letter-spacing:.1em;color:#1a3a5c;">${sec}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">`;
    for (const id of ids) {
      const def = INTAKE_FIELD_DEFS[id];
      const isWide = def.type === 'textarea'
        || ['notes_financial','notes_health','notes_group','notes_career',
            'why_interested','member_ages','dependents_ages'].includes(id);
      html += `<div style="${isWide ? 'grid-column:1/-1;' : ''}">` +
              _intakeRenderField(id, def, prefill[id] || '') + '</div>';
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
}

function _intakeRenderField(id, def, prefillVal) {
  const val  = prefillVal ? ` value="${prefillVal.replace(/"/g, '&quot;')}"` : '';
  const ph   = def.placeholder ? ` placeholder="${def.placeholder}"` : '';
  const base = `id="ifield_${id}" name="${id}"`;
  const S    = 'width:100%;padding:9px 12px;border-radius:8px;border:1.5px solid #e2e8f0;' +
               'background:#fafbfc;color:#1e293b;font-size:13px;box-sizing:border-box;outline:none;' +
               'transition:border-color .15s,box-shadow .15s;';
  const F    = `onfocus="this.style.borderColor='#1a3a5c';this.style.boxShadow='0 0 0 3px rgba(26,58,92,0.12)'"` +
               ` onblur="this.style.borderColor='#e2e8f0';this.style.boxShadow='none'"`;

  let control = '';
  if (def.type === 'select') {
    const opts = (def.options || []).map(o =>
      `<option value="${o}"${prefillVal === o ? ' selected' : ''}>${o}</option>`
    ).join('');
    control = `<select ${base} style="${S}" ${F}><option value="">Select...</option>${opts}</select>`;
  } else if (def.type === 'textarea') {
    control = `<textarea ${base} rows="3"${ph} style="${S}resize:vertical;" ${F}>${prefillVal || ''}</textarea>`;
  } else if (def.type === 'checkbox') {
    return `<div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;
                    padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fafbfc;">
        <input type="checkbox" ${base} style="width:16px;height:16px;accent-color:#1a3a5c;cursor:pointer;" />
        <span style="color:#1e293b;">${def.label}</span>
      </label>
    </div>`;
  } else {
    control = `<input type="${def.type}" ${base}${val}${ph} style="${S}" ${F} />`;
  }
  return `<div>
    <label for="ifield_${id}"
      style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;
             letter-spacing:.06em;color:#94a3b8;margin-bottom:5px;">${def.label}</label>
    ${control}
  </div>`;
}



function _intakeCollectResponses() {
  const responses = {};
  for (const id of _intakeChecked) {
    const el = document.getElementById('ifield_' + id);
    if (!el) continue;
    if (el.type === 'checkbox') responses[id] = el.checked;
    else responses[id] = el.value;
  }
  return responses;
}

async function saveIntakeToCRM() {
  const c = contacts.find(x => x.id === _intakeContactId);
  if (!c) return;
  const responses = _intakeCollectResponses();
  const selectedFields = Array.from(_intakeChecked);

  const btn = document.querySelector('#intakeBox .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    // 1. Create intake_session row
    const { data: sess, error: sessErr } = await supabaseClient
      .from('intake_sessions')
      .insert({
        contact_id:      _intakeContactId,
        agent_id:        currentAgent ? currentAgent.id : null,
        form_type:       _intakeFormType,
        selected_fields: selectedFields,
        responses:       responses,
        status:          'completed',
        completed_at:    new Date().toISOString(),
      })
      .select()
      .single();
    if (sessErr) throw sessErr;

    // 2. Update contact: sequence_status = 'Interested' + key fields from responses
    const contactUpdates = { sequence_status: 'Interested' };
    const fieldMap = {
      dob: 'dob', email: 'email', phone: 'phone',
      business_name: 'company', marital_status: 'marital_status',
    };
    for (const [fid, col] of Object.entries(fieldMap)) {
      if (responses[fid] !== undefined && responses[fid] !== '') contactUpdates[col] = responses[fid];
    }
    await supabaseClient.from('contacts').update(contactUpdates).eq('id', _intakeContactId);

    // 3. Log a note (activity_log + contact notes for Last Interaction badge)
    const noteText = '[Intake Form] ' + INTAKE_TYPE_LABELS[_intakeFormType] + ' — completed by agent';
    await supabaseClient.from('activity_log').insert({
      contact_id: _intakeContactId,
      agent_id:   currentAgent ? currentAgent.id : null,
      type:       'note',
      note:       noteText,
      created_at: new Date().toISOString(),
    }).catch(() => {});
    const _its = new Date().toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
    const _iEntry = '[Intake Completed • ' + _its + ']\n' + (INTAKE_TYPE_LABELS[_intakeFormType] || _intakeFormType) + ' intake saved to CRM';
    const _iNewNotes = c.notes ? _iEntry + '\n\n' + c.notes.trim() : _iEntry;
    await supabaseClient.from('contacts').update({ notes: _iNewNotes }).eq('id', _intakeContactId);
    c.notes = _iNewNotes;

    // 4. Auto-create pipeline Deal if one doesn't exist for this contact+pipeline
    const _intakePipelineMap = {
      health_individual: { pipeline: 'individual-family', stage: 'Needs Assessment' },
      health_family:     { pipeline: 'individual-family', stage: 'Needs Assessment' },
      life_individual:   { pipeline: 'individual-family', stage: 'Needs Assessment' },
      health_group:      { pipeline: 'group-employer',    stage: 'Discovery Call' },
      career_new:        { pipeline: 'agent-kannon',      stage: 'Interested' },
      career_existing:   { pipeline: 'agent-kannon',      stage: 'Interested' },
    };
    const _idest = _intakePipelineMap[_intakeFormType] || { pipeline: 'individual-family', stage: 'Needs Assessment' };
    const _ialready = deals.some(function(d) { return d.contact_id === _intakeContactId && d.pipeline === _idest.pipeline; });
    if (!_ialready) {
      const _ititle = c.company || c.name || 'New Deal';
      const { data: _inewDeal, error: _idealErr } = await supabaseClient.from('deals').insert({
        title:      _ititle,
        pipeline:   _idest.pipeline,
        stage:      _idest.stage,
        contact_id: _intakeContactId,
        user_id:    currentUser ? currentUser.id : null,
        agent_id:   currentAgent ? currentAgent.id : null,
        notes:      'Auto-created from intake form (' + _intakeFormType + ')',
      }).select().single();
      if (!_idealErr && _inewDeal) deals.unshift(_inewDeal);
    }

    showToast('✓ Intake saved — ' + (c.name || 'Contact') + ' added to pipeline');
    closeIntakeForm();
    dialerNext();
  } catch(e) {
    showToast('Error saving: ' + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = '✓ Save to CRM'; }
  }
}

async function sendIntakeLink() {
  const c = contacts.find(x => x.id === _intakeContactId);
  if (!c) return;
  if (!c.email) { showToast('No email address on file for this contact'); return; }

  const btn = document.getElementById('intakeSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const selectedFields = Array.from(_intakeChecked);
    // Create pending session
    const { data: sess, error: sessErr } = await supabaseClient
      .from('intake_sessions')
      .insert({
        contact_id:      _intakeContactId,
        agent_id:        currentAgent ? currentAgent.id : null,
        form_type:       _intakeFormType,
        selected_fields: selectedFields,
        responses:       {},
        status:          'pending',
        sent_at:         new Date().toISOString(),
      })
      .select()
      .single();
    if (sessErr) throw sessErr;

    // Derive intake URL (same origin, intake.html) — embed contact data so fields pre-fill
    const intakeUrl = window.location.origin + '/intake.html?s=' + sess.id
      + '&name='  + encodeURIComponent(c.name  || '')
      + '&email=' + encodeURIComponent(c.email || '')
      + '&phone=' + encodeURIComponent(c.phone || '');

    // Call Apps Script to send email
    const appsUrl = new URL(APPS_SCRIPT_URL);
    appsUrl.searchParams.set('action', 'send_intake_link');
    appsUrl.searchParams.set('agent_id', currentAgent ? currentAgent.id : '');
    appsUrl.searchParams.set('to', c.email);
    appsUrl.searchParams.set('to_name', c.name || '');
    appsUrl.searchParams.set('contact_id', _intakeContactId);
    appsUrl.searchParams.set('session_id', sess.id);
    appsUrl.searchParams.set('intake_url', intakeUrl);
    appsUrl.searchParams.set('form_type', _intakeFormType);
    appsUrl.searchParams.set('form_type_label', INTAKE_TYPE_LABELS[_intakeFormType] || _intakeFormType);

    const res = await fetch(appsUrl.toString());
    const json = await res.json().catch(() => ({}));
    if (json.status === 'error') throw new Error(json.message || 'Failed to send email');
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from mail server');

    showToast('✓ Intake link sent to ' + c.email);
    const _ilts = new Date().toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
    const _ilEntry = '[Intake Link Sent • ' + _ilts + ']\n' + (INTAKE_TYPE_LABELS[_intakeFormType] || _intakeFormType) + ' form emailed to client';
    const _ilNewNotes = c.notes ? _ilEntry + '\n\n' + c.notes.trim() : _ilEntry;
    await supabaseClient.from('contacts').update({ notes: _ilNewNotes }).eq('id', _intakeContactId);
    c.notes = _ilNewNotes;
    closeIntakeForm();
  } catch(e) {
    showToast('Error sending link: ' + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = '✉ Send Link via Gmail'; }
  }
}


async function dialerSendBookingLink(contactId) {
  const c = dialerQueue.find(x => x.id === contactId) || contacts.find(x => x.id === contactId);
  if (!c?.email) { showToast('No email address on file for this contact'); return; }
  if (!currentAgent.gmail_connected) {
    showToast('⚠ Connect your Gmail first (Settings → Gmail Connect)', 5000);
    return;
  }
  try {
    showToast('Sending booking link...');

    // Determine contact type — prefer deal pipeline over contact.type
    var _contactDeal = (window.deals || []).find(function(d) { return d.contact_id === contactId; });
    var _pipelineTypeMap = {
      'agent-kannon':   'Recruit|agent-kannon',
      'agent-insured':  'Recruit|agent-insured',
      'individual-family': 'Individual/Family',
      'group-employer':    'Group/Employer'
    };
    var _contactType = (_contactDeal && _pipelineTypeMap[_contactDeal.pipeline])
      || c.type
      || 'Individual/Family';

    // Generate the type-appropriate note body
    var _note = getDefaultBookingNote(_contactType, 'after-call');

    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('action',        'send_booking_link');
    url.searchParams.set('agent_id',      currentAgent.id);
    url.searchParams.set('to',            c.email);
    url.searchParams.set('to_name',       c.name || '');
    url.searchParams.set('contact_id',    contactId);
    url.searchParams.set('contact_type',  _contactType);
    url.searchParams.set('note',          _note);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.status === 'ok') {
      showToast('&#128197; Booking link sent to ' + (c.name || c.email) + '!');
      const ts2 = new Date().toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
      const entry2 = '[Schedule Link Sent • ' + ts2 + ']\nBooking link emailed to ' + (c.name || c.email);
      const newNotes2 = c.notes ? entry2 + '\n\n' + c.notes.trim() : entry2;
      await supabaseClient.from('contacts').update({ notes: newNotes2 }).eq('id', contactId);
      c.notes = newNotes2;
      const qi2 = dialerQueue ? dialerQueue.findIndex(x => x.id === contactId) : -1;
      if (qi2 > -1) dialerQueue[qi2].notes = newNotes2;
      if (typeof renderDialer === 'function' && dialerQueue && dialerQueue.length) renderDialer();
    } else {
      showToast('⚠ ' + (data.message || 'Failed to send booking link'));
    }
  } catch(e) { showToast('⚠ Error: ' + (e.message || 'Could not reach Apps Script')); }
}

function renderDialer() {
  const el = document.getElementById('page-dialer');
  if (!el) return;

  if (dialerQueue.length === 0) {
    el.innerHTML = `
      <div style="text-align:center;padding:80px 20px;">
        <div style="font-size:52px;margin-bottom:16px;">&#9889;</div>
        <div style="font-size:20px;font-weight:700;color:var(--primary);margin-bottom:8px;">No session started</div>
        <div style="font-size:14px;color:var(--muted);margin-bottom:24px;">Start a lead session from the dashboard or sidebar.</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="startDialerSession()">&#9889; Start a session</button>
          <button class="btn btn-outline" onclick="showPage('dashboard')">Back to dashboard</button>
        </div>
      </div>`;
    return;
  }

  const contact = dialerQueue[dialerIndex];
  const initials = (contact.name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0,2).toUpperCase();
  const progress = Math.round((dialerIndex / dialerQueue.length) * 100);
  const remaining = dialerQueue.length - dialerIndex - 1;
  const isLast = dialerIndex === dialerQueue.length - 1;
  const _lcd = contact.last_called_at ? Math.max(0,Math.floor((Date.now()-new Date(contact.last_called_at).getTime())/86400000)) : null;
  const _lcl = _lcd === null ? '' : _lcd === 0 ? 'Called today' : `Called ${_lcd}d ago`;
  const _li  = _parseLastInteraction(contact);

  const statusClass = contact.sequence_status === 'Replied' ? 'badge-replied'
    : contact.sequence_status === 'Active' ? 'badge-active' : 'badge-completed';
  const typeClass = contact.type === 'Recruit' ? 'badge-agent'
    : contact.type === 'Group/Employer' ? 'badge-group' : 'badge-individual';

  const _signal = _dialerSignal(contact);
  const _rdDeal = deals.find(function(d) { return d.contact_id === contact.id; });
  const _rdBorder = _rdDeal ? '#10b981' : 'var(--accent)';
  const _hasSocial = !!(contact.linkedin_url || contact.facebook_url || contact.instagram_handle || contact.twitter_handle || contact.tiktok_handle || contact.telegram_handle || contact.whatsapp_number);
  const _sA = !!(window._dialerScriptActive);
  el.innerHTML = `
    <div style="${_sA ? 'display:flex;align-items:flex-start;gap:0;min-height:calc(100vh - 120px);' : 'max-width:700px;margin:0 auto;'}">
      ${_sA ? `<div id="dialer-script-panel" style="width:580px;min-width:580px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface-2);position:sticky;top:0;max-height:calc(100vh - 100px);overflow:hidden;border-radius:10px 0 0 10px;border:1px solid var(--border);">${_buildScriptPanelBody()}</div>` : ''}
      <div style="${_sA ? 'flex:1;padding:0 20px;overflow-y:auto;max-height:calc(100vh - 100px);' : ''}">

      <!-- Session progress -->
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--muted);margin-bottom:5px;">
            Lead <strong>${dialerIndex + 1}</strong> of <strong>${dialerQueue.length}</strong>
            ${remaining > 0 ? `&nbsp;&middot;&nbsp; ${remaining} remaining` : '&nbsp;&middot;&nbsp; &#127942; Last one!'}
          </div>
          <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;">
            <div style="height:5px;background:var(--accent);border-radius:3px;width:${progress}%;transition:width 0.35s ease;"></div>
          </div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="endDialerSession()">End session</button>
      </div>

      <!-- Contact card -->
      <div class="card" style="padding:28px;margin-bottom:16px;border-top:3px solid ${_rdBorder};">

        <!-- Header row -->
        <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;">
          <div style="width:58px;height:58px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0;">${initials}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:3px;">${contact.name || '—'}</div>
            <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">${[contact.company, contact.city ? contact.city + (contact.state ? ', ' + contact.state : '') : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ') || '&mdash;'}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span class="badge ${typeClass}">${contact.type || 'Contact'}</span>
              <span class="badge ${statusClass}">${contact.sequence_status || 'Not started'}</span>
              ${contact.sequence_step > 0 ? `<span class="badge badge-insured">Email ${contact.sequence_step} sent</span>` : ''}
              ${_lcl ? `<span class="badge" style="background:#f1f5f9;color:#64748b;font-size:10px;">&#9990; ${_lcl} &middot; ${contact.call_count||1}x</span>` : ''}
              ${_li ? `<span class="badge" style="background:#f0fdf4;color:#16a34a;font-size:10px;">&#8635; ${_li.label} &middot; ${_li.sub}</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Added</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:2px;">${contact.created_at ? new Date(contact.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'}</div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;margin-bottom:16px;background:${_signal.bg};border:1px solid ${_signal.border};">
          <i class="ti ${_signal.icon}" style="font-size:18px;color:${_signal.color};flex-shrink:0;"></i>
          <div style="flex:1;">
            <div style="font-size:12px;font-weight:700;color:${_signal.color};">${_signal.label}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${_signal.sub}</div>
          </div>
        </div>

        <!-- Meta grid -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px;background:var(--surface-3);border-radius:10px;margin-bottom:20px;">
          <div style="grid-column:1/-1;display:flex;justify-content:flex-end;margin:-4px 0 6px;">
            <button class="btn btn-outline btn-sm" onclick="editContact('${contact.id}', () => renderDialer())"><i class="ti ti-edit"></i> Edit</button>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Email</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:3px;word-break:break-all;">${contact.email || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Phone</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:3px;">${contact.phone || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Company</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:3px;">${contact.company || '—'}</div>
          </div>
          ${_rdDeal ? `<div>
            <div style="font-size:10px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;">Pipeline Stage</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:3px;">${_rdDeal.stage || '—'}</div>
          </div>` : `<div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Sequence step</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:3px;">Email ${contact.sequence_step || 0} of 4</div>
          </div>`}
          <div style="grid-column:1/-1;margin-top:6px;">
            <button class="btn btn-outline btn-sm" onclick="showDialerSocialMedia('${contact.id}')" style="width:100%;justify-content:center;font-size:12px;${_hasSocial ? 'color:#10b981;border-color:#10b981;' : ''}">${_hasSocial ? '&#10003; Social Media &mdash; Handles On File' : '&#128241; Social Media &mdash; Add Handles'}</button>
          </div>
        </div>

        <!-- Action buttons -->
        ${_dialerActionRow(contact, isLast)}

        <!-- Notes area -->
        <div style="border-top:1px solid var(--border);padding-top:16px;">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);">
            <button class="btn btn-outline btn-sm" onclick="logOutreach('${contact.id}','Phone Call','')" style="font-size:12px;">&#128221; Log Outreach</button>
            ${(contact.whatsapp_number||contact.phone) ? `<button class="btn btn-outline btn-sm" onclick="openWhatsApp('${contact.id}')" style="font-size:12px;color:#25d366;border-color:#25d366;">&#128172; WhatsApp</button>` : ''}
            ${contact.linkedin_url ? `<button class="btn btn-outline btn-sm" onclick="window.open((contact.linkedin_url.indexOf('http')===0?contact.linkedin_url:'https://'+contact.linkedin_url),'_blank')" style="font-size:12px;">&#128279; LinkedIn</button>` : ''}
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Contact history</div>
          ${contact.notes ? (() => {
              // Split notes into entries, each entry starts with [Tag • date]
              const rawNotes = contact.notes || '';
              const escNotes = rawNotes.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              // Show most-recent entry prominently; older entries in a collapsible
              const entries = escNotes.split(/\n\n(?=\[)/).filter(Boolean);
              const topEntry = entries[0] || '';
              const restEntries = entries.slice(1);
              // Detect if the top entry has a reply in it (Subject:/Message:) — highlight it
              const isReply = topEntry.includes('Email Reply Received') || topEntry.includes('Subject:');
              const topBg = isReply ? 'rgba(52,211,153,0.08)' : 'var(--surface-3)';
              const topBorder = isReply ? '#34d399' : 'var(--accent)';
              return `<div style="font-size:12px;background:${topBg};padding:10px 12px;border-radius:8px;margin-bottom:6px;border-left:3px solid ${topBorder};white-space:pre-wrap;line-height:1.5;">${topEntry}</div>`
                + (restEntries.length > 0 ? `<details style="margin-bottom:10px;"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;padding:4px 0;user-select:none;">+ ${restEntries.length} older note${restEntries.length>1?'s':''}</summary><div style="margin-top:6px;font-size:12px;background:var(--surface-3);padding:10px 12px;border-radius:8px;white-space:pre-wrap;line-height:1.5;max-height:200px;overflow-y:auto;">${restEntries.join('\n\n')}</div></details>` : '<div style="margin-bottom:10px;"></div>');
            })() : '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;padding:8px 0;">No notes yet.</div>'}
          <div style="display:flex;gap:8px;">
            <input id="dialer-note-input" placeholder="Add a note (auto-timestamped)..." style="flex:1;font-size:13px;" value="" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();dialerSaveNote('${contact.id}');}" />
            <button class="btn btn-outline" onclick="dialerSaveNote('${contact.id}')">Save</button>
          </div>
        </div>
      </div>
      </div>
    </div>`;
}

function endDialerSession() {
  dialerQueue = [];
  dialerIndex = 0;
  showPage('dashboard');
  startDialerSession();
}

async function showScheduleModal(contactId) {
  const c = contacts.find(function(x) { return x.id === contactId; });
  if (!c) return;
  var tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  var defDt = tomorrow.toISOString().slice(0, 16);
  var apptTypes = ['Discovery Call','Needs Assessment','Quote Review','Policy Review','Group Presentation','Follow Up Call','Annual Review'];
  showModal('&#128197; Schedule Appointment — ' + (c.name || 'Contact'), `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:4px;">
      <div>
        <label style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Date &amp; Time</label>
        <input type="datetime-local" id="sched-dt" value="${defDt}" style="width:100%;margin-top:6px;" />
      </div>
      <div>
        <label style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Appointment Type</label>
        <select id="sched-type" style="width:100%;margin-top:6px;">
          ${apptTypes.map(function(t) { return '<option value="' + t + '">' + t + '</option>'; }).join('')}
        </select>
      </div>
      <div>
        <label style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Notes (optional)</label>
        <textarea id="sched-notes" rows="3" placeholder="What is this appointment for? Any context..." style="width:100%;margin-top:6px;resize:vertical;"></textarea>
      </div>
    </div>
  `, async function() {
    var dt    = document.getElementById('sched-dt').value;
    var type  = document.getElementById('sched-type').value;
    var notes = document.getElementById('sched-notes').value.trim();
    if (!dt) { showToast('Please select a date and time'); return false; }
    var dtIso = new Date(dt).toISOString();
    var { data: _bi, error } = await supabaseClient.from('booking_intents').insert({
      agent_id:          currentAgent ? currentAgent.id : null,
      contact_id:        contactId,
      contact_name:      c.name || '',
      appointment_type:  type,
      appointment_label: type,
      scheduled_at:      dtIso,
      status:            'confirmed',
      agent_notes:       notes,
    }).select().single();
    if (error) { showToast('Error scheduling: ' + (error.message || error)); return false; }
    // Send confirmation email via Apps Script (same handler as calendar apptSchedule)
    if (c.email && _bi) {
      try {
        var _ceurl = new URL(APPS_SCRIPT_URL);
        _ceurl.searchParams.set('action',            'appointment_confirm');
        _ceurl.searchParams.set('agent_id',          currentAgent ? currentAgent.id : '');
        _ceurl.searchParams.set('booking_intent_id', _bi.id);
        _ceurl.searchParams.set('to',                c.email);
        _ceurl.searchParams.set('to_name',           c.name || '');
        _ceurl.searchParams.set('datetime_iso',      dtIso);
        if (notes) _ceurl.searchParams.set('notes', notes);
        fetch(_ceurl.toString()); // non-blocking
      } catch(_) {}
    }
    var dateLabel = new Date(dt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    var noteText  = '[Appointment Scheduled • ' + dateLabel + ']\n' + type + (notes ? ' — ' + notes : '');
    var curNotes  = c.notes || '';
    await supabaseClient.from('contacts').update({
      notes:           noteText + (curNotes ? '\n\n' + curNotes : ''),
      sequence_status: 'Replied',
    }).eq('id', contactId);
    var ci = contacts.findIndex(function(x) { return x.id === contactId; });
    if (ci > -1) { contacts[ci].notes = noteText + (curNotes ? '\n\n' + curNotes : ''); contacts[ci].sequence_status = 'Replied'; }
    showToast('&#128197; Appointment confirmed' + (c.email ? ' — confirmation sent to ' + (c.name || c.email) : '') + '!');
    dialerNext();
  }, { confirmLabel: '&#128197; Confirm Appointment' });
}

async function dialerMarkInterested(contactId) {
  try {
    await supabaseClient.from('contacts').update({ sequence_status: 'Replied' }).eq('id', contactId);
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx > -1) contacts[idx].sequence_status = 'Replied';
    const qi = dialerQueue.findIndex(c => c.id === contactId);
    if (qi > -1) dialerQueue[qi].sequence_status = 'Replied';

    // Auto-route to the right pipeline based on contact type
    const contact = contacts.find(c => c.id === contactId);
    if (contact && contact.type) {
      const t = contact.type;
      let dest = null;
      if      (t === 'Group/Employer')         dest = { pipeline: 'group-employer',    stage: 'Responded' };
      else if (t === 'Individual/Family')      dest = { pipeline: 'individual-family', stage: 'Contacted' };
      else if (t === 'Recruit')                dest = { pipeline: 'agent-kannon',      stage: 'Interested' };
      else if (t.includes('Insured America'))  dest = { pipeline: 'agent-insured',     stage: 'Interested' };
      else if (t.includes('Kannon Financial')) dest = { pipeline: 'agent-kannon',      stage: 'Interested' };

      if (dest) {
        const alreadyInPipeline = deals.some(d => d.contact_id === contactId && d.pipeline === dest.pipeline);
        if (!alreadyInPipeline) {
          const dealTitle = contact.company || contact.name || 'New Deal';
          const { data: newDeal, error: dealErr } = await supabaseClient.from('deals').insert({
            title: dealTitle,
            pipeline: dest.pipeline,
            stage: dest.stage,
            contact_id: contactId,
            user_id: currentUser.id,
            agent_id: currentAgent.id
          }).select().single();
          if (!dealErr && newDeal) {
            deals.unshift(newDeal);
            showToast('&#129309; Interested! Added to pipeline -> ' + dest.stage);
          } else {
            showToast('&#129309; Marked Interested (pipeline error: ' + (dealErr?.message || '?') + ')');
          }
        } else {
          showToast('&#129309; Marked as Interested / Replied!');
        }
      } else {
        showToast('&#129309; Marked as Interested / Replied!');
      }
    } else {
      showToast('&#129309; Marked as Interested / Replied!');
    }

    dialerNext();
  } catch (e) { showToast('Error saving - try again'); }
}

async function dialerSaveNote(contactId) {
  const input = document.getElementById('dialer-note-input');
  const note = input?.value?.trim();
  if (!note) return;
  try {
    const c = contacts.find(x => x.id === contactId);
    const ts = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const entry = '[Note • ' + ts + ']\n' + note;
    const newNotes = c && c.notes ? entry + '\n\n' + c.notes.trim() : entry;
    await supabaseClient.from('contacts').update({ notes: newNotes }).eq('id', contactId);
    const idx = contacts.findIndex(x => x.id === contactId);
    if (idx > -1) contacts[idx].notes = newNotes;
    const qi = dialerQueue.findIndex(x => x.id === contactId);
    if (qi > -1) dialerQueue[qi].notes = newNotes;
    showToast('&#10003; Note saved');
    if (input) input.value = '';
    renderDialer();
  } catch (e) { showToast('Error saving note'); }
}

function dialerSkip() {
  showToast('Skipped &rarr;');
  dialerNext(true);
}

async function dialerNext(skipStamp = false) {
  const contact = dialerQueue[dialerIndex];
  if (dialerIndex < dialerQueue.length - 1) {
    dialerIndex++;
    renderDialer();
    window.scrollTo(0, 0);
  } else {
    const el = document.getElementById('page-dialer');
    if (el) el.innerHTML = `
      <div style="text-align:center;padding:80px 20px;max-width:480px;margin:0 auto;">
        <div style="font-size:64px;margin-bottom:16px;">&#127942;</div>
        <div style="font-size:24px;font-weight:800;color:var(--primary);margin-bottom:8px;">Session complete!</div>
        <div style="font-size:15px;color:var(--muted);margin-bottom:8px;">You worked through all <strong>${dialerQueue.length}</strong> leads.</div>
        <div style="font-size:14px;color:var(--muted);margin-bottom:28px;">Great work, ${(currentAgent.name || '').split(' ')[0]}!</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="startDialerSession()">&#9889; Start another session</button>
          <button class="btn btn-outline" onclick="showPage('dashboard')">Back to dashboard</button>
          <button class="btn btn-outline" onclick="showPage('contacts')">View all contacts</button>
        </div>
      </div>`;
    dialerQueue = [];
    dialerIndex = 0;
  }
}

function manageBookingTypes() {
  const typeLabels   = { client: 'Client', recruit: 'Recruit' };
  const contextColors = { client: '#1a3a5c', recruit: '#7c3aed' };
  const myUrl = `${window.location.origin}/book.html?agent=${currentAgent.id}`;

  function renderTypeRows() {
    const rows = currentAgent.booking_types || [];
    if (!rows.length) return '<p style="font-size:13px;color:var(--muted);padding:8px 0;">No booking types yet. Add one below.</p>';
    return rows.map((t, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f8fafc;border-radius:6px;margin-bottom:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:#1e293b;">${t.label}</div>
          <div style="font-size:11px;color:var(--muted);">&#9201; ${t.duration} &nbsp;&middot;&nbsp;
            <span style="color:${contextColors[t.context]||'#64748b'};font-weight:600;">${typeLabels[t.context]||t.context}</span>
          </div>
        </div>
        <button onclick="editBookingType(${i})" style="border:1px solid #e2e8f0;background:#fff;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;">Edit</button>
        <button onclick="removeBookingType(${i})" style="border:none;background:none;color:#ef4444;font-size:18px;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
      </div>`).join('');
  }

  showModal('&#128197; Booking Types', `
    <div style="margin-bottom:14px;">
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Your booking page (client-facing):</p>
      <div style="display:flex;gap:8px;">
        <input id="booking-page-url" readonly value="${myUrl}&context=client"
          style="flex:1;font-size:12px;background:var(--surface-3);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);" />
        <button onclick="navigator.clipboard.writeText(document.getElementById('booking-page-url').value).then(()=>showToast('Link copied!'))"
          style="border:none;background:var(--fill-accent);color:#000;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;white-space:nowrap;font-weight:600;">Copy</button>
      </div>
    </div>
    <div style="background:var(--surface-1);border:0.5px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;">
      <p style="font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:8px;"><i class="ti ti-mail" style="margin-right:4px;"></i>Send booking link by email</p>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <input id="booking-email-to" type="email" placeholder="Email address *"
          style="flex:1;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);"
          oninput="bookingLinkLookupContact(this.value)" />
      </div>
      <div id="booking-contact-status" style="font-size:11px;color:var(--muted);margin-bottom:6px;min-height:16px;"></div>
      <div id="booking-name-fields" style="display:flex;gap:6px;margin-bottom:6px;">
        <input id="booking-first-name" type="text" placeholder="First name *"
          style="flex:1;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);" />
        <input id="booking-last-name" type="text" placeholder="Last name"
          style="flex:1;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);" />
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <select id="booking-contact-type" onchange="updateBookingNote()" style="flex:1;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);">
          <option value="Individual/Family">Individual / Family</option>
          <option value="Group/Employer">Group / Employer</option>
          <option value="Recruit|agent-kannon">Recruit — Kannon Financial</option>
          <option value="Recruit|agent-insured">Recruit — Insured America</option>
        </select>
        <select id="booking-intent" onchange="updateBookingNote()" style="flex:1;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);">
          <option value="just-met">We Just Met</option>
          <option value="after-call">After a Call</option>
          <option value="follow-up">Following Up</option>
          <option value="referral">Referral</option>
          <option value="reconnect">Reconnecting</option>
          <option value="social">Social / Online</option>
        </select>
      </div>
      <textarea id="booking-email-note" rows="4"
        style="width:100%;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text-primary);resize:vertical;margin-bottom:6px;box-sizing:border-box;"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <button id="booking-ai-btn" onclick="generateAIBookingMessage()"
          style="background:var(--surface-3);border:0.5px solid var(--border);color:var(--text-primary);border-radius:6px;padding:7px 12px;font-size:12px;cursor:pointer;font-weight:500;white-space:nowrap;">✨ Generate with AI</button>
        <button id="booking-modal-send-btn" onclick="sendBookingLinkEmail(document.getElementById('booking-email-to').value.trim(), document.getElementById('booking-first-name').value.trim(), document.getElementById('booking-last-name').value.trim(), document.getElementById('booking-email-note').value.trim(), document.getElementById('booking-contact-type').value)"
          style="background:var(--fill-accent);border:none;color:#000;border-radius:6px;padding:7px 16px;font-size:12px;cursor:pointer;font-weight:600;"><i class="ti ti-send" style="margin-right:4px;"></i>Send via Gmail</button>
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Appointment Types</div>
    <div id="booking-type-list">${renderTypeRows()}</div>

    <div style="border-top:1px solid #e2e8f0;margin-top:16px;padding-top:16px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Add New Type</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Label *</label>
          <input id="bt-label" placeholder="Group Benefits Review" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Duration *</label>
          <input id="bt-duration" placeholder="20 min" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Context</label>
          <select id="bt-context" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;">
            <option value="client">Client (insurance/benefits)</option>
            <option value="recruit">Recruit (career opportunity)</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Description</label>
          <input id="bt-desc" placeholder="Optional" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Google Calendar Link *</label>
        <input id="bt-link" placeholder="https://calendar.app.google/..." style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
      </div>
      <button onclick="addBookingType()" style="background:#1a3a5c;color:#fff;border:none;border-radius:5px;padding:9px 20px;font-size:13px;font-weight:600;cursor:pointer;">+ Add Type</button>
    </div>
  `, null, { hideConfirm: true });
  // Pre-populate the default email message after modal renders
  setTimeout(() => {
    const noteEl = document.getElementById('booking-email-note');
    if (noteEl) noteEl.value = getDefaultBookingNote();
  }, 50);
}

async function addBookingType() {
  const label    = document.getElementById('bt-label')?.value.trim();
  const duration = document.getElementById('bt-duration')?.value.trim();
  const context  = document.getElementById('bt-context')?.value || 'client';
  const desc     = document.getElementById('bt-desc')?.value.trim();
  const link     = document.getElementById('bt-link')?.value.trim();
  if (!label || !duration || !link) { showToast('Label, duration, and Google Calendar link are required.'); return; }
  const typeKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const types = [...(currentAgent.booking_types || []), { type: typeKey, label, description: desc || '', duration, context, link }];
  const { error } = await supabaseClient.from('agents').update({ booking_types: types }).eq('id', currentAgent.id);
  if (error) { showToast('Error: ' + error.message); return; }
  currentAgent.booking_types = types;
  showToast('Appointment type added!');
  closeModal();
  manageBookingTypes();
}

async function removeBookingType(index) {
  const types = [...(currentAgent.booking_types || [])];
  if (!confirm(`Remove "${types[index]?.label}"?`)) return;
  types.splice(index, 1);
  const { error } = await supabaseClient.from('agents').update({ booking_types: types }).eq('id', currentAgent.id);
  if (error) { showToast('Error: ' + error.message); return; }
  currentAgent.booking_types = types;
  showToast('Removed.');
  closeModal();
  manageBookingTypes();
}

function editBookingType(index) {
  const t = (currentAgent.booking_types || [])[index];
  if (!t) return;
  showModal(`Edit: ${t.label}`, `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Label</label>
        <input id="ebt-label" value="${t.label}" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Duration</label>
        <input id="ebt-duration" value="${t.duration}" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
      </div>
    </div>
    <div style="margin-bottom:10px;">
      <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Context</label>
      <select id="ebt-context" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;">
        <option value="client" ${t.context==='client'?'selected':''}>Client (insurance/benefits)</option>
        <option value="recruit" ${t.context==='recruit'?'selected':''}>Recruit (career opportunity)</option>
      </select>
    </div>
    <div style="margin-bottom:10px;">
      <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Description</label>
      <input id="ebt-desc" value="${t.description||''}" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
    </div>
    <div>
      <label style="font-size:11px;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Google Calendar Link</label>
      <input id="ebt-link" value="${t.link}" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:5px;font-size:13px;" />
    </div>
  `, async () => {
    const types = [...(currentAgent.booking_types || [])];
    types[index] = {
      type:        types[index].type,
      label:       document.getElementById('ebt-label').value.trim()    || t.label,
      description: document.getElementById('ebt-desc').value.trim(),
      duration:    document.getElementById('ebt-duration').value.trim() || t.duration,
      context:     document.getElementById('ebt-context').value,
      link:        document.getElementById('ebt-link').value.trim()     || t.link
    };
    const { error } = await supabaseClient.from('agents').update({ booking_types: types }).eq('id', currentAgent.id);
    if (error) { showToast('Error: ' + error.message); return false; }
    currentAgent.booking_types = types;
    showToast('Updated!');
  });
}

// ============================================================
// GMAIL OAUTH CONNECT
// ============================================================
function showGmailSetup(isManual) {
  const ex = document.getElementById('gmail-setup-overlay');
  if (ex) ex.remove();
  const ov = document.createElement('div');
  ov.id = 'gmail-setup-overlay';
  ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const fn = (currentAgent.name || '').split(' ')[0] || 'there';
  ov.innerHTML = '<div style="background:white;border-radius:16px;padding:40px 36px;max-width:480px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,0.28);text-align:center;">' +
    '<div style="font-size:52px;margin-bottom:14px;">📧</div>' +
    '<h2 style="font-size:22px;font-weight:700;margin-bottom:8px;">' + (isManual ? 'Connect Your Gmail' : 'One last step, ' + fn + '!') + '</h2>' +
    '<p style="font-size:14px;color:#64748b;line-height:1.65;margin-bottom:6px;">Connect your Gmail so outreach emails come <strong>from your address</strong> and replies land <strong>in your inbox</strong>.</p>' +
    '<p style="font-size:13px;color:#94a3b8;margin-bottom:24px;">The CRM auto-marks contacts as "Replied" when they write back.</p>' +
    '<div id="gmail-setup-status" style="display:none;padding:12px;background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;margin-bottom:16px;font-size:14px;color:#065f46;font-weight:600;">✓ Gmail connected! Refreshing...</div>' +
    '<button onclick="connectGmail()" id="gmail-connect-btn" style="width:100%;padding:14px;background:#4285F4;color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:12px;">Connect Gmail</button>' +
    '<div id="gmail-waiting-indicator" style="display:none;width:100%;padding:14px;background:#f8fafc;color:#64748b;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;margin-bottom:12px;">⚠ Waiting for authorization...</div>' +
    (isManual ? '<button onclick="document.getElementById(\'gmail-setup-overlay\').remove();window.removeEventListener(\'message\',handleGmailMessage);" style="width:100%;padding:10px;background:none;border:none;font-size:13px;color:#94a3b8;cursor:pointer;">Close</button>'
              : '<button onclick="dismissGmailSetup()" style="width:100%;padding:10px;background:none;border:none;font-size:13px;color:#94a3b8;cursor:pointer;">Skip for now</button>') +
    '</div>';
  document.body.appendChild(ov);
  window.addEventListener('message', handleGmailMessage);
}
function connectGmail() {
  if (!GOOGLE_OAUTH_CLIENT_ID || GOOGLE_OAUTH_CLIENT_ID === 'PASTE_CLIENT_ID_HERE') { alert('Gmail OAuth not configured yet. Contact Ken.'); return; }
  const url = 'https://accounts.google.com/o/oauth2/auth?client_id=' + GOOGLE_OAUTH_CLIENT_ID + '&redirect_uri=' + encodeURIComponent(APPS_SCRIPT_URL) + '&scope=' + encodeURIComponent(GMAIL_SCOPES) + '&response_type=code&access_type=offline&prompt=consent&state=' + encodeURIComponent(currentAgent.id);
  window.open(url, 'gmail-oauth', 'width=520,height=640,left=200,top=80');
  const cb = document.getElementById('gmail-connect-btn');
  const wb = document.getElementById('gmail-waiting-indicator');
  if (cb) cb.style.display = 'none';
  if (wb) wb.style.display = 'block';
  pollGmailConnection();
}
async function pollGmailConnection() {
  let n = 0;
  const tick = async () => {
    if (++n > 60) { const b = document.getElementById('gmail-connect-btn'); if (b) b.style.display = 'flex'; return; }
    const { data } = await supabaseClient.from('agents').select('gmail_connected,gmail_email').eq('id', currentAgent.id).single();
    if (data && data.gmail_connected) onGmailConnected(data.gmail_email || '');
    else setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}
function connectCalendar() {
  if (!GOOGLE_OAUTH_CLIENT_ID || GOOGLE_OAUTH_CLIENT_ID === 'PASTE_CLIENT_ID_HERE') {
    alert('Gmail OAuth not configured yet.'); return;
  }
  var url = 'https://accounts.google.com/o/oauth2/auth'
    + '?client_id='    + GOOGLE_OAUTH_CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(APPS_SCRIPT_URL)
    + '&scope='        + encodeURIComponent(GMAIL_SCOPES)
    + '&response_type=code&access_type=offline&prompt=consent'
    + '&state='        + encodeURIComponent(currentAgent.id);
  window.open(url, 'gmail-oauth', 'width=520,height=640,left=200,top=80');
  showToast('\u23f3 Waiting for Calendar authorization...');
  var n = 0;
  var tick = async function() {
    if (++n > 60) { showToast('Timed out — please try again.'); return; }
    var r = await supabaseClient.from('agents').select('calendar_connected').eq('id', currentAgent.id).single();
    if (r.data && r.data.calendar_connected) {
      currentAgent.calendar_connected = true;
      renderDashboard();
      showToast('\ud83d\uddd3 Google Calendar connected!');
    } else { setTimeout(tick, 3000); }
  };
  setTimeout(tick, 3000);
}
function handleGmailMessage(e) { if (e.data && e.data.type === 'gmail-connected') onGmailConnected(e.data.gmail_email || ''); }
function onGmailConnected(email) {
  currentAgent.gmail_connected = true; currentAgent.gmail_email = email;
  const el = document.getElementById('gmail-setup-status'); if (el) el.style.display = 'block';
  window.removeEventListener('message', handleGmailMessage);
  setTimeout(() => { const ov = document.getElementById('gmail-setup-overlay'); if (ov) ov.remove(); renderDashboard(); showToast('✓ Gmail connected! Sending from ' + (email || 'your Gmail')); }, 1800);
}
function dismissGmailSetup() {
  const ov = document.getElementById('gmail-setup-overlay'); if (ov) ov.remove();
  window.removeEventListener('message', handleGmailMessage);
  showToast('Connect Gmail anytime from your dashboard.');
}

// ============================================================
// CAMPAIGNS — drip content library + stats
// ============================================================
async function renderCampaigns() {
  document.getElementById('page-campaigns').innerHTML = `<div style="color:var(--muted);font-size:14px;padding:40px;text-align:center;">Loading campaigns...</div>`;

  const [{ data: dripContent }, { data: seqContent }, { data: sends }, { data: dripContacts }] = await Promise.all([
    supabaseClient.from('drip_content').select('*').order('segment').order('display_order'),
    supabaseClient.from('sequence_content').select('*').order('segment').order('email_num'),
    supabaseClient.from('drip_sends').select('drip_content_id, opened'),
    supabaseClient.from('contacts').select('id,name,sequence_status,type').eq('sequence_status', 'Drip')
  ]);

  const allDrip  = dripContent || [];
  const allSeq   = seqContent  || [];
  const allSends = sends       || [];
  const drip     = dripContacts || [];

  // Store all items in global map for onclick access
  campaignItemsMap = {};
  [...allDrip, ...allSeq].forEach(item => { campaignItemsMap[item.id] = item; });

  // Build send stats per drip content ID
  const sendStats = {};
  allSends.forEach(s => {
    if (!sendStats[s.drip_content_id]) sendStats[s.drip_content_id] = { sent: 0, opened: 0 };
    sendStats[s.drip_content_id].sent++;
    if (s.opened) sendStats[s.drip_content_id].opened++;
  });

  const dripB2b     = drip.filter(c => c.type === 'Group/Employer').length;
  const dripB2c     = drip.filter(c => c.type === 'Individual/Family').length;
  const dripRecruit = drip.filter(c => c.type === 'Recruit').length;
  const monthMap    = {4:'April',5:'May',9:'September',10:'October',11:'November',12:'December'};

  // ── DRIP sections ───────────────────────────────────────────
  const dripSegLabel = { b2b:'🏢 B2B Client', b2c:'👤 B2C Client', recruit:'🎯 Recruit' };
  const dripSections = ['b2b','b2c','recruit'].map(seg => {
    const items = allDrip.filter(c => c.segment === seg);
    if (!items.length) return '';
    const rows = items.map(item => {
      const s = sendStats[item.id] || { sent: 0, opened: 0 };
      const openRate = s.sent > 0 ? Math.round(s.opened / s.sent * 100) : 0;
      const ctaBadge = item.cta_type === 'cta'
        ? `<span class="badge badge-replied" style="font-size:10px;padding:2px 6px;">CTA</span>`
        : `<span class="badge" style="background:#f1f5f9;color:#64748b;font-size:10px;padding:2px 6px;">EDU</span>`;
      const monthBadge = item.awareness_month ? `<span style="font-size:11px;color:#c8a84b;margin-left:6px;">📋 ${monthMap[item.awareness_month]}</span>` : '';
      const activeColor = item.is_active ? '#16a34a' : '#dc2626';
      return `<tr>
        <td style="font-size:13px;font-weight:600;max-width:240px;">${item.subject}</td>
        <td style="font-size:12px;color:var(--muted);">${item.topic}</td>
        <td>${ctaBadge}${monthBadge}</td>
        <td style="text-align:center;font-size:13px;">${s.sent}</td>
        <td style="text-align:center;font-size:13px;color:${openRate>20?'#16a34a':'var(--muted)'};">${s.sent>0?openRate+'%':'—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-outline btn-sm" onclick="previewEmailContent('${item.id}')">Preview</button>
          <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="editEmailContent('drip_content','${item.id}')">✏ Edit</button>
          <button class="btn btn-outline btn-sm" style="margin-left:4px;color:${activeColor};" onclick="toggleDripContent('${item.id}',${item.is_active})">${item.is_active?'Active':'Paused'}</button>
        </td>
      </tr>`;
    }).join('');
    return `<div style="margin-bottom:32px;">
      <h3 style="font-size:15px;font-weight:700;color:var(--primary);margin:0 0 12px 0;">${dripSegLabel[seg]||seg}</h3>
      <table class="data-table" style="width:100%;"><thead><tr>
        <th>Subject</th><th>Topic</th><th>Type</th>
        <th style="text-align:center;">Sent</th><th style="text-align:center;">Open Rate</th><th>Actions</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

  // ── SEQUENCE sections ────────────────────────────────────────
  const seqSegLabel = {
    'b2b':'🏢 B2B Outreach',
    'b2c':'👤 B2C Outreach',
    'recruit-standard':'🎯 Recruit (Standard)',
    'recruit-statefarm':'🏆 Recruit (State Farm)'
  };
  const seqSections = ['b2b','b2c','recruit-standard','recruit-statefarm'].map(seg => {
    const items = allSeq.filter(s => s.segment === seg).sort((a,b) => a.email_num - b.email_num);
    if (!items.length) return '';
    const rows = items.map(item => {
      const stateBadge = item.state
        ? `<span class="badge" style="background:#eff6ff;color:#1d4ed8;font-size:10px;padding:2px 6px;">${item.state}</span>`
        : `<span style="color:var(--muted);font-size:12px;">All states</span>`;
      const activeColor = item.is_active ? '#16a34a' : '#dc2626';
      const activeLabel = item.is_active ? 'Active' : 'Inactive';
      return `<tr>
        <td style="text-align:center;font-size:13px;font-weight:700;color:var(--primary);">#${item.email_num}</td>
        <td style="font-size:13px;font-weight:600;max-width:260px;">${item.subject}</td>
        <td style="text-align:center;">${stateBadge}</td>
        <td style="text-align:center;"><span class="badge ${item.is_active?'badge-active':'badge-completed'}" style="font-size:10px;">${activeLabel}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-outline btn-sm" onclick="previewEmailContent('${item.id}')">Preview</button>
          <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="editEmailContent('sequence_content','${item.id}')">✏ Edit</button>
          <button class="btn btn-outline btn-sm" style="margin-left:4px;color:${activeColor};" onclick="toggleSeqContent('${item.id}',${item.is_active})">${activeLabel}</button>
        </td>
      </tr>`;
    }).join('');
    return `<div style="margin-bottom:32px;">
      <h3 style="font-size:15px;font-weight:700;color:var(--primary);margin:0 0 12px 0;">${seqSegLabel[seg]||seg}</h3>
      <table class="data-table" style="width:100%;"><thead><tr>
        <th style="text-align:center;">#</th><th>Subject</th>
        <th style="text-align:center;">State</th><th style="text-align:center;">Status</th><th>Actions</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

  const tabDrip = (campaignTab === 'drip');
  document.getElementById('page-campaigns').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <h2 class="section-title" style="margin:0;">📧 Email Campaigns</h2>
      <button class="btn btn-primary" onclick="aiSuggestEmail()">✨ AI Suggest New Email</button>
    </div>

    <div style="display:flex;gap:2px;margin-bottom:24px;border-bottom:2px solid #e2e8f0;">
      <button onclick="switchCampaignTab('drip')" style="padding:10px 20px;font-size:14px;font-weight:600;border:none;border-bottom:3px solid ${tabDrip?'#1a3a5c':'transparent'};background:none;color:${tabDrip?'#1a3a5c':'var(--muted)'};cursor:pointer;transition:all .15s;">📂 Drip (${allDrip.length})</button>
      <button onclick="switchCampaignTab('seq')" style="padding:10px 20px;font-size:14px;font-weight:600;border:none;border-bottom:3px solid ${!tabDrip?'#1a3a5c':'transparent'};background:none;color:${!tabDrip?'#1a3a5c':'var(--muted)'};cursor:pointer;transition:all .15s;">📈 Sequences (${allSeq.length})</button>
    </div>

    <div id="camp-drip" style="display:${tabDrip?'block':'none'};">
      <div class="opens-stats" style="margin-bottom:28px;">
        <div class="opens-stat"><div class="num">${drip.length}</div><div class="lbl">In Drip</div></div>
        <div class="opens-stat" style="border-left-color:#1a3a5c;"><div class="num">${dripB2b}</div><div class="lbl">B2B</div></div>
        <div class="opens-stat" style="border-left-color:#16a34a;"><div class="num">${dripB2c}</div><div class="lbl">B2C</div></div>
        <div class="opens-stat" style="border-left-color:#c8a84b;"><div class="num">${dripRecruit}</div><div class="lbl">Recruits</div></div>
        <div class="opens-stat" style="border-left-color:#8b5cf6;"><div class="num">${allSends.length}</div><div class="lbl">Sent</div></div>
      </div>
      <div style="background:#fff8e7;border:1px solid #c8a84b;border-radius:8px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#92400e;line-height:1.6;">
        <strong>Cadence:</strong> Every 5 days (first 60 days) → Weekly. Triggered daily via Apps Script <code style="background:#fef3c7;padding:2px 5px;border-radius:3px;">runDripCampaign()</code>.
      </div>
      ${dripSections}
    </div>

    <div id="camp-seq" style="display:${!tabDrip?'block':'none'};">
      <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#1e40af;line-height:1.6;">
        <strong>3-email outreach sequence</strong> — runs via Apps Script. B2B/B2C routes by contact type. Recruits route by <em>Outreach Track</em> (Standard or State Farm). Add state-specific rows (e.g. MT, AZ) to override generic templates.
      </div>
      ${seqSections}
    </div>
  `;
}

function switchCampaignTab(tab) {
  campaignTab = tab;
  renderCampaigns();
}

async function toggleDripContent(id, currentlyActive) {
  const { error } = await supabaseClient.from('drip_content').update({ is_active: !currentlyActive }).eq('id', id);
  if (!error) renderCampaigns();
}

async function toggleSeqContent(id, currentlyActive) {
  const { error } = await supabaseClient.from('sequence_content').update({ is_active: !currentlyActive }).eq('id', id);
  if (!error) renderCampaigns();
}

function previewEmailContent(id) {
  const item = campaignItemsMap[id];
  if (!item) return;
  const monthMap = {4:'April',5:'May',9:'September',10:'October',11:'November',12:'December'};
  const metaLine = item.cta_type !== undefined
    ? `<strong>Segment:</strong> ${item.segment} &nbsp;|&nbsp; <strong>Type:</strong> ${item.cta_type} &nbsp;|&nbsp; <strong>Topic:</strong> ${item.topic||''}${item.awareness_month?` &nbsp;|&nbsp; <strong>Month:</strong> ${monthMap[item.awareness_month]}`:''}`
    : `<strong>Segment:</strong> ${item.segment||''} &nbsp;|&nbsp; <strong>Email #:</strong> ${item.email_num||''} ${item.state?`&nbsp;|&nbsp; <strong>State:</strong> ${item.state}`:''}`;
  const body = `
    <div style="margin-bottom:12px;font-size:13px;">${metaLine}</div>
    <div style="margin-bottom:6px;font-size:13px;"><strong>Subject:</strong> ${item.subject}</div>
    <div style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;background:#f8fafc;font-size:13px;line-height:1.7;max-height:360px;overflow-y:auto;">
      ${(item.body_html||'').replace(/{firstName}/g,'[First Name]').replace(/{agentName}/g,'[Agent Name]').replace(/{state}/g,'[State]').replace(/{city}/g,'[City]')}
    </div>`;
  showModal('📧 Preview: ' + (item.subject||'').substring(0,50), body, null, { hideConfirm: true });
}

function editEmailContent(table, id) {
  const item = campaignItemsMap[id];
  if (!item) return;
  const isDrip = table === 'drip_content';
  const extraFields = isDrip ? `
    <div style="margin-top:12px;">
      <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Topic</label>
      <input id="ec-topic" class="form-input" value="${(item.topic||'').replace(/"/g,'&quot;')}" style="width:100%;">
    </div>` : `
    <div style="margin-top:12px;display:flex;gap:12px;">
      <div style="flex:1;">
        <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Email # in Sequence</label>
        <input id="ec-num" class="form-input" type="number" value="${item.email_num||1}" style="width:100%;">
      </div>
      <div style="flex:1;">
        <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">State Override (blank = all states)</label>
        <input id="ec-state" class="form-input" value="${item.state||''}" placeholder="MT, AZ…" style="width:100%;text-transform:uppercase;" maxlength="2">
      </div>
    </div>`;

  const safeSubject = (item.subject||'').replace(/"/g,'&quot;');
  const body = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--muted);">
      <strong>Table:</strong> ${table} &nbsp;|&nbsp; <strong>Segment:</strong> ${item.segment}
    </div>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Subject Line</label>
    <input id="ec-subject" class="form-input" value="${safeSubject}" style="width:100%;margin-bottom:4px;">
    ${extraFields}
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin:12px 0 4px;">Body HTML &nbsp;<span style="font-weight:400;color:var(--muted);">(tokens: {firstName} {agentName} {state} {city})</span></label>
    <textarea id="ec-body" class="form-input" rows="10" style="width:100%;font-family:monospace;font-size:12px;resize:vertical;">${item.body_html||''}</textarea>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin:12px 0 4px;">Plain Text (optional)</label>
    <textarea id="ec-plain" class="form-input" rows="4" style="width:100%;font-family:monospace;font-size:12px;resize:vertical;">${item.body_plain||''}</textarea>`;

  showModal('✏ Edit Email', body, async () => {
    const updates = {
      subject:   document.getElementById('ec-subject').value.trim(),
      body_html: document.getElementById('ec-body').value,
      body_plain: document.getElementById('ec-plain').value
    };
    if (isDrip) {
      updates.topic = document.getElementById('ec-topic').value.trim();
    } else {
      updates.email_num = parseInt(document.getElementById('ec-num').value) || item.email_num;
      const sv = document.getElementById('ec-state').value.trim().toUpperCase();
      updates.state = sv || null;
    }
    if (!updates.subject || !updates.body_html) { showToast('Subject and body are required.'); return false; }
    const { error } = await supabaseClient.from(table).update(updates).eq('id', id);
    if (error) { showToast('Save failed: ' + error.message); return false; }
    showToast('✓ Email updated!');
    campaignItemsMap[id] = { ...item, ...updates };
    renderCampaigns();
  });
}

function aiSuggestEmail() {
  const body = `
    <div style="margin-bottom:16px;font-size:14px;color:var(--muted);line-height:1.6;">
      Tell the AI what kind of email to write. It will generate a complete draft you can review, edit, and save.
    </div>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Segment / Track</label>
    <select id="ai-seg" class="form-input" style="width:100%;margin-bottom:12px;">
      <option value="b2b|drip_content">B2B — Drip</option>
      <option value="b2c|drip_content">B2C — Drip</option>
      <option value="recruit|drip_content">Recruit — Drip</option>
      <option value="b2b|sequence_content">B2B — Outreach Sequence</option>
      <option value="b2c|sequence_content">B2C — Outreach Sequence</option>
      <option value="recruit-standard|sequence_content">Recruit — Outreach (Standard)</option>
      <option value="recruit-statefarm|sequence_content">Recruit — Outreach (State Farm)</option>
    </select>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Tone</label>
    <select id="ai-tone" class="form-input" style="width:100%;margin-bottom:12px;">
      <option value="professional and warm">Professional &amp; Warm</option>
      <option value="direct and punchy">Direct &amp; Punchy</option>
      <option value="conversational and friendly">Conversational &amp; Friendly</option>
      <option value="urgency-driven">Urgency-Driven</option>
    </select>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Topic / Angle — what should this email be about?</label>
    <textarea id="ai-topic" class="form-input" rows="3" placeholder="e.g. Introduce our Medicare supplement options and explain how we compare to other carriers on pricing" style="width:100%;resize:vertical;"></textarea>
    <div id="ai-status" style="margin-top:12px;font-size:13px;color:var(--muted);min-height:20px;"></div>`;

  showModal('✨ AI — Suggest New Email', body, async () => {
    const segVal   = document.getElementById('ai-seg').value;
    const tone     = document.getElementById('ai-tone').value;
    const topic    = document.getElementById('ai-topic').value.trim();
    const statusEl = document.getElementById('ai-status');
    if (!topic) { showToast('Please describe what the email should be about.'); return false; }

    const [segment, table] = segVal.split('|');
    statusEl.innerHTML = '<em>⚠ Generating… this usually takes 10–15 seconds.</em>';

    let result;
    try {
      const resp = await fetch(SUPABASE_URL + '/functions/v1/suggest-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
        body: JSON.stringify({ segment, table, tone, topic })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error(t); }
      result = await resp.json();
    } catch (err) {
      statusEl.innerHTML = '';
      showToast('AI generation failed: ' + err.message);
      return false;
    }

    closeModal();
    openAiReviewModal(table, segment, result);
    return false;
  }, { confirmLabel: '✨ Generate' });
}

function openAiReviewModal(table, segment, result) {
  const isDrip = table === 'drip_content';
  const extraFields = isDrip ? `
    <div style="margin-top:12px;">
      <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Topic (for library display)</label>
      <input id="ec-topic" class="form-input" value="${(result.topic||'AI Generated').replace(/"/g,'&quot;')}" style="width:100%;">
    </div>
    <div style="margin-top:12px;">
      <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Display Order (position within segment)</label>
      <input id="ec-order" class="form-input" type="number" value="99" style="width:100%;">
    </div>` : `
    <div style="margin-top:12px;display:flex;gap:12px;">
      <div style="flex:1;">
        <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Email # in Sequence</label>
        <input id="ec-num" class="form-input" type="number" value="${result.email_num||1}" style="width:100%;">
      </div>
      <div style="flex:1;">
        <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">State Override (blank = all states)</label>
        <input id="ec-state" class="form-input" value="" placeholder="MT, AZ…" style="text-transform:uppercase;" maxlength="2">
      </div>
    </div>`;

  const safeSubject = (result.subject||'').replace(/"/g,'&quot;');
  const body = `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#166534;">
      ✨ AI draft for <strong>${segment}</strong>. Review and edit, then click <strong>Save &amp; Activate</strong>.
    </div>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px;">Subject Line</label>
    <input id="ec-subject" class="form-input" value="${safeSubject}" style="width:100%;margin-bottom:4px;">
    ${extraFields}
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin:12px 0 4px;">Body HTML</label>
    <textarea id="ec-body" class="form-input" rows="10" style="width:100%;font-family:monospace;font-size:12px;resize:vertical;">${result.body_html||''}</textarea>
    <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin:12px 0 4px;">Plain Text</label>
    <textarea id="ec-plain" class="form-input" rows="4" style="width:100%;font-family:monospace;font-size:12px;resize:vertical;">${result.body_plain||''}</textarea>`;

  showModal('✨ Review AI Draft', body, async () => {
    const insertData = {
      segment,
      subject:    document.getElementById('ec-subject').value.trim(),
      body_html:  document.getElementById('ec-body').value,
      body_plain: document.getElementById('ec-plain').value,
      is_active:  true
    };
    if (!insertData.subject || !insertData.body_html) { showToast('Subject and body required.'); return false; }
    if (isDrip) {
      insertData.topic         = document.getElementById('ec-topic').value.trim() || 'AI Generated';
      insertData.cta_type      = 'edu';
      insertData.display_order = parseInt(document.getElementById('ec-order').value) || 99;
    } else {
      insertData.email_num = parseInt(document.getElementById('ec-num').value) || 1;
      const sv = document.getElementById('ec-state').value.trim().toUpperCase();
      insertData.state = sv || null;
    }
    const { error } = await supabaseClient.from(table).insert([insertData]);
    if (error) { showToast('Save failed: ' + error.message); return false; }
    showToast('✓ New email saved and activated!');
    renderCampaigns();
  }, { confirmLabel: '💾 Save & Activate' });
}

// ============================================================
// EMAIL OPENS
// ============================================================
async function renderOpens() {
  document.getElementById('page-opens').innerHTML = `<div style="color:var(--muted);font-size:14px;padding:40px;text-align:center;">Loading email opens...</div>`;
  let opensQ = supabaseClient.from('email_opens').select('*').order('opened_at', { ascending: false }).limit(1000);
  if (currentAgent && currentAgent.role !== 'system_owner') opensQ = opensQ.eq('agent_id', currentAgent.id);
  const { data: opens, error } = await opensQ;
  if (error) { document.getElementById('page-opens').innerHTML = `<div class="empty-state"><div class="emoji">&#9888;&#65039;</div><p>Error loading: ${error.message}</p></div>`; return; }
  const all = opens || [];
  const total = all.length;
  const email1 = all.filter(o => o.sequence_track === 'email_1').length;
  const email2 = all.filter(o => o.sequence_track === 'email_2').length;
  const email3 = all.filter(o => o.sequence_track === 'email_3').length;
  const rows = all.map(o => {
    const oEmail = o.contact_email || '';
    const oName  = o.contact_name  || '?';
    const contact = contacts.find(c => c.email && c.email.toLowerCase() === oEmail.toLowerCase());
    const contactId = contact ? contact.id : '';
    const emailSt = contact ? (contact.email_status || null) : null;
    const _stBadge = emailSt === 'valid'
      ? '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;background:#dcfce7;color:#16a34a;">&#10003; Valid</span>'
      : (emailSt === 'invalid' || emailSt === 'bounced' || emailSt === 'bad-domain' || emailSt === 'bad-syntax')
      ? '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;background:#fee2e2;color:#dc2626;">&#9888; Invalid</span>'
      : emailSt === 'risky'
      ? '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;background:#f3f4f6;color:#6b7280;">? Risky</span>'
      : emailSt === 'catch-all'
      ? '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;background:#fef9c3;color:#854d0e;">~ Catch-All</span>'
      : emailSt
      ? '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;background:#f3f4f6;color:#6b7280;">' + emailSt + '</span>'
      : '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;background:#f3f4f6;color:#9ca3af;">Unverified</span>';
    const initials = oName.split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase();
    return `<tr class="opens-row" onclick="viewContact('${contactId}','${oEmail.replace(/'/g,"\\'")}')">
      <td style="white-space:nowrap;"><span class="contact-avatar" style="width:30px;height:30px;font-size:11px;">${initials}</span><strong>${oName}</strong></td>
      <td style="color:var(--muted);font-size:13px;">${oEmail||'—'}</td>
      <td style="font-size:13px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${o.email_subject?o.email_subject.substring(0,60)+(o.email_subject.length>60?'…':''):'—'}</td>
      <td><span class="badge badge-group">${o.sequence_track||'—'}</span></td>
      <td style="font-size:12px;color:var(--muted);white-space:nowrap;">${formatTimeAgo(o.opened_at)}</td>
      <td>${_stBadge}</td>
      <td><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();viewContact('${contactId}','${oEmail.replace(/'/g,"\\'")}')">View &rarr;</button></td>
    </tr>`;
  }).join('');
  document.getElementById('page-opens').innerHTML = `
    <h2 class="section-title">&#128140; Email Opens</h2>
    <div class="opens-stats">
      <div class="opens-stat"><div class="num">${total}</div><div class="lbl">Total Opens</div></div>
      <div class="opens-stat" style="border-left-color:#3b82f6;"><div class="num">${email1}</div><div class="lbl">Email 1 Opens</div></div>
      <div class="opens-stat" style="border-left-color:#10b981;"><div class="num">${email2}</div><div class="lbl">Email 2 Opens</div></div>
      <div class="opens-stat" style="border-left-color:#8b5cf6;"><div class="num">${email3}</div><div class="lbl">Email 3 Opens</div></div>
    </div>
    <div class="contacts-table">
      ${all.length === 0
        ? `<div class="empty-state"><div class="emoji">&#128235;</div><p>No email opens tracked yet.</p></div>`
        : `<table><thead><tr><th>Name</th><th>Email</th><th>Subject</th><th>Email</th><th>Opened</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`}
    </div>`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return new Date(dateStr).toLocaleDateString();
}

// ============================================================
// CONTACT PANEL
// ============================================================
async function viewContact(contactId, email) {
  let c = contactId ? contacts.find(x => x.id === contactId) : null;
  if (!c && email) c = contacts.find(x => x.email && x.email.toLowerCase() === email.toLowerCase());
  if (!c) { showToast('Contact not found'); return; }

  const { data: opens } = await supabaseClient.from('email_opens').select('*').eq('contact_email', c.email).order('opened_at', { ascending: false });
  const { data: cc } = await supabaseClient.from('contact_companies').select('companies(name,slug)').eq('contact_id', c.id);
  const { data: activities } = await supabaseClient.rpc('get_contact_timeline', { p_contact_id: c.id, p_limit: 30 });
  const contactCompanies = (cc || []).map(r => r.companies);

  const typeClass = { 'Group/Employer': 'badge-group', 'Individual/Family': 'badge-individual' };
  const badgeClass = typeClass[c.type] || 'badge-agent';
  const initials = (c.name || '?').split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase();
  const seqStatus = c.sequence_status || 'Not Started';
  const seqStep = parseInt(c.sequence_step) || 0;
  const seqStatusClass = seqStatus === 'Active' ? 'badge-active' : seqStatus === 'Replied' ? 'badge-replied' : seqStatus === 'Completed' ? 'badge-completed' : 'badge-agent';
  const dots = [1,2,3].map(i => `<div class="seq-dot ${i < seqStep ? 'done' : i === seqStep && seqStatus === 'Active' ? 'active' : ''}"></div>`).join('');
  const opensCount = (opens || []).length;
  const ownerAgent = allAgents.find(a => a.id === c.agent_id);
  const _canSend = c.email_status === 'valid';
  const companyBadges = contactCompanies.map(co => `<span class="badge ${co.slug === 'primerica' ? 'badge-primerica' : 'badge-insured'}">${co.name}</span>`).join(' ');

  document.getElementById('contact-panel').innerHTML = `
    <div class="panel-header">
      <div class="panel-header-info">
        <div class="panel-avatar">${initials}</div>
        <div>
          <div class="panel-name">${c.name||'—'}</div>
          ${c.type ? `<span class="badge ${badgeClass}" style="font-size:11px;">${c.type}</span>` : ''}
          ${companyBadges ? `<div style="margin-top:4px;">${companyBadges}</div>` : ''}
        </div>
      </div>
      <button class="panel-close-btn" onclick="closeContactPanel()">&times;</button>
    </div>
    <div class="panel-body">
      <div class="panel-section">
        <div class="panel-label">Contact Info</div>
        ${c.email ? `<div class="panel-field"><span class="panel-field-icon">&#128140;</span><a href="mailto:${c.email}">${c.email}</a></div>` : ''}
        ${c.phone ? `<div class="panel-field"><span class="panel-field-icon">&#128222;</span>${c.phone}</div>` : ''}
        ${c.company ? `<div class="panel-field"><span class="panel-field-icon">&#127970;</span>${c.company}</div>` : ''}
        ${!c.email && !c.phone && !c.company ? '<div style="font-size:13px;color:var(--muted);">No contact info on file.</div>' : ''}
      </div>
      ${(c.linkedin_url||c.facebook_url||c.instagram_handle||c.twitter_handle||c.whatsapp_number||c.tiktok_handle||c.telegram_handle) ? `<div class="panel-section"><div class="panel-label">&#128279; Social Media</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">${c.linkedin_url ? `<a href="${(c.linkedin_url.indexOf('http')===0?'':'https://')+c.linkedin_url}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">&#128279; LinkedIn</a>` : ''}${c.facebook_url ? `<a href="${(c.facebook_url.indexOf('http')===0?'':'https://')+c.facebook_url}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">&#128101; Facebook</a>` : ''}${c.instagram_handle ? `<a href="https://www.instagram.com/${c.instagram_handle}/" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">&#128247; Instagram</a>` : ''}${c.twitter_handle ? `<a href="https://x.com/${c.twitter_handle}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">X / Twitter</a>` : ''}${c.whatsapp_number ? `<a href="https://wa.me/${c.whatsapp_number.replace(/[^0-9]/g,'')}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;color:#25d366;border-color:#25d366;text-decoration:none;">&#128172; WhatsApp</a>` : ''}${c.tiktok_handle ? `<a href="https://www.tiktok.com/@${c.tiktok_handle}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">&#127925; TikTok</a>` : ''}${c.telegram_handle ? `<a href="https://t.me/${c.telegram_handle}" target="_blank" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;">&#9992; Telegram</a>` : ''}</div></div>` : ''}
      ${ownerAgent ? `<div class="panel-section"><div class="panel-label">Owner</div><div class="panel-field"><span class="panel-field-icon">&#128100;</span>${ownerAgent.name} &mdash; <span style="color:var(--muted);font-size:12px;">${ownerAgent.agencies?.name||'No agency'}</span></div></div>` : ''}
      <div class="panel-section">
        <div class="panel-label">Outreach Sequence</div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span class="badge ${seqStatusClass}">${seqStatus}</span>
          ${seqStep > 0 ? `<span style="font-size:13px;color:var(--muted);">Step ${seqStep} of 3</span>` : ''}
        </div>
        <div class="seq-progress">${dots}</div>
        ${c.last_email_sent_at ? `<div style="font-size:12px;color:var(--muted);margin-top:8px;">Last sent: ${new Date(c.last_email_sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>` : ''}
      </div>
      <div class="panel-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div class="panel-label" style="margin-bottom:0;">Activity Timeline</div>
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 10px;" onclick="addContactNote('${c.id}')">📝 Add Note</button>
        </div>
        <div style="max-height:320px;overflow-y:auto;padding-right:2px;">
          ${_renderActivityTimeline(activities, c.id)}
        </div>
        ${c.notes ? `<details style="margin-top:10px;"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;user-select:none;">📁 Historical Notes (pre-upgrade)</summary><div style="white-space:pre-wrap;font-size:12px;color:var(--text-secondary);margin-top:6px;padding:8px 10px;background:var(--surface-3);border-radius:6px;max-height:180px;overflow-y:auto;line-height:1.5;">${c.notes.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div></details>` : ''}
      </div>
      <div class="panel-section">
        <div class="panel-label">Email Opens (${opensCount})</div>
        ${opensCount > 0
          ? (opens||[]).map(o => `<div class="panel-open-item"><div><span class="badge badge-group" style="margin-bottom:4px;display:inline-block;">${o.sequence_track||'—'}</span><div class="panel-open-subject">${o.email_subject?o.email_subject.substring(0,55)+(o.email_subject.length>55?'…':''):'—'}</div></div><div class="panel-open-meta">${formatTimeAgo(o.opened_at)}</div></div>`).join('')
          : '<div style="font-size:13px;color:var(--muted);padding:8px 0;">No email opens recorded yet.</div>'}
      </div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-outline" onclick="closeContactPanel()">Close</button>
      <button class="btn btn-outline btn-sm" onclick="logOutreach('${c.id}','','')" style="font-size:12px;" title="Log social or phone outreach">&#128221; Log Outreach</button>
      ${(c.whatsapp_number||c.phone) ? `<button class="btn btn-outline btn-sm" onclick="openWhatsApp('${c.id}')" style="font-size:12px;color:#25d366;border-color:#25d366;" title="Send WhatsApp + auto-log">&#128172; WhatsApp</button>` : ''}
      ${_canSend
        ? `<button class="btn btn-outline btn-sm" onclick="closeContactPanel();transferContact('${c.id}')" title="Transfer this contact to another agent"><i class="ti ti-arrows-exchange"></i> Transfer</button>`
        : `<button class="btn btn-outline btn-sm" disabled title="Email must be Verified before transferring" style="opacity:0.4;cursor:not-allowed;"><i class="ti ti-arrows-exchange"></i> Transfer</button>`}
      ${_canSend
        ? `<button class="btn btn-accent btn-sm" onclick="recruitContact('${c.id}')" title="Recruit this contact as a Kannon agent">&#128101; Recruit</button>`
        : `<button class="btn btn-accent btn-sm" disabled title="Email must be Verified before adding to sequence" style="opacity:0.4;cursor:not-allowed;">&#128101; Recruit</button>`}
      <button class="btn btn-outline btn-sm" onclick="startSequence('${c.id}')" title="Enroll in outreach sequence">&#9654; Sequence</button>
      <button class="btn btn-primary" onclick="closeContactPanel();editContact('${c.id}')">&#9999;&#65039; Edit</button>
    </div>`;
  document.getElementById('contact-panel').classList.add('open');
  document.getElementById('panel-overlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeContactPanel() {
  document.getElementById('contact-panel').classList.remove('open');
  document.getElementById('panel-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function closeAllPanels() { closeContactPanel(); closeDealPanel(); }

// ─────────────────────────────────────────────────────────────
// ACTIVITY TIMELINE
// ─────────────────────────────────────────────────────────────
const ACTIVITY_META = {
  email_sent:          { icon: '📧', color: '#94a3b8', label: 'Email Sent' },
  email_opened:        { icon: '👁',  color: '#60a5fa', label: 'Email Opened' },
  email_replied:       { icon: '💬', color: '#34d399', label: 'Reply Received' },
  email_bounced_hard:  { icon: '❌', color: '#f87171', label: 'Hard Bounce' },
  email_bounced_soft:  { icon: '⚠️', color: '#fbbf24', label: 'Soft Bounce' },
  email_blocked:       { icon: '🚫', color: '#f87171', label: 'Email Blocked' },
  email_opted_out:     { icon: '🔕', color: '#94a3b8', label: 'Opted Out' },
  email_complained:    { icon: '🔥', color: '#ef4444', label: 'Spam Complaint' },
  email_auto_reply:    { icon: '🤖', color: '#94a3b8', label: 'Auto-Reply / OOO' },
  meeting_booked:      { icon: '📅', color: '#34d399', label: 'Meeting Booked' },
  meeting_attended:    { icon: '✅', color: '#34d399', label: 'Meeting Attended' },
  meeting_no_show:     { icon: '👻', color: '#fbbf24', label: 'No-Show' },
  meeting_canceled:    { icon: '❌', color: '#fbbf24', label: 'Meeting Canceled' },
  meeting_rescheduled: { icon: '🔄', color: '#60a5fa', label: 'Meeting Rescheduled' },
  calendar_accepted:   { icon: '✅', color: '#34d399', label: 'Calendar Accepted' },
  calendar_declined:   { icon: '❌', color: '#fbbf24', label: 'Calendar Declined' },
  call_made:           { icon: '📞', color: '#94a3b8', label: 'Call Made' },
  call_connected:      { icon: '📞', color: '#34d399', label: 'Call Connected' },
  call_voicemail:      { icon: '📞', color: '#94a3b8', label: 'Voicemail Left' },
  note_added:          { icon: '📝', color: '#fbbf24', label: 'Note' },
  status_changed:      { icon: '🔄', color: '#94a3b8', label: 'Status Changed' },
};

function _renderActivityTimeline(acts, contactId) {
  if (!acts || acts.length === 0) {
    return `<div style="text-align:center;padding:16px 0;color:var(--text-muted);font-size:13px;">
      <div style="font-size:24px;margin-bottom:6px;">📋</div>
      No activity yet — events will appear here automatically.
      <br><button class="btn btn-outline btn-sm" style="margin-top:10px;" onclick="addContactNote('${contactId}')">📝 Add first note</button>
    </div>`;
  }
  return acts.map(a => {
    const meta = ACTIVITY_META[a.activity_type] || { icon: '•', color: '#94a3b8', label: a.activity_type };
    const isUrgent = a.activity_type === 'email_complained';
    const timeAgo = formatTimeAgo(a.created_at);
    const md = a.metadata || {};
    const snippet = a.body_snippet || md.bounce_reason || (md.ooo_return_date ? 'Returns: ' + md.ooo_return_date : '') || '';
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:0.5px solid var(--border);align-items:flex-start;">
      <div style="flex-shrink:0;width:28px;height:28px;border-radius:50%;background:${meta.color}22;display:flex;align-items:center;justify-content:center;font-size:13px;margin-top:1px;">${meta.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;flex-wrap:wrap;">
          <span style="font-size:13px;font-weight:600;color:${isUrgent?'#ef4444':'var(--text)'};">${meta.label}${isUrgent?' <span style="background:#ef4444;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;vertical-align:middle;margin-left:4px;">URGENT</span>':''}</span>
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0;">${timeAgo}</span>
        </div>
        ${a.subject ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${esc(a.subject)}</div>` : ''}
        ${snippet ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;">${esc(snippet).substring(0,120)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function addContactNote(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;
  showModal(
    '📝 Add Note — ' + (c.name || 'Contact'),
    `<div><label style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px;">Note</label>
     <textarea id="manual-note-text" rows="5" placeholder="e.g. Spoke briefly — interested in life coverage, wants to revisit after school year. Call in September." style="width:100%;box-sizing:border-box;resize:vertical;"></textarea></div>`,
    async function() {
      const noteText = (document.getElementById('manual-note-text').value || '').trim();
      if (!noteText) { showToast('Please enter a note'); return false; }
      const { error } = await supabaseClient.rpc('log_activity', {
        p_contact_id:    contactId,
        p_agent_id:      currentAgent.id,
        p_activity_type: 'note_added',
        p_subject:       'Manual Note',
        p_body_snippet:  noteText,
        p_metadata:      {}
      });
      if (error) { showToast('Error: ' + error.message); return false; }
      showToast('✓ Note saved');
      viewContact(contactId);
    }
  );
  setTimeout(() => { const ta = document.getElementById('manual-note-text'); if (ta) ta.focus(); }, 100);
}

function closeDealPanel() {
  document.getElementById('deal-panel').classList.remove('open');
  document.getElementById('panel-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function renderActivityTimeline(dealId) {
  const acts = dealActivities.filter(a => a.deal_id === dealId);
  if (!acts.length) return '<div style="font-size:13px;color:var(--text-muted);padding:8px 0;">No activity logged yet.</div>';
  const icons = { note: '&#128221;', call: '&#128222;', email: '&#9993;', stage_change: '&#9889;' };
  return acts.map(a => {
    const dt = new Date(a.created_at);
    const ds = dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + ' ' + dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    return '<div class="activity-item">' +
      '<div class="activity-dot ' + a.type + '">' + (icons[a.type] || '&#128204;') + '</div>' +
      '<div class="activity-body">' +
        '<div class="activity-content">' + a.content + '</div>' +
        '<div class="activity-meta">' + ds + '</div>' +
      '</div></div>';
  }).join('');
}

async function saveDealActivity(dealId) {
  const typeEl    = document.getElementById('act-type-'    + dealId);
  const contentEl = document.getElementById('act-content-' + dealId);
  if (!typeEl || !contentEl) return;
  const content = contentEl.value.trim();
  if (!content) { showToast('Add some content first'); return; }
  const { data, error } = await supabaseClient.from('deal_activities').insert({
    deal_id: dealId, agent_id: currentAgent.id, type: typeEl.value, content
  }).select().single();
  if (error) { showToast('Error: ' + error.message); return; }
  dealActivities.unshift(data);
  contentEl.value = '';
  const tl = document.getElementById('timeline-' + dealId);
  if (tl) tl.innerHTML = renderActivityTimeline(dealId);
  showToast('&#10003; Activity logged!');
}

// ── Stage-aware quick actions ─────────────────────────────────────────────────
function getStageActions(pipeline, stage) {
  var m = {
    'group-employer': {
      'New Lead':   ['Request Employee Census','Schedule Discovery Call','Send Company Overview'],
      'Contacted':  ['Follow Up on Interest','Schedule Discovery Call','Request Meeting'],
      'Responded':  ['Send Group Quote','Schedule Benefit Presentation','Request Signed Census'],
      'Proposal':   ['Follow Up on Proposal','Answer Benefit Questions','Request Decision Date'],
      'Closing':    ['Send Group Application','Schedule Enrollment Meeting','Confirm Effective Date'],
      'Won':        ['Set Annual Renewal Reminder','Request Employer Referrals','Plan Renewal Strategy']
    },
    'individual-family': {
      'New Lead':   ['Schedule Needs Analysis','Send Plan Overview','Verify Coverage Needs'],
      'Contacted':  ['Follow Up with Plan Options','Schedule Call','Confirm Best Time to Talk'],
      'Responded':  ['Send Individual Quote','Compare Plan Options','Schedule Enrollment Call'],
      'Proposal':   ['Follow Up on Quote','Answer Plan Questions','Request Enrollment Decision'],
      'Closing':    ['Complete Application','Confirm Coverage Start Date','Submit Application'],
      'Won':        ['Set Renewal Reminder','Request Referrals','Confirm Coverage Active']
    },
    'agent-insured': {
      'New Lead':    ['Schedule Recruiting Call','Send Agent Overview','Check License Status'],
      'Interested':  ['Schedule Recruiting Call','Send Company Overview','Check License Status'],
      'Meeting Set': ['Prepare Recruiting Packet','Send Contracting Docs','Answer Questions'],
      'Contracting': ['Follow Up on Contract','Verify Appointment','Check E&O Insurance'],
      'Active':      ['Check First Month Production','Offer Product Training','Schedule Check-in'],
      'Won':         ['Set Production Review','Offer Advanced Training','Request Agent Referrals']
    },
    'agent-kannon': {
      'New Lead':    ['Schedule Recruiting Call','Send Kannon Overview','Discuss Opportunity'],
      'Interested':  ['Schedule Recruiting Call','Send Kannon Overview','Discuss Opportunity'],
      'Meeting Set': ['Prepare Offer Package','Send Contracting Docs','Answer Questions'],
      'Contracting': ['Follow Up on Contract','Verify License Transfer','Complete Onboarding'],
      'Active':      ['Check First Month Production','Offer Training','Schedule Team Meeting'],
      'Won':         ['Set Production Review','Introduce to Team','Plan Growth Strategy']
    }
  };
  return (m[pipeline] && m[pipeline][stage]) || ['Follow Up','Schedule Call','Log Activity'];
}

// ── Deal task UI helpers ──────────────────────────────────────────────────────
function _qdt(el) { deleteDealTaskItem(el.getAttribute('data-tid'), el.getAttribute('data-did')); }
function _qtt(el, done) { toggleDealTask(el.getAttribute('data-tid'), el.getAttribute('data-did'), done); }

function renderDealTaskList(dealId) {
  var tasks = dealTasks.filter(function(t) { return t.deal_id === dealId; });
  if (!tasks.length) {
    return '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">No tasks yet — add one below or use Quick Actions above</div>';
  }
  var open = tasks.filter(function(t) { return !t.completed; });
  var done = tasks.filter(function(t) { return t.completed;  });
  var html = '';
  open.forEach(function(t) {
    var today   = new Date().toISOString().slice(0, 10);
    var overdue = t.due_date && t.due_date < today;
    html += '<div class="task-item">'
      + '<input type="checkbox" data-tid="' + t.id + '" data-did="' + dealId + '" onchange="_qtt(this,true)" />'
      + '<span class="task-title">' + (t.title || '') + '</span>'
      + (t.due_date ? '<span class="task-due-date" style="color:' + (overdue ? '#ef4444' : 'var(--text-muted)') + '">' + t.due_date + '</span>' : '')
      + '<button class="task-del-btn" data-tid="' + t.id + '" data-did="' + dealId + '" onclick="_qdt(this)" title="Remove task">&#215;</button>'
      + '</div>';
  });
  if (done.length) {
    html += '<details style="margin-top:6px;"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;list-style:none;">&#9654; Done (' + done.length + ')</summary>';
    done.forEach(function(t) {
      html += '<div class="task-item">'
        + '<input type="checkbox" checked data-tid="' + t.id + '" data-did="' + dealId + '" onchange="_qtt(this,false)" />'
        + '<span class="task-title" style="text-decoration:line-through;opacity:0.45;">' + (t.title || '') + '</span>'
        + '<button class="task-del-btn" data-tid="' + t.id + '" data-did="' + dealId + '" onclick="_qdt(this)">&#215;</button>'
        + '</div>';
    });
    html += '</details>';
  }
  return html;
}

// Dashboard widget — returns a full dash-card HTML string
function renderTasksWidget() {
  var today    = new Date().toISOString().slice(0, 10);
  var open     = dealTasks.filter(function(t) { return !t.completed; });
  var overdue  = open.filter(function(t) { return t.due_date && t.due_date < today; });
  var dueToday = open.filter(function(t) { return t.due_date === today; });
  var upcoming = open.filter(function(t) { return t.due_date && t.due_date > today; });
  var showList = overdue.concat(dueToday).concat(upcoming).slice(0, 5);
  var badge    = open.length
    ? ' <span style="background:rgba(99,102,241,0.15);color:#818cf8;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">' + open.length + '</span>'
    : '';
  var header = _ctitle('ti-checks', 'My Tasks' + badge);
  if (!showList.length) {
    return '<div class="dash-card">' + header
      + '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px 0;">'
      + '<i class="ti ti-circle-check" style="font-size:22px;display:block;margin-bottom:4px;color:var(--text-success);"></i>'
      + 'No open tasks — all caught up!</div>'
      + '<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage(\'pipelines\')">View Pipelines &rarr;</button></div>'
      + '</div>';
  }
  var rows = showList.map(function(t) {
    var deal    = deals.find(function(d) { return d.id === t.deal_id; });
    var isOver  = t.due_date && t.due_date < today;
    var isToday = t.due_date === today;
    var dueLbl  = t.due_date
      ? (isOver  ? '<span style="color:#ef4444;">Overdue: ' + t.due_date + '</span>'
                 : isToday ? '<span style="color:#f59e0b;">Due today</span>'
                 : t.due_date)
      : '';
    return '<div class="action-item" style="padding:6px 0;">'
      + '<div class="action-item-info">'
      + '<div class="action-item-name" style="font-size:12px;">' + (t.title || '') + '</div>'
      + '<div class="action-item-sub">' + (deal ? deal.title : 'Pipeline deal')
      + (dueLbl ? ' &bull; ' + dueLbl : '') + '</div></div>'
      + '<button class="btn btn-outline btn-sm" onclick="openDealPanel(&#39;' + t.deal_id + '&#39;)">Open</button>'
      + '</div>';
  }).join('');
  return '<div class="dash-card">' + header + rows
    + (open.length > 5
      ? '<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage(\'pipelines\')">' + open.length + ' tasks total &rarr;</button></div>'
      : '')
    + '</div>';
}

// ── Deal task CRUD ────────────────────────────────────────────────────────────
async function quickAddTask(dealId, title) {
  var ins = await supabaseClient.from('deal_tasks')
    .insert({ deal_id: dealId, user_id: currentUser.id, title: title, completed: false })
    .select().single();
  if (ins.error) { showToast('Error: ' + ins.error.message); return; }
  dealTasks.push(ins.data);
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
  showToast('Task added: ' + title);
}

async function addDealTaskFromInput(dealId) {
  var inp    = document.getElementById('task-input-' + dealId);
  var dateEl = document.getElementById('task-date-' + dealId);
  if (!inp || !inp.value.trim()) return;
  var title = inp.value.trim();
  var due   = dateEl && dateEl.value ? dateEl.value : null;
  var ins = await supabaseClient.from('deal_tasks')
    .insert({ deal_id: dealId, user_id: currentUser.id, title: title, due_date: due, completed: false })
    .select().single();
  if (ins.error) { showToast('Error: ' + ins.error.message); return; }
  dealTasks.push(ins.data);
  inp.value = '';
  if (dateEl) dateEl.value = '';
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
  showToast('Task added');
}

async function toggleDealTask(taskId, dealId, done) {
  var upd = done
    ? { completed: true,  completed_at: new Date().toISOString() }
    : { completed: false, completed_at: null };
  var _updRes = await supabaseClient.from('deal_tasks').update(upd).eq('id', taskId);
  var error = _updRes.error;
  if (error) { showToast('Error: ' + error.message); return; }
  var t = dealTasks.find(function(x) { return x.id === taskId; });
  if (t) { t.completed = done; t.completed_at = done ? new Date().toISOString() : null; }
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
}

async function deleteDealTaskItem(taskId, dealId) {
  var _delRes = await supabaseClient.from('deal_tasks').delete().eq('id', taskId);
  var error = _delRes.error;
  if (error) { showToast('Error: ' + error.message); return; }
  dealTasks = dealTasks.filter(function(x) { return x.id !== taskId; });
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
}

// ── Send email from deal panel ────────────────────────────────────────────────
function openDealEmailModal(dealId) {
  var deal    = deals.find(function(d) { return d.id === dealId; });
  var contact = deal && deal.contact_id ? contacts.find(function(c) { return c.id === deal.contact_id; }) : null;
  var aName   = currentAgent ? (currentAgent.name  || '') : '';
  var aPhone  = currentAgent ? (currentAgent.phone || '') : '';
  var aEmail  = currentAgent ? (currentAgent.email || '') : '';
  var toEmail = contact && contact.email ? contact.email : '';
  var toName  = contact ? (contact.name  || '') : '';
  var dTitle  = deal    ? (deal.title    || '') : '';
  var sig     = aName + (aPhone ? '\n' + aPhone : '') + (aEmail ? '\n' + aEmail : '');
  var defBody = 'Hi ' + toName + ',\n\nI wanted to follow up regarding ' + dTitle + '.\n\nPlease don\'t hesitate to reach out with any questions or to schedule a time to connect.\n\nBest regards,\n' + sig;
  showModal('Send Email',
    '<div style="display:flex;flex-direction:column;gap:10px;">'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">To</label>'
    + '<input type="text" id="em-to" value="' + toEmail + '" placeholder="recipient@email.com" /></div>'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">Subject</label>'
    + '<input type="text" id="em-subj" value="Following up — ' + dTitle + '" /></div>'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">Message</label>'
    + '<textarea id="em-body" rows="10" style="width:100%;resize:vertical;background:var(--surface-1);border:0.5px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px;font-family:inherit;font-size:13px;box-sizing:border-box;">' + defBody + '</textarea></div>'
    + '</div>',
    async function() {
      var to   = (document.getElementById('em-to')   || {}).value || '';
      var subj = (document.getElementById('em-subj') || {}).value || '';
      var body = (document.getElementById('em-body') || {}).value || '';
      to = to.trim(); subj = subj.trim();
      if (!to || !subj) { showToast('To and Subject are required'); return false; }
      await sendDealEmail(dealId, to, subj, body);
      return false;
    },
    { confirmLabel: '&#9993; Send Email' }
  );
}

async function sendDealEmail(dealId, to, subj, body) {
  closeModal();
  showToast('Sending...');
  try {
    var sess  = await supabaseClient.auth.getSession();
    var token = sess.data.session ? sess.data.session.access_token : '';
    var res   = await fetch(SUPABASE_URL + '/functions/v1/send-deal-email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ deal_id: dealId, to: to, subject: subj,
                                body: body.replace(/\n/g, '<br>'), agent_id: currentUser.id })
    });
    var result = await res.json();
    if (!res.ok || result.error) { showToast('Error: ' + (result.error || 'Send failed')); return; }
    dealActivities.unshift({
      deal_id: dealId, agent_id: currentUser.id, type: 'email',
      content: 'Email sent to ' + to + ': ' + subj, created_at: new Date().toISOString()
    });
    var tl = document.getElementById('timeline-' + dealId);
    if (tl) tl.innerHTML = renderActivityTimeline(dealId);
    showToast('&#9993; Email sent!');
  } catch(e) {
    showToast('Send failed: ' + e.message);
  }
}


// ── Stage-aware quick actions ─────────────────────────────────────────────────
function getStageActions(pipeline, stage) {
  var m = {
    'group-employer': {
      'New Lead':   ['Request Employee Census','Schedule Discovery Call','Send Company Overview'],
      'Contacted':  ['Follow Up on Interest','Schedule Discovery Call','Request Meeting'],
      'Responded':  ['Send Group Quote','Schedule Benefit Presentation','Request Signed Census'],
      'Proposal':   ['Follow Up on Proposal','Answer Benefit Questions','Request Decision Date'],
      'Closing':    ['Send Group Application','Schedule Enrollment Meeting','Confirm Effective Date'],
      'Won':        ['Set Annual Renewal Reminder','Request Employer Referrals','Plan Renewal Strategy']
    },
    'individual-family': {
      'New Lead':   ['Schedule Needs Analysis','Send Plan Overview','Verify Coverage Needs'],
      'Contacted':  ['Follow Up with Plan Options','Schedule Call','Confirm Best Time to Talk'],
      'Responded':  ['Send Individual Quote','Compare Plan Options','Schedule Enrollment Call'],
      'Proposal':   ['Follow Up on Quote','Answer Plan Questions','Request Enrollment Decision'],
      'Closing':    ['Complete Application','Confirm Coverage Start Date','Submit Application'],
      'Won':        ['Set Renewal Reminder','Request Referrals','Confirm Coverage Active']
    },
    'agent-insured': {
      'New Lead':    ['Schedule Recruiting Call','Send Agent Overview','Check License Status'],
      'Interested':  ['Schedule Recruiting Call','Send Company Overview','Check License Status'],
      'Meeting Set': ['Prepare Recruiting Packet','Send Contracting Docs','Answer Questions'],
      'Contracting': ['Follow Up on Contract','Verify Appointment','Check E&O Insurance'],
      'Active':      ['Check First Month Production','Offer Product Training','Schedule Check-in'],
      'Won':         ['Set Production Review','Offer Advanced Training','Request Agent Referrals']
    },
    'agent-kannon': {
      'New Lead':    ['Schedule Recruiting Call','Send Kannon Overview','Discuss Opportunity'],
      'Interested':  ['Schedule Recruiting Call','Send Kannon Overview','Discuss Opportunity'],
      'Meeting Set': ['Prepare Offer Package','Send Contracting Docs','Answer Questions'],
      'Contracting': ['Follow Up on Contract','Verify License Transfer','Complete Onboarding'],
      'Active':      ['Check First Month Production','Offer Training','Schedule Team Meeting'],
      'Won':         ['Set Production Review','Introduce to Team','Plan Growth Strategy']
    }
  };
  return (m[pipeline] && m[pipeline][stage]) || ['Follow Up','Schedule Call','Log Activity'];
}

// ── Deal task UI helpers ──────────────────────────────────────────────────────
function renderDealTaskList(dealId) {
  var tasks = dealTasks.filter(function(t) { return t.deal_id === dealId; });
  if (!tasks.length) {
    return '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">No tasks yet — add one below or use Quick Actions above</div>';
  }
  var open = tasks.filter(function(t) { return !t.completed; });
  var done = tasks.filter(function(t) { return t.completed;  });
  var html = '';
  open.forEach(function(t) {
    var today   = new Date().toISOString().slice(0, 10);
    var overdue = t.due_date && t.due_date < today;
    html += '<div class="task-item">'
      + '<input type="checkbox" onchange="toggleDealTask(&#39;' + t.id + '&#39;,&#39;' + dealId + '&#39;,true)" />'
      + '<span class="task-title">' + (t.title || '') + '</span>'
      + (t.due_date ? '<span class="task-due-date" style="color:' + (overdue ? '#ef4444' : 'var(--text-muted)') + '">' + t.due_date + '</span>' : '')
      + '<button class="task-del-btn" onclick="deleteDealTaskItem(&#39;' + t.id + '&#39;,&#39;' + dealId + '&#39;)" title="Remove task">&#215;</button>'
      + '</div>';
  });
  if (done.length) {
    html += '<details style="margin-top:6px;"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer;list-style:none;">&#9654; Done (' + done.length + ')</summary>';
    done.forEach(function(t) {
      html += '<div class="task-item">'
        + '<input type="checkbox" checked onchange="toggleDealTask(&#39;' + t.id + '&#39;,&#39;' + dealId + '&#39;,false)" />'
        + '<span class="task-title" style="text-decoration:line-through;opacity:0.45;">' + (t.title || '') + '</span>'
        + '<button class="task-del-btn" onclick="deleteDealTaskItem(&#39;' + t.id + '&#39;,&#39;' + dealId + '&#39;)">&#215;</button>'
        + '</div>';
    });
    html += '</details>';
  }
  return html;
}

// Dashboard widget — returns a full dash-card HTML string
function renderTasksWidget() {
  var today    = new Date().toISOString().slice(0, 10);
  var open     = dealTasks.filter(function(t) { return !t.completed; });
  var overdue  = open.filter(function(t) { return t.due_date && t.due_date < today; });
  var dueToday = open.filter(function(t) { return t.due_date === today; });
  var upcoming = open.filter(function(t) { return t.due_date && t.due_date > today; });
  var showList = overdue.concat(dueToday).concat(upcoming).slice(0, 5);
  var badge    = open.length
    ? ' <span style="background:rgba(99,102,241,0.15);color:#818cf8;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">' + open.length + '</span>'
    : '';
  var header = _ctitle('ti-checks', 'My Tasks' + badge);
  if (!showList.length) {
    return '<div class="dash-card">' + header
      + '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px 0;">'
      + '<i class="ti ti-circle-check" style="font-size:22px;display:block;margin-bottom:4px;color:var(--text-success);"></i>'
      + 'No open tasks — all caught up!</div>'
      + '<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage(\'pipelines\')">View Pipelines &rarr;</button></div>'
      + '</div>';
  }
  var rows = showList.map(function(t) {
    var deal    = deals.find(function(d) { return d.id === t.deal_id; });
    var isOver  = t.due_date && t.due_date < today;
    var isToday = t.due_date === today;
    var dueLbl  = t.due_date
      ? (isOver  ? '<span style="color:#ef4444;">Overdue: ' + t.due_date + '</span>'
                 : isToday ? '<span style="color:#f59e0b;">Due today</span>'
                 : t.due_date)
      : '';
    return '<div class="action-item" style="padding:6px 0;">'
      + '<div class="action-item-info">'
      + '<div class="action-item-name" style="font-size:12px;">' + (t.title || '') + '</div>'
      + '<div class="action-item-sub">' + (deal ? deal.title : 'Pipeline deal')
      + (dueLbl ? ' &bull; ' + dueLbl : '') + '</div></div>'
      + '<button class="btn btn-outline btn-sm" onclick="openDealPanel(&#39;' + t.deal_id + '&#39;)">Open</button>'
      + '</div>';
  }).join('');
  return '<div class="dash-card">' + header + rows
    + (open.length > 5
      ? '<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage(\'pipelines\')">' + open.length + ' tasks total &rarr;</button></div>'
      : '')
    + '</div>';
}

// ── Deal task CRUD ────────────────────────────────────────────────────────────
async function quickAddTask(dealId, title) {
  var ins = await supabaseClient.from('deal_tasks')
    .insert({ deal_id: dealId, user_id: currentUser.id, title: title, completed: false })
    .select().single();
  if (ins.error) { showToast('Error: ' + ins.error.message); return; }
  dealTasks.push(ins.data);
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
  showToast('Task added: ' + title);
}

async function addDealTaskFromInput(dealId) {
  var inp    = document.getElementById('task-input-' + dealId);
  var dateEl = document.getElementById('task-date-' + dealId);
  if (!inp || !inp.value.trim()) return;
  var title = inp.value.trim();
  var due   = dateEl && dateEl.value ? dateEl.value : null;
  var ins = await supabaseClient.from('deal_tasks')
    .insert({ deal_id: dealId, user_id: currentUser.id, title: title, due_date: due, completed: false })
    .select().single();
  if (ins.error) { showToast('Error: ' + ins.error.message); return; }
  dealTasks.push(ins.data);
  inp.value = '';
  if (dateEl) dateEl.value = '';
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
  showToast('Task added');
}

async function toggleDealTask(taskId, dealId, done) {
  var upd = done
    ? { completed: true,  completed_at: new Date().toISOString() }
    : { completed: false, completed_at: null };
  var { error } = await supabaseClient.from('deal_tasks').update(upd).eq('id', taskId);
  if (error) { showToast('Error: ' + error.message); return; }
  var t = dealTasks.find(function(x) { return x.id === taskId; });
  if (t) { t.completed = done; t.completed_at = done ? new Date().toISOString() : null; }
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
}

async function deleteDealTaskItem(taskId, dealId) {
  var { error } = await supabaseClient.from('deal_tasks').delete().eq('id', taskId);
  if (error) { showToast('Error: ' + error.message); return; }
  dealTasks = dealTasks.filter(function(x) { return x.id !== taskId; });
  var el = document.getElementById('task-list-' + dealId);
  if (el) el.innerHTML = renderDealTaskList(dealId);
}

// ── Send email from deal panel ────────────────────────────────────────────────
function openDealEmailModal(dealId) {
  var deal    = deals.find(function(d) { return d.id === dealId; });
  var contact = deal && deal.contact_id ? contacts.find(function(c) { return c.id === deal.contact_id; }) : null;
  var aName   = currentAgent ? (currentAgent.name  || '') : '';
  var aPhone  = currentAgent ? (currentAgent.phone || '') : '';
  var aEmail  = currentAgent ? (currentAgent.email || '') : '';
  var toEmail = contact && contact.email ? contact.email : '';
  var toName  = contact ? (contact.name  || '') : '';
  var dTitle  = deal    ? (deal.title    || '') : '';
  var sig     = aName + (aPhone ? '\n' + aPhone : '') + (aEmail ? '\n' + aEmail : '');
  var defBody = 'Hi ' + toName + ',\n\nI wanted to follow up regarding ' + dTitle + '.\n\nPlease don\'t hesitate to reach out with any questions or to schedule a time to connect.\n\nBest regards,\n' + sig;
  showModal('Send Email',
    '<div style="display:flex;flex-direction:column;gap:10px;">'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">To</label>'
    + '<input type="text" id="em-to" value="' + toEmail + '" placeholder="recipient@email.com" /></div>'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">Subject</label>'
    + '<input type="text" id="em-subj" value="Following up — ' + dTitle + '" /></div>'
    + '<div><label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);display:block;margin-bottom:3px;">Message</label>'
    + '<textarea id="em-body" rows="10" style="width:100%;resize:vertical;background:var(--surface-1);border:0.5px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px;font-family:inherit;font-size:13px;box-sizing:border-box;">' + defBody + '</textarea></div>'
    + '</div>',
    async function() {
      var to   = (document.getElementById('em-to')   || {}).value || '';
      var subj = (document.getElementById('em-subj') || {}).value || '';
      var body = (document.getElementById('em-body') || {}).value || '';
      to = to.trim(); subj = subj.trim();
      if (!to || !subj) { showToast('To and Subject are required'); return false; }
      await sendDealEmail(dealId, to, subj, body);
      return false;
    },
    { confirmLabel: '&#9993; Send Email' }
  );
}

async function sendDealEmail(dealId, to, subj, body) {
  closeModal();
  showToast('Sending...');
  try {
    var sess  = await supabaseClient.auth.getSession();
    var token = sess.data.session ? sess.data.session.access_token : '';
    var res   = await fetch(SUPABASE_URL + '/functions/v1/send-deal-email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ deal_id: dealId, to: to, subject: subj,
                                body: body.replace(/\n/g, '<br>'), agent_id: currentUser.id })
    });
    var result = await res.json();
    if (!res.ok || result.error) { showToast('Error: ' + (result.error || 'Send failed')); return; }
    dealActivities.unshift({
      deal_id: dealId, agent_id: currentUser.id, type: 'email',
      content: 'Email sent to ' + to + ': ' + subj, created_at: new Date().toISOString()
    });
    var tl = document.getElementById('timeline-' + dealId);
    if (tl) tl.innerHTML = renderActivityTimeline(dealId);
    showToast('&#9993; Email sent!');
  } catch(e) {
    showToast('Send failed: ' + e.message);
  }
}


function openDealPanel(dealId) {
  const deal    = deals.find(d => d.id === dealId); if (!deal) return;
  const contact = contacts.find(c => c.id === deal.contact_id);
  const pipeline = PIPELINES[deal.pipeline] || { name: deal.pipeline };
  const isHealth = ['group-employer','individual-family'].includes(deal.pipeline);

  function fmtDate(d) {
    if (!d) return null;
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  }
  function dv(val, empty) { return val ? String(val) : '<span class="empty">' + (empty||'Not set') + '</span>'; }

  var contactHTML = contact
    ? '<div class="panel-field"><span class="panel-field-icon">&#128100;</span><strong>' + contact.name + '</strong>' + (contact.company ? ' &mdash; ' + contact.company : '') + '</div>'
      + (contact.phone ? '<div class="panel-field"><span class="panel-field-icon">&#128222;</span><a href="tel:' + contact.phone + '">' + contact.phone + '</a></div>' : '')
      + (contact.email ? '<div class="panel-field"><span class="panel-field-icon">&#9993;</span><a href="mailto:' + contact.email + '">' + contact.email + '</a></div>' : '')
    : '<div class="panel-field" style="color:var(--text-muted);">No contact linked</div>';

  var healthHTML = isHealth
    ? '<div class="panel-section"><div class="panel-label">Plan Details</div><div class="deal-field-grid">'
      + '<div class="deal-field"><div class="deal-field-label">Employees</div><div class="deal-field-value' + (deal.employees ? '' : ' empty') + '">' + (deal.employees || 'Not set') + '</div></div>'
      + '<div class="deal-field"><div class="deal-field-label">Renewal Date</div><div class="deal-field-value' + (deal.renewal_date ? '' : ' empty') + '">' + (fmtDate(deal.renewal_date) || 'Not set') + '</div></div>'
      + '<div class="deal-field"><div class="deal-field-label">Current Carrier</div><div class="deal-field-value' + (deal.current_carrier ? '' : ' empty') + '">' + (deal.current_carrier || 'Unknown') + '</div></div>'
      + '<div class="deal-field"><div class="deal-field-label">Quoted Premium</div><div class="deal-field-value' + (deal.quoted_premium ? '' : ' empty') + '">' + (deal.quoted_premium ? '$' + parseFloat(deal.quoted_premium).toLocaleString() + '/mo' : 'Not quoted') + '</div></div>'
      + '</div></div>'
    : '';

  var nextStepHTML = deal.next_step
    ? '<div style="margin-top:10px;"><div class="deal-field-label" style="margin-bottom:4px;">Next Step</div>'
      + '<div class="next-step-box">' + deal.next_step
      + (deal.next_step_date ? '<span style="color:var(--text-muted);font-size:12px;display:block;margin-top:3px;">Due ' + fmtDate(deal.next_step_date) + '</span>' : '')
      + '</div></div>'
    : '';

  var notesHTML = deal.notes
    ? '<div class="panel-section"><div class="panel-label">Notes</div><div class="panel-notes-box">' + deal.notes + '</div></div>'
    : '';

  var footerContact = contact
    ? '<button class="btn btn-outline btn-sm" onclick="closeDealPanel();viewContact(&#39;' + contact.id + '&#39;,&#39;&#39;)">&#128100; Contact</button>'
    : '';

  document.getElementById('deal-panel').innerHTML =
    '<div class="panel-header">'
    + '<div class="panel-header-info">'
    + '<div class="panel-avatar" style="font-size:18px;">&#129309;</div>'
    + '<div><div class="panel-name">' + deal.title + '</div>'
    + '<div style="margin-top:3px;"><span class="deal-panel-stage">' + pipeline.name + ' &rarr; ' + deal.stage + '</span></div></div>'
    + '</div>'
    + '<button class="panel-close-btn" onclick="closeDealPanel()">&#215;</button>'
    + '</div>'
    + '<div class="panel-body">'
    + '<div class="panel-section"><div class="panel-label">Linked Contact</div>' + contactHTML + '</div>'
    + '<div class="panel-section"><div class="panel-label">Deal Details</div>'
    + '<div class="deal-field-grid">'
    + '<div class="deal-field"><div class="deal-field-label">Deal Value</div><div class="deal-field-value' + (deal.value ? '' : ' empty') + '">' + (deal.value ? '$' + parseFloat(deal.value).toLocaleString() : 'Not set') + '</div></div>'
    + '<div class="deal-field"><div class="deal-field-label">Expected Close</div><div class="deal-field-value' + (deal.close_date ? '' : ' empty') + '">' + (fmtDate(deal.close_date) || 'Not set') + '</div></div>'
    + '</div>' + nextStepHTML + '</div>'
    + healthHTML
    + '<div class="panel-section" style="padding-top:0;">'
    + '<div class="panel-label">Quick Actions</div>'
    + '<div class="quick-action-grid">'
    + getStageActions(deal.pipeline, deal.stage).map(function(a){
        return '<button class="quick-action-btn" onclick="quickAddTask(&#39;' + dealId + '&#39;,&#39;' + a + '&#39;)">&#43; ' + a + '</button>';
      }).join('')
    + '</div></div>'
    + '<div class="panel-section">'
    + '<div class="panel-label">Tasks <span id="task-count-' + dealId + '" style="font-size:11px;color:var(--text-muted);"></span></div>'
    + '<div id="task-list-' + dealId + '">' + renderDealTaskList(dealId) + '</div>'
    + '<div class="task-add-row">'
    + '<input type="text" id="task-input-' + dealId + '" placeholder="Add a task..." onkeydown="if(event.key===&#39;Enter&#39;)addDealTaskFromInput(&#39;' + dealId + '&#39;)" />'
    + '<input type="date" id="task-date-' + dealId + '" />'
    + '<button class="btn btn-primary btn-sm" onclick="addDealTaskFromInput(&#39;' + dealId + '&#39;)">Add</button>'
    + '</div></div>'
    + '<div class="panel-section"><div class="panel-label">Activity Log</div>'
    + '<div class="activity-log-form">'
    + '<select id="act-type-' + dealId + '"><option value="note">&#128221; Note</option><option value="call">&#128222; Call</option><option value="email">&#9993; Email</option></select>'
    + '<textarea id="act-content-' + dealId + '" placeholder="Log a call outcome, note, or email summary..."></textarea>'
    + '<button class="btn btn-primary btn-sm" style="margin-top:6px;" onclick="saveDealActivity(&#39;' + dealId + '&#39;)">Log It</button>'
    + '</div>'
    + '<div class="activity-timeline" id="timeline-' + dealId + '">' + renderActivityTimeline(dealId) + '</div>'
    + '</div>'
    + notesHTML
    + '</div>'
    + '<div class="panel-footer">'
    + '<button class="btn btn-outline" onclick="closeDealPanel()">Close</button>'
    + footerContact
    + '<button class="btn btn-outline btn-sm" style="background:rgba(59,130,246,0.08);color:#60a5fa;border-color:rgba(59,130,246,0.3);" onclick="openDealEmailModal(&#39;' + dealId + '&#39;)">&#9993; Email</button>'
    + '<button class="btn btn-danger btn-sm" onclick="closeDealPanel();deleteDeal(&#39;' + dealId + '&#39;)">Delete</button>'
    + '<button class="btn btn-primary" onclick="closeDealPanel();editDeal(&#39;' + dealId + '&#39;)">&#9999;&#65039; Edit Deal</button>'
    + '</div>';

  document.getElementById('panel-overlay').style.display = 'block';
  document.getElementById('deal-panel').classList.add('open');
  document.body.style.overflow = 'hidden';
}

// ============================================================
// PIPELINES
// ============================================================
function renderPipelines() {
  const pipeline = PIPELINES[currentPipeline];
  const pipelineDeals = deals.filter(d => d.pipeline === currentPipeline);
  const tabs = Object.entries(PIPELINES).map(([key, p]) => `<button class="pipeline-tab ${key===currentPipeline?'active':''}" onclick="switchPipeline('${key}')">${p.name}</button>`).join('');
  const columns = pipeline.stages.map(stage => {
    const stageDeals = pipelineDeals.filter(d => d.stage === stage);
    const cards = stageDeals.map(deal => {
      const contact = contacts.find(c => c.id === deal.contact_id);
      const renewalFmt = deal.renewal_date ? new Date(deal.renewal_date + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : null;
      return `<div class="deal-card" draggable="true" ondragstart="dragStart(event,'${deal.id}')" id="deal-${deal.id}" onclick="openDealPanel('${deal.id}')" style="cursor:pointer;">
        <div class="deal-name">${deal.title}</div>
        <div class="deal-contact">&#128100; ${contact ? contact.name : 'No contact'}</div>
        ${deal.value ? `<div class="deal-value">$${parseFloat(deal.value).toLocaleString()}</div>` : ''}
        ${renewalFmt ? `<div style="font-size:11px;color:${(() => { var d=(new Date(deal.renewal_date+'T12:00:00')-new Date())/(1000*60*60*24); return d<=30?'#ef4444':d<=60?'#f97316':'#f59e0b'; })()};margin-top:5px;">&#128260; Renews ${renewalFmt}</div>` : ''}
        ${deal.next_step ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">&#10145; ${deal.next_step.substring(0,55)}${deal.next_step.length>55?'...':''}</div>` : ''}
        <div class="deal-actions" onclick="event.stopPropagation()">
          <button class="btn btn-outline btn-sm" onclick="editDeal('${deal.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDeal('${deal.id}')">&#10005;</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="kanban-col" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event,'${stage}')">
      <div class="kanban-col-header"><span>${stage}</span><span class="count">${stageDeals.length}</span></div>
      ${cards}
      <button class="add-deal-btn" onclick="openAddDeal('${stage}')">+ Add Deal</button>
    </div>`;
  }).join('');
  document.getElementById('page-pipelines').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 class="section-title" style="margin:0;">${pipeline.name}</h2>
      <button class="btn btn-accent" onclick="openAddDeal()">+ New Deal</button>
    </div>
    <div class="pipeline-tabs">${tabs}</div>
    <div class="kanban-board">${columns}</div>`;
}

function switchPipeline(key) { currentPipeline = key; renderPipelines(); }

function dragStart(e, dealId) { draggedDeal = dealId; setTimeout(() => document.getElementById('deal-'+dealId)?.classList.add('dragging'), 0); }
function dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function drop(e, stage) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (!draggedDeal) return;
  const deal = deals.find(d => d.id === draggedDeal);
  if (!deal || deal.stage === stage) { draggedDeal = null; return; }
  deal.stage = stage;
  await supabaseClient.from('deals').update({ stage }).eq('id', draggedDeal);
  draggedDeal = null; renderPipelines(); showToast('Deal moved to ' + stage);
}

// ── Contact search dropdown helpers ─────────────────────────────────────────
// Pipeline -> relevant contact types (primary = shown first + highlighted)
var CSD_TYPE_MAP = {
  'group-employer':    ['Group/Employer'],
  'individual-family': ['Individual/Family'],
  'agent-insured':     ['Agent - Insured America','Insured America Agent'],
  'agent-kannon':      ['Agent - Kannon Financial','Kannon Financial Agent','Recruit']
};

function buildContactSearch(selectedId, prefix, pipeline) {
  var relevantTypes = (pipeline && CSD_TYPE_MAP[pipeline]) ? CSD_TYPE_MAP[pipeline] : null;

  // Sort all contacts A-Z by name
  var sorted = contacts.slice().sort(function(a, b) {
    return (a.name || '').localeCompare(b.name || '');
  });

  // Split into primary (type matches pipeline) and secondary (everything else)
  var primary   = relevantTypes
    ? sorted.filter(function(c) { return relevantTypes.indexOf(c.type) !== -1; })
    : sorted;
  var secondary = relevantTypes
    ? sorted.filter(function(c) { return relevantTypes.indexOf(c.type) === -1; })
    : [];

  var sel      = selectedId ? contacts.find(function(c) { return c.id === selectedId; }) : null;
  var initVal  = sel ? (sel.name + (sel.company ? ' — ' + sel.company : '')) : '';

  function makeOpt(c) {
    var meta    = [c.company, c.type].filter(Boolean).join(' · ');
    var display = c.name + (c.company ? ' — ' + c.company : '');
    // strip chars that would break the inline event attribute
    var safeId  = (c.id  || '').replace(/['"]/g, '');
    var safeDsp = display.replace(/['"<>]/g, '');
    return '<div class="csd-opt" onmousedown="selectContactOpt(&#39;' + safeId + '&#39;,&#39;' + safeDsp + '&#39;,&#39;' + prefix + '&#39;)">'
      + '<div class="csd-name">' + c.name + '</div>'
      + (meta ? '<div class="csd-meta">' + meta + '</div>' : '')
      + '</div>';
  }

  var noContact = '<div class="csd-opt" onmousedown="selectContactOpt(&#39;&#39;,&#39;&#39;,&#39;' + prefix + '&#39;)">'
    + '<div class="csd-name" style="color:var(--text-muted);">— No contact —</div></div>';

  var listHTML = noContact + primary.map(makeOpt).join('');
  if (secondary.length) {
    listHTML += '<div style="padding:6px 12px;font-size:10px;font-weight:700;text-transform:uppercase;'
      + 'letter-spacing:0.8px;color:var(--text-muted);background:var(--surface-3);border-top:1px solid var(--border);">'
      + 'All contacts</div>'
      + secondary.map(makeOpt).join('');
  }

  return '<div class="csd-wrap">'
    + '<input type="text" class="csd-input" id="' + prefix + '-srch" value="' + initVal + '" '
    + 'placeholder="Type to search..." autocomplete="off" '
    + 'oninput="filterContactOpts(&#39;' + prefix + '&#39;)" '
    + 'onfocus="document.getElementById(&#39;' + prefix + '-list&#39;).style.display=&#39;block&#39;" '
    + 'onblur="setTimeout(function(){var l=document.getElementById(&#39;' + prefix + '-list&#39;);if(l)l.style.display=&#39;none&#39;},220)" />'
    + '<input type="hidden" id="' + prefix + '" value="' + (selectedId || '') + '" />'
    + '<div class="csd-list" id="' + prefix + '-list" onmousedown="event.preventDefault()">'
    + listHTML + '</div></div>';
}

function filterContactOpts(prefix) {
  var q    = (document.getElementById(prefix + '-srch').value || '').toLowerCase().trim();
  var list = document.getElementById(prefix + '-list');
  if (!list) return;
  list.style.display = 'block';
  Array.from(list.querySelectorAll('.csd-opt')).forEach(function(el) {
    el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  // Keep section headers visible only if any opts below them are visible
  var headers = Array.from(list.children).filter(function(el) {
    return !el.classList.contains('csd-opt');
  });
  headers.forEach(function(h) {
    var next = h.nextElementSibling;
    var anyVisible = false;
    while (next && next.classList.contains('csd-opt')) {
      if (next.style.display !== 'none') { anyVisible = true; break; }
      next = next.nextElementSibling;
    }
    h.style.display = anyVisible ? '' : 'none';
  });
}

function selectContactOpt(id, label, prefix) {
  var h = document.getElementById(prefix);       if (h) h.value = id;
  var s = document.getElementById(prefix+'-srch'); if (s) s.value = label;
  var l = document.getElementById(prefix+'-list'); if (l) l.style.display = 'none';
}


function openAddDeal(stage = '') {
  const pipeline = PIPELINES[currentPipeline];
  const stageOptions = pipeline.stages.map(s => `<option value="${s}" ${s===stage?'selected':''}>${s}</option>`).join('');
  showModal('Add New Deal', `
    <label>Deal / Opportunity Name *</label><input type="text" id="deal-title" placeholder="e.g. Acme Corp Benefits Package" />
    <label>Stage</label><select id="deal-stage">${stageOptions}</select>
    <label>Contact</label>${buildContactSearch('', 'deal-contact', currentPipeline)}
    <label>Deal Value ($)</label><input type="number" id="deal-value" placeholder="0" min="0" />
    <label>Expected Close Date</label><input type="date" id="deal-close-date" />
    <label>Next Step</label><input type="text" id="deal-next-step" placeholder="e.g. Send proposal, Schedule call..." />
    <label>Next Step Due Date</label><input type="date" id="deal-next-step-date" />
    <hr style="border-color:var(--border);margin:8px 0;">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);margin-bottom:8px;">Group Health Details</div>
    <label># of Employees</label><input type="number" id="deal-employees" placeholder="e.g. 25" min="1" />
    <label>Renewal Date</label><input type="date" id="deal-renewal-date" />
    <label>Current Carrier</label><input type="text" id="deal-carrier" placeholder="e.g. BlueCross, PacificSource..." />
    <label>Quoted Monthly Premium ($)</label><input type="number" id="deal-quoted" placeholder="0" min="0" />
    <label>Notes</label><textarea id="deal-notes" placeholder="Key details, next steps..."></textarea>
  `, async () => {
    const title = document.getElementById('deal-title').value.trim();
    if (!title) { showToast('Deal name is required'); return false; }
    const { data, error } = await supabaseClient.from('deals').insert({
      title, pipeline: currentPipeline,
      stage:          document.getElementById('deal-stage').value,
      contact_id:     document.getElementById('deal-contact').value || null,
      value:          parseFloat(document.getElementById('deal-value').value) || null,
      close_date:     document.getElementById('deal-close-date').value || null,
      next_step:      document.getElementById('deal-next-step').value.trim() || null,
      next_step_date: document.getElementById('deal-next-step-date').value || null,
      employees:      parseInt(document.getElementById('deal-employees').value) || null,
      renewal_date:   document.getElementById('deal-renewal-date').value || null,
      current_carrier:document.getElementById('deal-carrier').value.trim() || null,
      quoted_premium: parseFloat(document.getElementById('deal-quoted').value) || null,
      notes:          document.getElementById('deal-notes').value.trim() || null,
      user_id:  currentUser.id,
      agent_id: currentAgent.id
    }).select().single();
    if (error) { showToast('Error: ' + error.message); return false; }
    deals.unshift(data); showToast('Deal added!'); renderPipelines();
  });
}

function editDeal(id) {
  const deal = deals.find(d => d.id === id); if (!deal) return;
  const pipeline = PIPELINES[deal.pipeline];
  const stageOptions = pipeline.stages.map(s => `<option value="${s}" ${s===deal.stage?'selected':''}>${s}</option>`).join('');
  showModal('Edit Deal', `
    <label>Deal Name *</label><input type="text" id="deal-title" value="${deal.title}" />
    <label>Stage</label><select id="deal-stage">${stageOptions}</select>
    <label>Contact</label>${buildContactSearch(deal.contact_id || '', 'deal-contact', deal.pipeline)}
    <label>Deal Value ($)</label><input type="number" id="deal-value" value="${deal.value||''}" min="0" />
    <label>Expected Close Date</label><input type="date" id="deal-close-date" value="${deal.close_date||''}" />
    <label>Next Step</label><input type="text" id="deal-next-step" value="${deal.next_step||''}" placeholder="e.g. Send proposal, Schedule call..." />
    <label>Next Step Due Date</label><input type="date" id="deal-next-step-date" value="${deal.next_step_date||''}" />
    <hr style="border-color:var(--border);margin:8px 0;">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);margin-bottom:8px;">Group Health Details</div>
    <label># of Employees</label><input type="number" id="deal-employees" value="${deal.employees||''}" min="1" />
    <label>Renewal Date</label><input type="date" id="deal-renewal-date" value="${deal.renewal_date||''}" />
    <label>Current Carrier</label><input type="text" id="deal-carrier" value="${deal.current_carrier||''}" placeholder="e.g. BlueCross, PacificSource..." />
    <label>Quoted Monthly Premium ($)</label><input type="number" id="deal-quoted" value="${deal.quoted_premium||''}" min="0" />
    <label>Notes</label><textarea id="deal-notes">${deal.notes||''}</textarea>
  `, async () => {
    const title = document.getElementById('deal-title').value.trim();
    if (!title) { showToast('Deal name is required'); return false; }
    const updates = {
      title,
      stage:          document.getElementById('deal-stage').value,
      contact_id:     document.getElementById('deal-contact').value || null,
      value:          parseFloat(document.getElementById('deal-value').value) || null,
      close_date:     document.getElementById('deal-close-date').value || null,
      next_step:      document.getElementById('deal-next-step').value.trim() || null,
      next_step_date: document.getElementById('deal-next-step-date').value || null,
      employees:      parseInt(document.getElementById('deal-employees').value) || null,
      renewal_date:   document.getElementById('deal-renewal-date').value || null,
      current_carrier:document.getElementById('deal-carrier').value.trim() || null,
      quoted_premium: parseFloat(document.getElementById('deal-quoted').value) || null,
      notes:          document.getElementById('deal-notes').value.trim() || null
    };
    const { error } = await supabaseClient.from('deals').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }
    Object.assign(deal, updates); showToast('Deal updated!'); renderPipelines();
  });
}

async function deleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  await supabaseClient.from('deals').delete().eq('id', id);
  deals = deals.filter(d => d.id !== id); renderPipelines(); showToast('Deal deleted');
}

// ============================================================
// COMPLIANCE — bounced, opted-out, DNC contacts
// ============================================================
async function renderCompliance() {
  const pg = document.getElementById('page-compliance');
  pg.innerHTML = `<div style="color:var(--muted);font-size:14px;padding:40px;text-align:center;">Loading compliance data...</div>`;

  const { data: all } = await supabaseClient
    .from('contacts')
    .select('id,name,email,phone,type,email_status,opt_out_email,opt_out_at,opt_out_reason,do_not_call,email_bounced_at,sequence_status,agent_id')
    .or('email_status.neq.valid,opt_out_email.eq.true,do_not_call.eq.true')
    .order('created_at', { ascending: false });

  const list = all || [];
  const bounced   = list.filter(c => c.email_status === 'bounced');
  const optedOut  = list.filter(c => c.opt_out_email && c.email_status !== 'bounced');
  const dnc       = list.filter(c => c.do_not_call);

  function complianceRow(c, action) {
    const ownerAgent = allAgents.find(a => a.id === c.agent_id);
    return `<tr>
      <td style="font-weight:600;font-size:13px;">${c.name||'—'}</td>
      <td style="font-size:12px;">${c.email||'—'}</td>
      <td style="font-size:12px;">${c.phone||'—'}</td>
      <td style="font-size:12px;color:var(--muted);">${ownerAgent?ownerAgent.name:'—'}</td>
      <td style="white-space:nowrap;">${action}</td>
    </tr>`;
  }

  const bouncedRows = bounced.map(c => complianceRow(c,
    `<button class="btn btn-outline btn-sm" onclick="editContact('${c.id}')">✏ Fix Email</button>
     <button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deleteContact('${c.id}')">Delete</button>`
  )).join('');

  const optOutRows = optedOut.map(c => complianceRow(c,
    `<span style="font-size:11px;color:var(--muted);">${c.opt_out_reason||'Manual / reply'}</span>
     <button class="btn btn-outline btn-sm" style="margin-left:8px;" onclick="clearOptOut('${c.id}')">Restore</button>`
  )).join('');

  const dncRows = dnc.map(c => complianceRow(c,
    `<button class="btn btn-outline btn-sm" onclick="clearDnc('${c.id}')">Remove DNC</button>`
  )).join('');

  const tableHtml = (rows, emptyMsg) => rows
    ? `<table class="data-table" style="width:100%;"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Owner</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div style="color:var(--muted);font-size:13px;padding:16px 0;">${emptyMsg}</div>`;

  pg.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <h2 class="section-title" style="margin:0;">⚖ Compliance Center</h2>
      <div style="font-size:13px;color:var(--muted);">Bounced and opted-out contacts are automatically skipped by all sequences and drip campaigns.</div>
    </div>

    <div class="opens-stats" style="margin-bottom:28px;">
      <div class="opens-stat" style="border-left-color:#dc2626;"><div class="num" style="color:#dc2626;">${bounced.length}</div><div class="lbl">⚠ Bounced</div></div>
      <div class="opens-stat" style="border-left-color:#d97706;"><div class="num" style="color:#d97706;">${optedOut.length}</div><div class="lbl">⛔ Opted Out</div></div>
      <div class="opens-stat" style="border-left-color:#9d174d;"><div class="num" style="color:#9d174d;">${dnc.length}</div><div class="lbl">📵 Do Not Call</div></div>
      <div class="opens-stat"><div class="num">${list.length}</div><div class="lbl">Total Issues</div></div>
    </div>

    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#991b1b;line-height:1.6;">
      <strong>⚠ Bounced Emails (${bounced.length})</strong> — These addresses were rejected by the mail server. Fix the email or delete the contact.
    </div>
    ${tableHtml(bouncedRows, '✓ No bounced email addresses.')}

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin:24px 0 16px;font-size:13px;color:#92400e;line-height:1.6;">
      <strong>⛔ Opted Out (${optedOut.length})</strong> — These contacts replied asking to unsubscribe. Do not re-enroll without their explicit permission.
    </div>
    ${tableHtml(optOutRows, '✓ No opted-out contacts.')}

    <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:8px;padding:14px 18px;margin:24px 0 16px;font-size:13px;color:#6b21a8;line-height:1.6;">
      <strong>📵 Do Not Call (${dnc.length})</strong> — These contacts are flagged for no phone outreach.
    </div>
    ${tableHtml(dncRows, '✓ No Do Not Call contacts.')}
  `;
}

async function clearOptOut(id) {
  if (!confirm('Remove opt-out and restore email outreach for this contact?')) return;
  const { error } = await supabaseClient.from('contacts').update({
    opt_out_email: false, email_status: 'valid', opt_out_at: null, opt_out_reason: null
  }).eq('id', id);
  if (error) { showToast('Error: ' + error.message); return; }
  showToast('✓ Opt-out cleared');
  await loadData();
  renderCompliance();
}

async function clearDnc(id) {
  if (!confirm('Remove Do Not Call flag for this contact?')) return;
  const { error } = await supabaseClient.from('contacts').update({ do_not_call: false }).eq('id', id);
  if (error) { showToast('Error: ' + error.message); return; }
  showToast('✓ DNC flag removed');
  await loadData();
  renderCompliance();
}

// ============================================================
// CONTACTS
// ============================================================
async function cleanupContacts() {
  showToast('Scanning for unreachable contacts...');
  const { data: raw, error } = await supabaseClient
    .from('contacts')
    .select('id,name,email,phone,email_status,linkedin_url,facebook_url,instagram_handle,twitter_handle,whatsapp_number,tiktok_handle,telegram_handle')
    .eq('agent_id', currentAgent.id)
    .or('email.is.null,email_status.in.(bounced,invalid,bad-domain,bad-syntax)');
  if (error) { showToast('Error: ' + error.message); return; }
  const dead = (raw || []).filter(function(c) {
    const hasPhone  = c.phone && c.phone.trim();
    const hasSocial = c.linkedin_url || c.facebook_url || c.instagram_handle ||
                      c.twitter_handle || c.whatsapp_number || c.tiktok_handle || c.telegram_handle;
    return !hasPhone && !hasSocial;
  });
  if (!dead.length) { showToast('No unreachable contacts - list is clean!'); return; }
  window._cleanupSelectAll = function(checked) {
    document.querySelectorAll('.cleanup-chk').forEach(function(el) { el.checked = checked; });
  };
  var rows = dead.map(function(c) {
    var reasons = [];
    if (!c.email)                             reasons.push('no email');
    else if (c.email_status === 'bounced')    reasons.push('bounced email');
    else if (c.email_status === 'invalid')    reasons.push('invalid email');
    else if (c.email_status === 'bad-domain') reasons.push('bad domain');
    else if (c.email_status === 'bad-syntax') reasons.push('bad syntax');
    reasons.push('no phone');
    reasons.push('no social');
    var rStr = reasons.join(' - ');
    var nm = (c.name || '(no name)').replace(/"/g, '&quot;');
    return '<label style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:0.5px solid var(--border);cursor:pointer;">'
      + '<input type="checkbox" class="cleanup-chk" data-id="' + c.id + '" checked style="width:16px;height:16px;margin-top:2px;flex-shrink:0;accent-color:#dc2626;" />'
      + '<span style="line-height:1.4;"><strong style="font-size:13px;color:var(--text-primary);">' + nm + '</strong>'
      + '<span style="font-size:11px;color:var(--text-muted);display:block;">' + rStr + '</span></span></label>';
  }).join('');
  showModal('Contacts Cleanup',
    '<div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Found <strong style="color:var(--text-primary);">'
    + dead.length + ' unreachable contact' + (dead.length !== 1 ? 's' : '')
    + '</strong> with no email, phone, or social. Uncheck any to keep.</div>'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);margin-bottom:10px;cursor:pointer;">'
    + '<input type="checkbox" id="cleanup-select-all" checked onchange="window._cleanupSelectAll(this.checked);" style="width:14px;height:14px;" /> Select / Deselect All</label>'
    + '<div style="max-height:320px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;padding:0 10px;">'
    + rows + '</div>',
    async function() {
      var toDelete = Array.from(document.querySelectorAll('.cleanup-chk:checked')).map(function(el) { return el.dataset.id; });
      if (!toDelete.length) { showToast('Nothing selected.'); return false; }
      var res = await supabaseClient.from('contacts').delete().in('id', toDelete);
      if (res.error) { showToast('Error: ' + res.error.message); return false; }
      showToast('Deleted ' + toDelete.length + ' contact' + (toDelete.length !== 1 ? 's' : '') + '.');
      renderContacts();
    }
  );
}

async function renderContacts() {
  const pg = document.getElementById('page-contacts');
  const PAGE_SIZE = 100;
  const typeClass  = { 'Group/Employer': 'badge-group', 'Individual/Family': 'badge-individual' };
  const seqClass   = { 'Active': 'badge-active', 'Replied': 'badge-replied', 'Completed': 'badge-completed', 'Drip': 'badge-group', 'Not Started': 'badge-agent' };
  const showOwnerCol = currentAgent.role !== 'agent';

  const typeFilterBtns = ['', ...CONTACT_TYPES].map(t =>
    `<button class="pipeline-tab ${contactTypeFilter === t ? 'active' : ''}" onclick="contactTypeFilter='${t}';contactPage=0;renderContacts();">${t || 'All Types'}</button>`
  ).join('');

  const statusFilterBtns = [
    { val: 'active',           label: '✓ Active',           title: 'Reachable contacts only — hides opted-out and stopped' },
    { val: 'needs_attention',  label: '⚠ Needs Attention',  title: 'Opted-out, bounced, stopped — contacts you cannot currently reach' },
    { val: 'all',              label: 'All',                 title: 'Show every contact regardless of status' },
  ].map(s =>
    `<button class="pipeline-tab ${contactStatusFilter === s.val ? 'active' : ''}" title="${s.title}"
      onclick="contactStatusFilter='${s.val}';contactPage=0;renderContacts();">${s.label}</button>`
  ).join('');

  // Render shell immediately so tabs show while DB query runs
  const _searchFocused = document.activeElement && document.activeElement.id === 'contact-search-input';
  pg.innerHTML = `
    ${opensFilter.length ? `<div style="display:flex;align-items:center;gap:10px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:8px;padding:8px 12px;margin-bottom:10px;">
      <i class="ti ti-mail-opened" style="color:#38bdf8;font-size:16px;"></i>
      <span style="font-size:13px;color:var(--text-primary);flex:1;">Showing <strong>${opensFilter.length}</strong> ${_quickFilterLabel || 'filtered contacts'}</span>
      <button class="btn btn-outline btn-sm" onclick="opensFilter=[];_quickFilterLabel='';renderContacts();">&#10005; Clear filter</button>
    </div>` : ''}
    <div class="contacts-toolbar">
      <input id="contact-search-input" type="text" placeholder="&#128269; Search contacts..." value="${contactSearch}"
             oninput="contactSearch=this.value;contactPage=0;renderContacts();" style="max-width:280px;" />
      <select onchange="contactSort=this.value;contactPage=0;renderContacts();"
              style="padding:7px 10px;border:0.5px solid var(--border);border-radius:6px;font-size:13px;color:var(--text-primary);background:var(--surface-2);cursor:pointer;">
        <option value="created_at_desc" ${contactSort==='created_at_desc'?'selected':''}>&#128197; Newest First</option>
        <option value="created_at_asc"  ${contactSort==='created_at_asc'?'selected':''}>&#128197; Oldest First</option>
        <option value="name_asc"        ${contactSort==='name_asc'?'selected':''}>A&#8594;Z Name</option>
        <option value="name_desc"       ${contactSort==='name_desc'?'selected':''}>Z&#8594;A Name</option>
        <option value="company_asc"     ${contactSort==='company_asc'?'selected':''}>A&#8594;Z Company</option>
        <option value="sequence_status_asc" ${contactSort==='sequence_status_asc'?'selected':''}>Sequence Status</option>
      </select>
      <button class="btn btn-accent" onclick="openAddContact()">+ Add Contact</button>
      <button class="btn btn-outline" onclick="verifyAllEmails()" style="font-size:13px;" title="SMTP-verify unverified emails">&#128269; Verify All Emails</button>
      <button class="btn btn-outline" onclick="cleanupContacts()" style="font-size:13px;color:#dc2626;border-color:#dc2626;" title="Find and delete unreachable contacts">&#129529; Clean Up</button>
      <span style="font-size:13px;color:var(--muted);margin-left:auto;" id="contacts-count">Loading...</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;">Status:</span>
      <div class="pipeline-tabs" style="margin-bottom:0;">${statusFilterBtns}</div>
    </div>
    <div class="pipeline-tabs" style="margin-bottom:16px;">${typeFilterBtns}</div>
    <div class="contacts-table" id="contacts-table-body">
      <div style="color:var(--muted);font-size:14px;padding:40px;text-align:center;">Loading...</div>
    </div>`;

  // Restore search focus if user was typing
  if (_searchFocused) {
    const _el = document.getElementById('contact-search-input');
    if (_el) { _el.focus(); const _l = _el.value.length; _el.setSelectionRange(_l, _l); }
  }

  // Sort options
  const sortMap = {
    'created_at_desc':     { col: 'created_at',     asc: false },
    'created_at_asc':      { col: 'created_at',     asc: true  },
    'name_asc':            { col: 'name',            asc: true  },
    'name_desc':           { col: 'name',            asc: false },
    'company_asc':         { col: 'company',         asc: true  },
    'sequence_status_asc': { col: 'sequence_status', asc: true  }
  };
  const sortOpt = sortMap[contactSort] || sortMap['created_at_desc'];

  // Query Supabase directly — bypasses PostgREST row cap entirely
  let q = supabaseClient.from('contacts').select('*');
  if (currentAgent.role === 'agent') q = q.eq('agent_id', currentAgent.id);
  else if (currentAgent.role === 'agency_owner') {
    // Match loadData: query by agent_id IN [...] to catch contacts without agency_id set
    const agencyIds = [...new Set([currentAgent.id, ...allAgents.filter(a => a.agency_id === currentAgent.agency_id).map(a => a.id)])];
    q = q.in('agent_id', agencyIds);
  }
  if (contactTypeFilter) q = q.eq('type', contactTypeFilter);
  // Status filter — skip when a quick filter (opensFilter) is active
  if (!opensFilter.length) {
    if (contactStatusFilter === 'active') {
      // Hide opted-out, stopped (bounced), and blocked contacts from default view
      q = q.not('opt_out_email', 'eq', true)
           .not('sequence_status', 'eq', 'stopped')
           .not('sequence_status', 'eq', 'Opted Out');
    } else if (contactStatusFilter === 'needs_attention') {
      // Show only contacts that need attention (opted-out, stopped/bounced)
      q = q.or('opt_out_email.eq.true,sequence_status.eq.stopped');
    }
    // 'all' — no filter applied
  }
  if (contactSearch) q = q.or(`name.ilike.%${contactSearch}%,email.ilike.%${contactSearch}%,company.ilike.%${contactSearch}%`);
  if (opensFilter.length) q = q.in('email', opensFilter);
  const offset = (contactPage || 0) * PAGE_SIZE;
  q = q.order(sortOpt.col, { ascending: sortOpt.asc }).range(offset, offset + PAGE_SIZE - 1);

  const { data: shown, error } = await q;
  if (error) {
    document.getElementById('contacts-table-body').innerHTML =
      `<div class="empty-state"><div class="emoji">&#9888;&#65039;</div><p>Error loading contacts: ${error.message}</p></div>`;
    return;
  }

  // Merge fetched rows into in-memory contacts so viewContact() / editContact() still work
  const fetchedIds = new Set((shown || []).map(c => c.id));
  contacts = [...(shown || []), ...contacts.filter(c => !fetchedIds.has(c.id))];

  const rows = (shown || []).map(c => {
    const initials   = (c.name || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const badgeClass = typeClass[c.type] || 'badge-agent';
    const seqStatus  = c.sequence_status || 'Not Started';
    const ownerAgent = showOwnerCol ? allAgents.find(a => a.id === c.agent_id) : null;
    const emailBadge = (c.email_status === 'bounced' || c.email_status === 'invalid' || c.email_status === 'bad-domain' || c.email_status === 'bad-syntax')
      ? `<span title="${(c.email_verify_reason||'Bad email').replace(/"/g,'&quot;')}" style="margin-left:5px;background:#fee2e2;color:#dc2626;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">&#9888; INVALID</span>`
      : (c.email_status === 'opted_out' || c.opt_out_email)
      ? `<span title="Opted out of emails" style="margin-left:5px;background:#fef9c3;color:#854d0e;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">&#128683; OPT-OUT</span>`
      : c.email_status === 'valid'
      ? `<span title="Email verified" style="margin-left:5px;background:#dcfce7;color:#16a34a;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">&#10003; VALID</span>`
      : c.email_status === 'catch-all'
      ? `<span title="Catch-all domain" style="margin-left:5px;background:#fef9c3;color:#854d0e;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">~ CATCH-ALL</span>`
      : c.email_status === 'risky'
      ? `<span title="${(c.email_verify_reason||'Unverified').replace(/"/g,'&quot;')}" style="margin-left:5px;background:#f3f4f6;color:#6b7280;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">? RISKY</span>`
      : c.email_status === 'pending'
      ? `<span title="Verifying..." style="margin-left:5px;background:#eff6ff;color:#2563eb;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">... CHECKING</span>`
      : ''
    const dncBadge = c.do_not_call
      ? `<span title="Do Not Call" style="margin-left:4px;background:#fce7f3;color:#9d174d;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">&#128245; DNC</span>`
      : '';
    return `<tr${c.email_status === 'bounced' ? ' style="opacity:0.7;"' : ''}>
      <td style="cursor:pointer;" onclick="viewContact('${c.id}','')">
        <div style="display:flex;align-items:center;">
          <span class="contact-avatar">${initials}</span>
          <span style="font-weight:600;">${c.name || '—'}</span>
        </div>
      </td>
      <td style="font-size:13px;">${c.phone || '—'}</td>
      <td style="font-size:13px;">${c.email || '—'}${emailBadge}</td>
      <td style="font-size:13px;">${c.company || '—'}${dncBadge}</td>
      ${!contactTypeFilter ? `<td>${c.type ? `<span class="badge ${badgeClass}">${c.type}</span>` : '—'}</td>` : ''}
      <td><span class="badge ${seqClass[seqStatus] || 'badge-agent'}">${seqStatus}</span></td>
      ${showOwnerCol ? `<td style="font-size:12px;color:var(--muted);">${ownerAgent ? ownerAgent.name : '—'}</td>` : ''}
      <td>
        <button class="btn btn-outline btn-sm" onclick="viewContact('${c.id}','')">View</button>
        <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="editContact('${c.id}')">Edit</button>
        ${c.email ? `<button class="btn btn-outline btn-sm" style="margin-left:4px;font-size:11px;" onclick="verifyContactEmail('${c.id}')" title="Verify email">&#128269; Verify</button>` : ''}
        <button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deleteContact('${c.id}')">&#10005;</button>
      </td>
    </tr>`;
  }).join('');

  const hasNext = (shown || []).length === PAGE_SIZE;
  const hasPrev = (contactPage || 0) > 0;
  const pageNav = (hasNext || hasPrev) ? `
    <div style="display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--border);">
      ${hasPrev ? `<button class="btn btn-outline btn-sm" onclick="contactPage--;renderContacts();">&#8592; Prev 100</button>` : ''}
      <span style="font-size:13px;color:var(--muted);">Page ${(contactPage || 0) + 1}</span>
      ${hasNext ? `<button class="btn btn-outline btn-sm" onclick="contactPage++;renderContacts();">Next 100 &#8594;</button>` : ''}
    </div>` : '';

  const shown_count = (shown || []).length;
  const countLabel = hasNext
    ? `Showing ${offset + 1}–${offset + shown_count}  |  more on next page`
    : `${offset + shown_count} contact${offset + shown_count !== 1 ? 's' : ''}${(contactPage || 0) > 0 ? ` (page ${(contactPage || 0) + 1})` : ''}`;

  document.getElementById('contacts-count').textContent = countLabel;
  document.getElementById('contacts-table-body').innerHTML = shown_count === 0
    ? `<div class="empty-state"><div class="emoji">&#128101;</div><p>${contactSearch || contactTypeFilter ? 'No contacts match your filter.' : 'No contacts yet. Add your first one!'}</p></div>`
    : `${pageNav}<table><thead><tr>
        <th>Name</th><th>Phone</th><th>Email</th><th>Company</th>${!contactTypeFilter ? '<th>Type</th>' : ''}<th>Sequence</th>
        ${showOwnerCol ? '<th>Owner</th>' : ''}<th>Actions</th>
      </tr></thead><tbody>${rows}</tbody></table>${pageNav}`;
}

function openAddContact() {
  const typeOptions = CONTACT_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  // Agent picker for agency_owner and system_owner
  const canAssign = currentAgent.role !== 'agent';
  const agentOptions = canAssign
    ? allAgents.map(a => `<option value="${a.id}" ${a.id===currentAgent.id?'selected':''}>${a.name} — ${a.agencies?.name||'No agency'}</option>`).join('')
    : '';

  showModal('Add Contact', `
    <label>Full Name *</label><input type="text" id="con-name" placeholder="Jane Smith" />
    <label>Email</label><input type="email" id="con-email" placeholder="jane@company.com" />
    <label>Phone</label><input type="tel" id="con-phone" placeholder="(555) 555-5555" />
    <label>Company / Employer</label><input type="text" id="con-company" placeholder="Acme Corp" />
    <label>Type</label><select id="con-type"><option value="">— Select type —</option>${typeOptions}</select>
    ${canAssign ? `<label>Assign To</label><select id="con-agent">${agentOptions}</select>` : ''}
    <label>Notes</label><textarea id="con-notes" placeholder="Any relevant notes..."></textarea>
    <div style="border-top:1px solid #e2e8f0;margin-top:12px;padding-top:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;">Social Media <span style="font-weight:400;font-size:11px;opacity:0.7;">(optional)</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><label style="font-size:12px;">&#128279; LinkedIn</label><input type="text" id="new-linkedin" placeholder="linkedin.com/in/username" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128101; Facebook</label><input type="text" id="new-facebook" placeholder="facebook.com/username" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128247; Instagram</label><input type="text" id="new-instagram" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">X / Twitter</label><input type="text" id="new-twitter" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128172; WhatsApp</label><input type="tel" id="new-whatsapp" placeholder="+1 406 555 0000" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#127925; TikTok</label><input type="text" id="new-tiktok" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#9992; Telegram</label><input type="text" id="new-telegram" placeholder="@username" style="width:100%;box-sizing:border-box;" /></div>
      </div>
    </div>
    <div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:12px;display:flex;justify-content:flex-end;">
      <button type="button" onclick="window._addContactStartIntake=true;handleModalSave();" style="background:#0f4c8a;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;">&#129309; Save &amp; Start Intake</button>
    </div>
  `, async () => {
    const name = document.getElementById('con-name').value.trim();
    if (!name) { showToast('Name is required'); return false; }
    const assignedAgentId = canAssign ? (document.getElementById('con-agent').value || currentAgent.id) : currentAgent.id;
    const assignedAgent = allAgents.find(a => a.id === assignedAgentId) || currentAgent;

    const { data, error } = await supabaseClient.from('contacts').insert({
      name,
      email: document.getElementById('con-email').value.trim() || null,
      phone: document.getElementById('con-phone').value.trim() || null,
      company: document.getElementById('con-company').value.trim() || null,
      type: document.getElementById('con-type').value || null,
      notes: document.getElementById('con-notes').value.trim() || null,
      linkedin_url: document.getElementById('new-linkedin').value.trim() || null,
      facebook_url: document.getElementById('new-facebook').value.trim() || null,
      instagram_handle: (document.getElementById('new-instagram').value.trim().replace(/^@/, '') || null),
      twitter_handle: (document.getElementById('new-twitter').value.trim().replace(/^@/, '') || null),
      whatsapp_number: document.getElementById('new-whatsapp').value.trim() || null,
      tiktok_handle: (document.getElementById('new-tiktok').value.trim().replace(/^@/, '') || null),
      telegram_handle: (document.getElementById('new-telegram').value.trim().replace(/^@/, '') || null),
      user_id: currentUser.id,
      agent_id: assignedAgentId,
      agency_id: assignedAgent.agency_id || null
    }).select().single();
    if (error) { showToast('Error: ' + error.message); return false; }

    // Insert contact_companies based on assigned agent's companies
    const { data: ac } = await supabaseClient.from('agent_companies').select('company_id').eq('agent_id', assignedAgentId);
    if (ac && ac.length > 0) {
      await supabaseClient.from('contact_companies').insert(ac.map(r => ({ contact_id: data.id, company_id: r.company_id })));
    }

    contacts.unshift(data); showToast('Contact added!'); renderContacts();
    if (window._addContactStartIntake) {
      window._addContactStartIntake = false;
      setTimeout(() => showIntakeForm(data.id), 300);
    }
  });
}

function editContact(id, onSave) {
  const c = contacts.find(x => x.id === id); if (!c) return;
  const typeOptions = CONTACT_TYPES.map(t => `<option value="${t}" ${t===c.type?'selected':''}>${t}</option>`).join('');
  const canAssign = currentAgent.role !== 'agent';
  const agentOptions = canAssign
    ? allAgents.map(a => `<option value="${a.id}" ${a.id===c.agent_id?'selected':''}>${a.name} — ${a.agencies?.name||'No agency'}</option>`).join('')
    : '';
  const trackOptions = [['standard','Standard'],['state-farm','State Farm Agent']].map(([v,l]) => `<option value="${v}" ${(c.sequence_track||'standard')===v?'selected':''}>${l}</option>`).join('');
  const SEQ_STATUSES = ['Not Started','Active','Drip','Replied','Interested','Not Interested','Closed'];
  const seqOptions = SEQ_STATUSES.map(s => `<option value="${s}" ${(c.sequence_status||'Not Started')===s?'selected':''}>${s}</option>`).join('');
  const _verifiedAt = c.email_verified_at ? ` (verified ${new Date(c.email_verified_at).toLocaleDateString()})` : '';
  const _markBtn = `<button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;margin-left:6px;font-size:11px;color:#16a34a;border-color:#16a34a;" onclick="markEmailVerified('${c.id}')">&#10003; Mark as Verified</button>`;
  const emailStatusNote = (c.email_status === 'bounced' || c.email_status === 'invalid' || c.email_status === 'bad-domain' || c.email_status === 'bad-syntax')
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#dc2626;">&#9888; <strong>Invalid Email</strong>${_verifiedAt} &#8212; ${c.email_verify_reason||'rejected'}. Correct it below, or mark valid if you know it works.<br><button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Re-verify</button>${_markBtn}</div>`
    : c.email_status === 'opted_out'
    ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#854d0e;">&#128683; <strong>Opted Out</strong> &#8212; uncheck below to restore.</div>`
    : c.email_status === 'valid'
    ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#16a34a;">&#10003; <strong>Email Verified</strong>${_verifiedAt}${c.email_verify_reason === 'Manually verified by agent' ? ' <em style="font-size:10px;opacity:0.8;">(manual)</em>' : ''}</div>`
    : c.email_status === 'risky'
    ? `<div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#6b7280;">? <strong>Risky / Unconfirmed</strong>${_verifiedAt}${c.email_verify_reason ? ' &#8212; '+c.email_verify_reason : ''}.<br><small style="display:block;margin-top:4px;color:#9ca3af;">Common for Microsoft, Google, State Farm &#8212; SMTP probing is blocked. If you know this email works, mark it verified.</small><br><button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Re-verify</button>${_markBtn}</div>`
    : c.email_status === 'catch-all'
    ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#854d0e;">~ <strong>Catch-All Domain</strong>${_verifiedAt} &#8212; mailbox unconfirmed. If you know this person's inbox is real, mark it verified.<br>${_markBtn}</div>`
    : c.email_status === 'pending'
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#2563eb;">... <strong>Verifying...</strong> Refresh in a moment, or mark verified if you know it's good.<br>${_markBtn}</div>`
    : c.email && !c.email_status
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#dc2626;"><strong>&#9888; Not verified &#8212; will NOT receive emails until verified.</strong><br><button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Verify via SMTP</button>${_markBtn}</div>`
    : ''
  showModal('Edit Contact', `
    ${emailStatusNote}
    <label>Full Name *</label><input type="text" id="con-name" value="${c.name||''}" />
    <label>Email</label><input type="email" id="con-email" value="${c.email||''}" />
    <label>Phone</label><input type="tel" id="con-phone" value="${c.phone||''}" />
    <label>Company</label><input type="text" id="con-company" value="${c.company||''}" />
    <label>City</label><input type="text" id="con-city" value="${c.city||''}" placeholder="e.g. Bozeman" />
    <label>State</label><input type="text" id="con-state" value="${c.state||''}" placeholder="e.g. MT" maxlength="2" style="width:80px;" />
    <label>Type</label><select id="con-type"><option value="">— Select type —</option>${typeOptions}</select>
    <label>Outreach Track <span style="font-size:11px;color:var(--muted);">(Recruit contacts only)</span></label><select id="con-track">${trackOptions}</select>
    ${canAssign ? `<label>Assign To</label><select id="con-agent">${agentOptions}</select>` : ''}
    <label>Notes</label><textarea id="con-notes">${c.notes||''}</textarea>
    <div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:14px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;">Social Media</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><label style="font-size:12px;">&#128279; LinkedIn</label><input type="text" id="con-linkedin" value="${c.linkedin_url||''}" placeholder="linkedin.com/in/username" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128101; Facebook</label><input type="text" id="con-facebook" value="${c.facebook_url||''}" placeholder="facebook.com/username" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128247; Instagram</label><input type="text" id="con-instagram" value="${c.instagram_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">X / Twitter</label><input type="text" id="con-twitter" value="${c.twitter_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#128172; WhatsApp</label><input type="tel" id="con-whatsapp" value="${c.whatsapp_number||''}" placeholder="+1 406 555 0000" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#127925; TikTok</label><input type="text" id="con-tiktok" value="${c.tiktok_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" /></div>
        <div><label style="font-size:12px;">&#9992; Telegram</label><input type="text" id="con-telegram" value="${c.telegram_handle||''}" placeholder="@username" style="width:100%;box-sizing:border-box;" /></div>
      </div>
    </div>
    <label>Status <span style="font-size:11px;color:var(--muted);">(sequence stage)</span></label>
    <select id="con-seqstatus">${seqOptions}</select>
    <div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:14px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;">Compliance</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="con-optout" ${c.opt_out_email?'checked':''} style="width:16px;height:16px;">
        <span>⛔ Opted Out of Emails</span>
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:8px;">
        <input type="checkbox" id="con-dnc" ${c.do_not_call?'checked':''} style="width:16px;height:16px;">
        <span>📵 Do Not Call</span>
      </label>
    </div>
    <div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">Intake History</div>
        <button type="button" onclick="closeModal();setTimeout(()=>showIntakeForm('${id}'),150);" style="background:#0f4c8a;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;">&#129309; New Intake</button>
      </div>
      <div id="intake-history-panel"><em style="color:#94a3b8;font-size:12px;">Loading...</em></div>
    </div>
  `, async () => {
    const name = document.getElementById('con-name').value.trim();
    if (!name) { showToast('Name is required'); return false; }
    const assignedAgentId = canAssign ? (document.getElementById('con-agent').value || c.agent_id) : c.agent_id;
    const assignedAgent = allAgents.find(a => a.id === assignedAgentId) || currentAgent;
    const newOptOut    = document.getElementById('con-optout').checked;
    const newDnc       = document.getElementById('con-dnc').checked;
    const newSeqStatus = document.getElementById('con-seqstatus').value || 'Not Started';
    const newEmail   = document.getElementById('con-email').value.trim() || null;
    // If email was bounced and a new email was entered, clear the bounce status
    // When email changes, clear status so trigger re-verifies it
    const newEmailStatus = (c.email_status === 'bounced' && newEmail && newEmail !== c.email) ? null
      : newOptOut ? 'opted_out'
      : (c.email_status === 'opted_out' && !newOptOut) ? null
      : c.email_status || null;
    const updates = { name, email: newEmail, phone: document.getElementById('con-phone').value.trim()||null, company: document.getElementById('con-company').value.trim()||null, city: document.getElementById('con-city').value.trim()||null, state: (document.getElementById('con-state').value.trim().toUpperCase())||null, type: document.getElementById('con-type').value||null, sequence_track: document.getElementById('con-track').value||'standard', sequence_status: newSeqStatus, notes: document.getElementById('con-notes').value.trim()||null, agent_id: assignedAgentId, agency_id: assignedAgent.agency_id||null, opt_out_email: newOptOut, do_not_call: newDnc, email_status: newEmailStatus, linkedin_url: document.getElementById('con-linkedin').value.trim()||null, facebook_url: document.getElementById('con-facebook').value.trim()||null, instagram_handle: (document.getElementById('con-instagram').value.trim().replace(/^@/,'')||null), twitter_handle: (document.getElementById('con-twitter').value.trim().replace(/^@/,'')||null), whatsapp_number: document.getElementById('con-whatsapp').value.trim()||null, tiktok_handle: (document.getElementById('con-tiktok').value.trim().replace(/^@/,'')||null), telegram_handle: (document.getElementById('con-telegram').value.trim().replace(/^@/,'')||null) };
    const { error } = await supabaseClient.from('contacts').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }

    // Update contact_companies if agent changed
    if (assignedAgentId !== c.agent_id) {
      await supabaseClient.from('contact_companies').delete().eq('contact_id', id);
      const { data: ac } = await supabaseClient.from('agent_companies').select('company_id').eq('agent_id', assignedAgentId);
      if (ac && ac.length > 0) await supabaseClient.from('contact_companies').insert(ac.map(r => ({ contact_id: id, company_id: r.company_id })));
    }

    Object.assign(c, updates); showToast('Contact updated!'); if (typeof onSave === 'function') { onSave(); } else { renderContacts(); closeContactPanel(); }
  });
  loadIntakeHistoryPanel(id);
}

async function loadIntakeHistoryPanel(contactId) {
  const panel = document.getElementById('intake-history-panel');
  if (!panel) return;
  const { data: sessions, error } = await supabaseClient
    .from('intake_sessions')
    .select('id,form_type,status,created_at,completed_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false });
  if (error || !sessions || sessions.length === 0) {
    panel.innerHTML = '<em style="color:#94a3b8;font-size:12px;">No intake sessions yet. Click New Intake to start one.</em>';
    return;
  }
  const LABELS = {
    health_individual: 'Individual Health',
    health_family:     'Family Health',
    health_group:      'Group / Employer Health',
    career_new:        'New Career',
    career_existing:   'Existing Agent',
    life_individual:   'Life Insurance'
  };
  panel.innerHTML = sessions.map(s => {
    const badge = s.status === 'completed'
      ? 'background:#dcfce7;color:#16a34a;border:1px solid #86efac;'
      : 'background:#fef9c3;color:#854d0e;border:1px solid #fde047;';
    const dt = new Date(s.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f1f5f9;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--text);">${LABELS[s.form_type]||s.form_type}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:1px;">${dt}</div>
      </div>
      <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;${badge}">${s.status.toUpperCase()}</span>
    </div>`;
  }).join('');
}

async function deleteContact(id) {
  if (!confirm('Delete this contact and all their associated data (deals, email opens)?')) return;
  const contact = contacts.find(c => c.id === id);
  await Promise.all([
    supabaseClient.from('contact_companies').delete().eq('contact_id', id),
    supabaseClient.from('deals').delete().eq('contact_id', id),
    contact?.email ? supabaseClient.from('email_opens').delete().eq('contact_email', contact.email) : Promise.resolve()
  ]);
  await supabaseClient.from('contacts').delete().eq('id', id);
  contacts = contacts.filter(c => c.id !== id); renderContacts(); showToast('Contact deleted');
}
// ── Email Verification ────────────────────────────────────────────────────────

async function verifyContactEmail(id) {
  const contact = contacts.find(x => x.id === id);
  if (!contact || !contact.email) { showToast('No email on this contact'); return; }
  contact.email_status = 'pending';
  renderContacts();
  showToast('Verifying ' + contact.email + '...');
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ email: contact.email, contact_id: id })
    });
    const data = await res.json();
    if (data.status) {
      contact.email_status = data.status;
      contact.email_verify_reason = data.reason || '';
      contact.email_verified_at = new Date().toISOString();
      showToast(contact.email + ' is ' + data.status.toUpperCase());
    } else { showToast('Verify error: ' + (data.error || 'unknown')); }
  } catch (e) { showToast('Verify failed: ' + e.message); }
  renderContacts();
}

async function markEmailVerified(id) {
  const contact = contacts.find(x => x.id === id);
  if (!contact) return;
  const msg = 'Mark "' + (contact.email || 'this email') + '" as Verified?\n\nUse this when you know the address is good (e.g. you received email from them, or SMTP probing was blocked by their server).\n\nThis email will now be included in sequences and sends.';
  if (!confirm(msg)) return;
  try {
    const { error } = await supabaseClient.from('contacts').update({
      email_status: 'valid',
      email_verify_reason: 'Manually verified by agent',
      email_verified_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
    contact.email_status = 'valid';
    contact.email_verify_reason = 'Manually verified by agent';
    contact.email_verified_at = new Date().toISOString();
    showToast(contact.email + ' marked as Verified');
    renderContacts();
    if (document.querySelector('.modal-overlay')) editContact(id);
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function verifyAllEmails() {
  const targets = contacts.filter(c => c.email && !c.email_status);
  if (targets.length === 0) { showToast('No unverified emails to check'); return; }

  const skipped = contacts.filter(x => x.email && x.email_status).length;
  const msg = 'Verify ' + targets.length + ' unverified email' + (targets.length > 1 ? 's' : '') + '?\n\n'
    + (skipped > 0 ? skipped + ' contact' + (skipped > 1 ? 's' : '') + ' already have a status (Valid, Risky, Invalid, etc.) and will be skipped.\n\n' : '')
    + 'Only emails with no prior check result will be sent for verification.\n\nResults update as each batch of 10 finishes.';
  if (!confirm(msg)) return;

  targets.forEach(c => { c.email_status = 'pending'; });
  renderContacts();

  // Progress bar
  const progressEl = document.createElement('div');
  progressEl.id = 'verify-progress';
  progressEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:14px 20px;box-shadow:0 4px 20px rgba(0,0,0,.15);z-index:9999;min-width:300px;max-width:420px;';
  progressEl.innerHTML = '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">&#128269; Verifying Emails…</div>'
    + '<div style="background:var(--surface);border-radius:6px;height:8px;overflow:hidden;margin-bottom:8px;">'
    + '<div id="verify-bar" style="background:var(--accent);height:100%;width:0%;transition:width .3s ease;border-radius:6px;"></div></div>'
    + '<div id="verify-status" style="font-size:12px;color:var(--muted);">0 / ' + targets.length + ' checked</div>';
  document.body.appendChild(progressEl);

  const BATCH = 10;
  let done = 0, valid = 0, invalid = 0, risky = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch  = targets.slice(i, i + BATCH);
    const emails = batch.map(c => c.email);
    const ids    = batch.map(c => c.id);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ emails, contact_ids: ids })
      });
      const data = await res.json();
      if (data.results) {
        data.results.forEach(r => {
          const c = contacts.find(x => x.id === r.contact_id);
          if (c) {
            c.email_status = r.status;
            c.email_verify_reason = r.reason || '';
            c.email_verified_at = new Date().toISOString();
            if (r.status === 'valid') valid++;
            else if (['invalid','bad-domain','bad-syntax'].includes(r.status)) invalid++;
            else if (['risky','catch-all'].includes(r.status)) risky++;
          }
        });
        done += data.results.length;
      } else { done += batch.length; }
    } catch (e) { done += batch.length; }

    const pct      = Math.round((done / targets.length) * 100);
    const barEl    = document.getElementById('verify-bar');
    const statusEl = document.getElementById('verify-status');
    if (barEl)    barEl.style.width = pct + '%';
    if (statusEl) statusEl.textContent = done + ' / ' + targets.length + ' checked — ' + valid + ' valid, ' + risky + ' risky, ' + invalid + ' invalid';
    renderContacts();
  }

  // Completion state
  const barEl = document.getElementById('verify-bar');
  if (barEl) barEl.style.background = '#22c55e';
  const titleEl = progressEl.querySelector('div');
  if (titleEl) titleEl.innerHTML = '&#10003; Verification Complete';
  const statusEl = document.getElementById('verify-status');
  if (statusEl) statusEl.textContent = 'Complete! ' + valid + ' valid · ' + risky + ' risky · ' + invalid + ' invalid of ' + targets.length + ' checked';
  setTimeout(() => { const el = document.getElementById('verify-progress'); if (el) el.remove(); }, 5000);
  renderContacts();
}

// ============================================================
// ADMIN PANEL (system_owner only)
// ============================================================
async function renderAdmin() {
  if (currentAgent.role !== 'system_owner' && currentAgent.role !== 'agency_owner') { document.getElementById('page-admin').innerHTML = '<div class="empty-state"><div class="emoji">&#128274;</div><p>Access denied.</p></div>'; return; }

  const totalContacts = (await supabaseClient.from('contacts').select('id', { count: 'exact', head: true })).count || 0;
  const pendingAgents = allAgents.filter(a => a.status === 'pending');
  const activeAgents  = allAgents.filter(a => a.status !== 'pending');

  const pendingAgentSection = pendingAgents.length > 0 ? `
    <div style="background:#fffbeb;border:1.5px solid #f59e0b;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
      <div style="font-weight:700;font-size:14px;color:#b45309;margin-bottom:10px;">&#9203; ${pendingAgents.length} Pending Recruit${pendingAgents.length>1?'s':''} — Awaiting Approval</div>
      ${pendingAgents.map(a => {
        const recruiter = allAgents.find(x => x.id === a.recruited_by);
        const niprBadge = a.nipr_result
          ? (a.nipr_result.found ? '<span style="color:var(--success);font-size:11px;">&#10003; NIPR Found</span>' : '<span style="color:#f59e0b;font-size:11px;">&#9888; NIPR Not Found</span>')
          : '<span style="color:var(--muted);font-size:11px;">&#9679; NIPR Not Checked</span>';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #fde68a;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;">${a.name}</div>
            <div style="font-size:12px;color:var(--muted);">${a.email}${a.phone ? ' &middot; ' + a.phone : ''}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px;">
              Recruited by: ${recruiter ? recruiter.name : 'Direct'} &nbsp;&#183;&nbsp; ${new Date(a.created_at).toLocaleDateString()} &nbsp;&#183;&nbsp; ${niprBadge}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-accent btn-sm" onclick="approveAgent('${a.id}')">&#10003; Approve</button>
            <button class="btn btn-outline btn-sm" onclick="rejectAgent('${a.id}')">&#10005; Reject</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  const agentRows = activeAgents.map(a => {
    const agencyName = a.agencies?.name || '—';
    const roleBadge = a.role === 'system_owner' ? 'badge-sys' : a.role === 'agency_owner' ? 'badge-owner' : 'badge-agent';
    const roleLabel = { system_owner: 'System Owner', agency_owner: 'Agency Owner', agent: 'Agent' }[a.role] || a.role;
    return `<div class="agent-row">
      <div class="agent-info">
        <div class="agent-name">${a.name}</div>
        <div class="agent-meta">
          <span>${a.email}</span>
          <span>&#127970; ${agencyName}</span>
          <span class="badge ${roleBadge}" style="font-size:10px;">${roleLabel}</span>
          ${a.auth_user_id ? '<span style="color:var(--success);">&#10003; Linked</span>' : '<span style="color:var(--muted);">&#9679; Not logged in yet</span>'}
        </div>
      </div>
      <div class="agent-actions">
        <button class="btn btn-outline btn-sm" onclick="editAgent('${a.id}')">Edit</button>
        ${a.id !== currentAgent.id ? `<button class="btn btn-danger btn-sm" onclick="deleteAgent('${a.id}')">&#10005;</button>` : ''}
      </div>
    </div>`;
  }).join('');

  const agencyRows = allAgencies.map(ag => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-weight:600;font-size:14px;">${ag.name}</div>
        <div style="font-size:12px;color:var(--muted);">${ag.companies?.name||'No company'}</div>
      </div>
    </div>`).join('');

  const pending = applications.filter(a => a.status === 'pending');
  const trackLabel = { primerica: 'Life & Financial Services', insured_america: 'Health Insurance', both: 'Full-Service (Both)' };
  const appRows = pending.map(a => {
    const niprBadge = a.nipr_verified === true
      ? `<span style="color:var(--success);font-size:11px;">&#10003; NIPR Verified</span>`
      : a.nipr_discrepancy
      ? `<span style="color:var(--danger);font-size:11px;">&#9888; NIPR Discrepancy</span>`
      : `<span style="color:var(--muted);font-size:11px;">&#9679; NIPR not checked</span>`;
    const desiredEmail = a.desired_username ? `${a.desired_username}@thekannongroup.com` : '(pending selection)';
    return `<div style="border:1.5px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;">${a.first_name} ${a.last_name}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${a.personal_email}${a.phone ? ' &middot; ' + a.phone : ''}</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span class="badge badge-agent">${trackLabel[a.route] || a.route || 'Unknown'}</span>
            ${a.has_life_license ? '<span class="badge badge-active" style="font-size:10px;">Life &#10003;</span>' : ''}
            ${a.has_health_license ? '<span class="badge badge-active" style="font-size:10px;">Health &#10003;</span>' : ''}
            ${niprBadge}
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:5px;">KFG Email: ${desiredEmail} &nbsp;&#183;&nbsp; Applied: ${new Date(a.created_at).toLocaleDateString()}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn btn-accent btn-sm" onclick="approveApplication('${a.id}')">&#10003; Approve</button>
          <button class="btn btn-danger btn-sm" onclick="denyApplication('${a.id}')">&#10005; Deny</button>
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('page-admin').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2 class="section-title" style="margin:0;">&#9881;&#65039; ${currentAgent.role === 'agency_owner' ? 'Agency Admin' : 'System Admin'}</h2>
    </div>

    <div class="admin-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
      <div class="admin-stat"><div class="num">${allAgents.length}</div><div class="lbl">Total Agents</div></div>
      <div class="admin-stat" style="border-left-color:#3b82f6;"><div class="num">${totalContacts}</div><div class="lbl">Total Contacts</div></div>
      <div class="admin-stat" style="border-left-color:#10b981;"><div class="num">${allAgencies.length}</div><div class="lbl">Agencies</div></div>
      <div class="admin-stat" style="border-left-color:#8b5cf6;"><div class="num">${allCompanies.length}</div><div class="lbl">Companies</div></div>
      <div class="admin-stat" style="border-left-color:var(--danger);"><div class="num" style="${pending.length > 0 ? 'color:var(--danger);' : ''}">${pending.length}</div><div class="lbl">Pending Apps</div></div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-weight:700;font-size:16px;">&#128203; Agent Applications ${pending.length > 0 ? `<span style="background:var(--danger);color:white;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px;">${pending.length}</span>` : ''}</div>
        <button class="btn btn-outline btn-sm" onclick="loadData().then(renderAdmin)">&#8635; Refresh</button>
      </div>
      ${appRows || `<div style="font-size:13px;color:var(--muted);padding:8px 0;text-align:center;">No pending applications.</div>`}
      ${applications.filter(a=>a.status!=='pending').length > 0 ? `<div style="font-size:11px;color:var(--muted);margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">Approved: ${applications.filter(a=>a.status==='approved').length} &nbsp;&#183;&nbsp; Denied: ${applications.filter(a=>a.status==='denied').length}</div>` : ''}
    </div>

    ${currentAgent.role === 'system_owner' ? `<div class="card" style="margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="font-weight:700;font-size:16px;">&#128101; Agents ${pendingAgents.length > 0 ? `<span style="background:var(--danger);color:white;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px;">${pendingAgents.length}</span>` : ''}</div>
        <button class="btn btn-accent btn-sm" onclick="openAddAgent()">+ Add Agent</button>
      </div>
      ${pendingAgentSection}
      ${agentRows || '<div class="empty-state" style="padding:20px;"><p>No active agents yet.</p></div>'}
    </div>

    <div class="card">
      <div style="font-weight:700;font-size:16px;margin-bottom:16px;">&#127970; Agencies</div>
      ${agencyRows || '<div class="empty-state" style="padding:20px;"><p>No agencies.</p></div>'}
    </div>` : ''}

    <div class="card" style="margin-top:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:16px;margin-bottom:4px;">&#128221; Call Scripts</div>
          <div style="font-size:13px;color:var(--muted);">Manage the dialer's script tree — root scripts, objections, and rebuttals.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openScriptManager()">Manage Scripts</button>
      </div>
    </div>
  `;
}

// ============================================================
// RECRUITMENT FLOW
// ============================================================
async function recruitContact(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;

  // Check if already an agent
  const existing = allAgents.find(a => a.email === c.email);
  if (existing) { showToast(`${c.name} is already ${existing.status === 'pending' ? 'a pending recruit' : 'an active agent'}.`); return; }

  const agencyOptions = allAgencies.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  const recruiterOptions = allAgents.filter(a => a.status === 'active').map(a => `<option value="${a.id}" ${a.id===currentAgent.id?'selected':''}>${a.name}</option>`).join('');

  showModal(`Recruit ${c.name} as Agent`, `
    <div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;">
      <strong>${c.name}</strong> will receive an enrollment invitation email and be added as a <em>pending</em> agent until approved.
    </div>
    <label>Recruiting Agent</label>
    <select id="rec-recruiter">${recruiterOptions}</select>
    <label>Assign to Agency (optional)</label>
    <select id="rec-agency"><option value="">— No agency yet —</option>${agencyOptions}</select>
    <label>Role</label>
    <select id="rec-role">
      <option value="agent">Agent</option>
      <option value="agency_owner">Agency Owner</option>
    </select>
    <label>Notes (optional)</label>
    <textarea id="rec-notes" placeholder="Any notes about this recruit..."></textarea>
  `, async () => {
    const { data, error } = await supabaseClient.from('agents').insert({
      name: c.name,
      email: c.email,
      phone: c.phone || null,
      role: document.getElementById('rec-role').value,
      status: 'pending',
      recruited_by: document.getElementById('rec-recruiter').value || currentAgent.id,
      agency_id: document.getElementById('rec-agency').value || null,
      contact_id: c.id,
      notes: document.getElementById('rec-notes').value.trim() || null
    }).select().single();

    if (error) { showToast('Error: ' + error.message); return false; }
    allAgents.push(data);
    showToast(`&#128101; ${c.name} recruited! Enrollment email sent.`);
    closeContactPanel();
  });
}

async function approveAgent(agentId) {
  const a = allAgents.find(x => x.id === agentId);
  if (!a) return;
  if (!confirm(`Approve ${a.name} as an active agent? This will trigger the onboarding automation.`)) return;

  const { error } = await supabaseClient.from('agents').update({ status: 'active' }).eq('id', agentId);
  if (error) { showToast('Error: ' + error.message); return; }
  a.status = 'active';
  showToast(`&#10003; ${a.name} approved! Welcome email and Workspace setup initiated.`);
  renderAdmin();
}

async function rejectAgent(agentId) {
  const a = allAgents.find(x => x.id === agentId);
  if (!a) return;
  if (!confirm(`Reject and remove ${a.name}'s agent application?`)) return;

  const { error } = await supabaseClient.from('agents').update({ status: 'inactive' }).eq('id', agentId);
  if (error) { showToast('Error: ' + error.message); return; }
  a.status = 'inactive';
  showToast(`${a.name} rejected.`);
  renderAdmin();
}

function openAddAgent() {
  const agencyOptions = allAgencies.map(a => `<option value="${a.id}">${a.name} — ${a.companies?.name||''}</option>`).join('');
  const companyCheckboxes = allCompanies.map(c => `
    <label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer;font-weight:400;">
      <input type="checkbox" id="co-${c.id}" value="${c.id}" style="width:auto;" /> ${c.name}
    </label>`).join('');
  showModal('Add Agent', `
    <label>Full Name *</label><input type="text" id="ag-name" placeholder="Jane Smith" />
    <label>Email * (must match their @thekannongroup.com account)</label><input type="email" id="ag-email" placeholder="jane@thekannongroup.com" />
    <label>Role</label>
    <select id="ag-role">
      <option value="agent">Agent</option>
      <option value="agency_owner">Agency Owner</option>
      <option value="system_owner">System Owner</option>
    </select>
    <label>Agency</label>
    <select id="ag-agency"><option value="">— No agency —</option>${agencyOptions}</select>
    <label>Companies</label>
    ${companyCheckboxes}
  `, async () => {
    const name = document.getElementById('ag-name').value.trim();
    const email = document.getElementById('ag-email').value.trim();
    if (!name || !email) { showToast('Name and email are required'); return false; }
    const { data, error } = await supabaseClient.from('agents').insert({
      name, email,
      role: document.getElementById('ag-role').value,
      agency_id: document.getElementById('ag-agency').value || null
    }).select().single();
    if (error) { showToast('Error: ' + error.message); return false; }

    // Add company memberships
    const selected = allCompanies.filter(c => document.getElementById('co-'+c.id)?.checked);
    if (selected.length > 0) {
      await supabaseClient.from('agent_companies').insert(selected.map(c => ({ agent_id: data.id, company_id: c.id })));
    }

    allAgents.push(data); showToast('Agent added! They can now log in with their @thekannongroup.com Google account.'); renderAdmin();
  });
}

function editAgent(id) {
  const a = allAgents.find(x => x.id === id); if (!a) return;
  const agencyOptions = allAgencies.map(ag => `<option value="${ag.id}" ${ag.id===a.agency_id?'selected':''}>${ag.name} — ${ag.companies?.name||''}</option>`).join('');
  showModal('Edit Agent', `
    <label>Full Name *</label><input type="text" id="ag-name" value="${a.name}" />
    <label>Email *</label><input type="email" id="ag-email" value="${a.email}" />
    <label>Role</label>
    <select id="ag-role">
      <option value="agent" ${a.role==='agent'?'selected':''}>Agent</option>
      <option value="agency_owner" ${a.role==='agency_owner'?'selected':''}>Agency Owner</option>
      <option value="system_owner" ${a.role==='system_owner'?'selected':''}>System Owner</option>
    </select>
    <label>Agency</label>
    <select id="ag-agency"><option value="">— No agency —</option>${agencyOptions}</select>
  `, async () => {
    const name = document.getElementById('ag-name').value.trim();
    const email = document.getElementById('ag-email').value.trim();
    if (!name || !email) { showToast('Name and email are required'); return false; }
    const updates = { name, email, role: document.getElementById('ag-role').value, agency_id: document.getElementById('ag-agency').value || null };
    const { error } = await supabaseClient.from('agents').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }
    Object.assign(a, updates); showToast('Agent updated!'); renderAdmin();
  });
}

async function deleteAgent(id) {
  if (!confirm('Remove this agent? Their contacts will remain but become unassigned.')) return;
  await supabaseClient.from('agents').delete().eq('id', id);
  allAgents = allAgents.filter(a => a.id !== id); renderAdmin(); showToast('Agent removed');
}

// ============================================================
// MODAL
// ============================================================
// ============================================================
// START / RESTART OUTREACH SEQUENCE
// ============================================================
async function startSequence(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;
  const cur = c.type || 'Individual/Family';
  const isOptedOut = c.opt_out_email || c.sequence_status === 'Opted Out';
  if (isOptedOut) { showToast('This contact has opted out — cannot re-enroll.'); return; }
  if (c.email_status === 'bounced') { showToast('This contact has a bounced email — fix it first.'); return; }

  showModal('Start Sequence: ' + (c.name || 'Contact'), `
    <p style="margin:0 0 14px;color:#64748b;font-size:14px;">
      Choose a track below. <strong>${c.name || 'This contact'}</strong> will receive Email 1 on the next automation run (within 24 hours).
    </p>
    <label style="display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#374151;margin-bottom:6px;">Sequence Track</label>
    <select id="seq-track-select" style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:12px;">
      <option value="Individual/Family" ${cur === 'Individual/Family' ? 'selected' : ''}>B2C — Individual / Family</option>
      <option value="Group/Employer" ${cur === 'Group/Employer' ? 'selected' : ''}>B2B — Group / Employer</option>
      <option value="Recruit" ${cur === 'Recruit' ? 'selected' : ''}>Recruit — State Farm Agent</option>
    </select>
    <p style="font-size:11px;color:#94a3b8;margin:0;">Changing the track also updates the contact type. Any previous sequence progress is reset.</p>
  `, async () => {
    const track = document.getElementById('seq-track-select')?.value || cur;
    const updates = { type: track, sequence_status: null, sequence_step: 0, last_email_sent_at: null };
    const { error } = await supabaseClient.from('contacts').update(updates).eq('id', contactId);
    if (error) { showToast('Error: ' + error.message); return false; }
    Object.assign(c, updates);
    showToast('✓ Sequence queued! ' + (c.name || 'Contact') + ' gets Email 1 on the next run.');
    viewContact(contactId);
    return true;
  }, { confirmLabel: 'Start Sequence' });
}

function showModal(title, bodyHtml, onSave, opts = {}) {
  const confirmLabel = opts.confirmLabel || 'Save';
  const footer = opts.hideConfirm
    ? `<div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">${opts.cancelLabel || 'Close'}</button></div>`
    : `<div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="handleModalSave()">${confirmLabel}</button></div>`;
  const modalStyle = opts.wide ? 'max-width:900px;padding:0;' : '';
  const bodyStyle  = opts.wide ? 'padding:0;' : '';
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="${modalStyle}">
        <div class="modal-header" style="${opts.wide ? 'margin:0;border-radius:12px 12px 0 0;padding:16px 20px;' : ''}"><h2>${title}</h2><button class="modal-close" onclick="closeModal()">&times;</button></div>
        <div class="modal-body" style="${bodyStyle}">${bodyHtml}</div>
        ${footer}
      </div>
    </div>`;
  window._modalSaveHandler = onSave;
}

async function handleModalSave() {
  if (window._modalSaveHandler) { const result = await window._modalSaveHandler(); if (result !== false) closeModal(); }
}

function closeModal() { document.getElementById('modal-container').innerHTML = ''; window._modalSaveHandler = null; }

// ============================================================
// TOAST
// ============================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2800);
}

// ============================================================
// GOOGLE CONTACTS SYNC
// ============================================================
async function syncGoogleContacts() {
  if (!currentAgent || !currentAgent.id) { showToast('No agent selected.'); return; }
  showToast('&#128257; Syncing Google Contacts...');
  try {
    const res = await fetch(APPS_SCRIPT_URL + '?action=sync_contacts&agent_id=' + encodeURIComponent(currentAgent.id));
    const data = await res.json().catch(() => ({}));
    if (data.status === 'ok') {
      const msg = 'Google Contacts synced! Pushed: ' + (data.pushed || 0) + ', imported: ' + (data.imported || 0) + ', linked: ' + (data.linked || 0);
      showToast('&#10003; ' + msg);
    } else {
      showToast('Sync error: ' + (data.message || 'Check Apps Script logs.'));
    }
  } catch(e) {
    showToast('Sync failed: ' + e.message);
  }
}

// ============================================================
// AGENT APPLICATIONS
// ============================================================
async function approveApplication(id) {
  const app = applications.find(a => a.id === id);
  if (!app) return;
  const notes = prompt(`Approve ${app.first_name} ${app.last_name}?\n\nOptional internal notes:`, '');
  if (notes === null) return; // cancelled

  const workspaceEmail = app.desired_username ? `${app.desired_username}@thekannongroup.com` : app.personal_email;
  const { data: newAgent, error: agentErr } = await supabaseClient.from('agents').insert({
    name: `${app.first_name} ${app.last_name}`,
    email: workspaceEmail,
    role: 'agent',
    phone: app.phone || null,
    route: app.route || null,
    has_life_license: app.has_life_license || false,
    has_health_license: app.has_health_license || false,
    workspace_email: workspaceEmail
  }).select().single();

  if (agentErr) { showToast('Error creating agent: ' + agentErr.message); return; }

  const { error: appErr } = await supabaseClient.from('agent_applications').update({
    status: 'approved',
    reviewed_by: currentAgent.id,
    reviewed_at: new Date().toISOString(),
    review_notes: notes || null,
    agent_id: newAgent.id,
    workspace_account_created: false
  }).eq('id', id);

  if (appErr) { showToast('Error updating application: ' + appErr.message); return; }

  const idx = applications.findIndex(a => a.id === id);
  if (idx >= 0) applications[idx] = { ...applications[idx], status: 'approved', agent_id: newAgent.id };
  allAgents.push(newAgent);

  showToast('✓ ' + app.first_name + ' ' + app.last_name + ' approved! Create their Google Workspace account in Admin Console.');
  renderAdmin();
}

async function denyApplication(id) {
  const app = applications.find(a => a.id === id);
  if (!app) return;
  const reason = prompt(`Deny ${app.first_name} ${app.last_name}?\n\nOptional reason (for internal notes):`, '');
  if (reason === null) return; // cancelled

  const { error } = await supabaseClient.from('agent_applications').update({
    status: 'denied',
    reviewed_by: currentAgent.id,
    reviewed_at: new Date().toISOString(),
    review_notes: reason || null
  }).eq('id', id);

  if (error) { showToast('Error: ' + error.message); return; }

  const idx = applications.findIndex(a => a.id === id);
  if (idx >= 0) applications[idx] = { ...applications[idx], status: 'denied' };

  showToast('Application denied.');
  renderAdmin();
}

// ============================================================
// AI ASSISTANT
// ============================================================
let aiHistory = [];      // { role: 'user'|'assistant', content: string }[]
let aiPanelOpen = false;
let aiThinking = false;

const AI_SUGGESTIONS = [
  'Who are my hottest leads?',
  'Summarize pipeline health',
  'Which contacts haven\'t been touched yet?',
  'How many deals are in each stage?',
  'What should I focus on today?',
];

function showAIBubble() {
  const bubble = document.getElementById('ai-bubble');
  if (bubble) bubble.style.display = 'flex'; // flex keeps icon + text aligned
}

function toggleAIPanel() {
  aiPanelOpen = !aiPanelOpen;
  const panel = document.getElementById('ai-panel');
  const bubble = document.getElementById('ai-bubble');
  if (panel) panel.classList.toggle('open', aiPanelOpen);
  if (bubble) bubble.classList.toggle('open', aiPanelOpen);
  if (aiPanelOpen) {
    if (aiHistory.length === 0) renderAISuggestions();
    setTimeout(() => document.getElementById('ai-input')?.focus(), 50);
  }
}

async function sendAIMessage(message) {
  if (!message || !message.trim()) return;
  message = message.trim();

  // Append user message
  aiHistory.push({ role: 'user', content: message });
  renderAIMessages();

  // Show thinking indicator
  aiThinking = true;
  const sendBtn = document.getElementById('ai-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  appendAIThinking();

  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/ai-assistant`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
        },
        body: JSON.stringify({
          message,
          context: buildCRMContext(),
          history: aiHistory.slice(0, -1),
        }),
      }
    );

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    aiHistory.push({ role: 'assistant', content: data.text });
  } catch (e) {
    aiHistory.push({ role: 'assistant', content: `⚠ Error: ${e.message}` });
  } finally {
    aiThinking = false;
    if (sendBtn) sendBtn.disabled = false;
    renderAIMessages();
    setTimeout(() => document.getElementById('ai-input')?.focus(), 50);
  }
}

function appendAIThinking() {
  const container = document.getElementById('ai-messages');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'ai-msg assistant thinking';
  el.id = 'ai-thinking-indicator';
  el.textContent = '🤔 Thinking…';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function renderAIMessages() {
  const container = document.getElementById('ai-messages');
  if (!container) return;
  const thinking = document.getElementById('ai-thinking-indicator');
  if (thinking) thinking.remove();

  if (aiHistory.length === 0) {
    renderAISuggestions();
    return;
  }

  container.innerHTML = aiHistory.map(m => {
    const isUser = m.role === 'user';
    const content = (m.content || '')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    return `<div class="ai-msg ${isUser ? 'user' : 'assistant'}">${content}</div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
  if (aiThinking) appendAIThinking();
}

function renderAISuggestions() {
  const container = document.getElementById('ai-messages');
  if (!container) return;
  const firstName = (currentAgent?.name || '').split(' ')[0] || 'there';
  container.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);padding:8px 0 12px;">Hi ${firstName} — ask me anything about your contacts, pipeline, or sequences.</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${AI_SUGGESTIONS.map(s => `<button class="ai-suggestion" onclick="sendAIMessage('${s.replace(/'/g, "\'")}')">${s}</button>`).join('')}
    </div>`;
}

function buildCRMContext() {
  const total     = contacts.length;
  const active    = contacts.filter(c => c.sequence_status === 'Active').length;
  const drip      = contacts.filter(c => c.sequence_status === 'Drip').length;
  const replied   = contacts.filter(c => c.sequence_status === 'Replied').length;
  const bounced   = contacts.filter(c => c.email_status === 'bounced').length;
  const optedOut  = contacts.filter(c => c.sequence_status === 'Opted-Out').length;
  const indiv     = contacts.filter(c => c.type === 'Individual/Family').length;
  const grp       = contacts.filter(c => c.type === 'Group/Employer').length;
  const recruit   = contacts.filter(c => c.type === 'Recruit').length;
  const step1     = contacts.filter(c => c.sequence_step >= 1).length;
  const step2     = contacts.filter(c => c.sequence_step >= 2).length;
  const step3     = contacts.filter(c => c.sequence_step >= 3).length;
  const dealCount = deals ? deals.length : 0;
  const pipeline  = currentPipeline || 'all pipelines';

  return `KFG CRM Context — Agent: ${currentAgent?.name || 'Unknown'} | ${new Date().toLocaleDateString()}
Contacts: ${total} total | ${indiv} Individual/Family | ${grp} Group/Employer | ${recruit} Recruit
Sequence Status: ${active} Active | ${drip} Drip | ${replied} Replied | ${bounced} Bounced | ${optedOut} Opted-Out
Sequence Progress: ${step1} sent Email 1 | ${step2} sent Email 2 | ${step3} sent Email 3
Deals: ${dealCount} in ${pipeline}`;
}


// ============================================================
// SETTINGS PAGE
// ============================================================
async function renderSettings() {
  const pg = document.getElementById('page-settings');
  if (!pg) return;
  // Refresh agent record from DB
  const { data: fresh } = await supabaseClient.from('agents').select('*').eq('id', currentAgent.id).single();
  if (fresh) Object.assign(currentAgent, fresh);

  const agencyName = currentAgent.agencies?.name || allAgencies.find(a => a.id === currentAgent.agency_id)?.name || '—';

  pg.innerHTML = `
    <h2 class="section-title" style="margin-bottom:20px;">⚙ Settings</h2>
    <div style="max-width:680px;">

      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title"><i class="ti ti-user"></i>Profile</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Full Name</label>
            <input type="text" id="s-name" value="${currentAgent.name||''}" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Display Name (booking page)</label>
            <input type="text" id="s-display-name" value="${currentAgent.display_name||currentAgent.name||''}" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Phone</label>
            <input type="text" id="s-phone" value="${currentAgent.phone||''}" placeholder="(555) 555-5555" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Title / Role</label>
            <input type="text" id="s-title" value="${currentAgent.title||''}" placeholder="e.g. Licensed Insurance Advisor" style="width:100%;box-sizing:border-box;" />
          </div>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Login Email</label>
          <input type="text" value="${currentAgent.email||''}" disabled style="width:100%;box-sizing:border-box;background:var(--surface-0);color:var(--text-muted);" />
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Contact your system admin to change your login email.</div>
        </div>
        <div style="margin-top:10px;padding:10px;background:var(--surface-1);border-radius:8px;border:0.5px solid var(--border);font-size:12px;color:var(--text-muted);">
          <strong style="color:var(--text-secondary);">Role:</strong> ${({ system_owner: 'System Owner', agency_owner: 'Agency Owner', agent: 'Agent' }[currentAgent.role] || currentAgent.role)}
          &nbsp;&middot;&nbsp;
          <strong style="color:var(--text-secondary);">Agency:</strong> ${agencyName}
        </div>
      </div>

      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title"><i class="ti ti-calendar-event"></i>Your Booking Page</div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Your CRM Booking Link (auto-generated)</label>
        ${currentAgent.route ? `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">
          <input type="text" value="https://kannon-crm.vercel.app/book?agent=${currentAgent.route}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:12px;cursor:text;" />
          <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/book?agent=${currentAgent.route}').then(()=>showToast('✓ Copied!'))"><i class="ti ti-copy"></i></button>
          <a href="https://kannon-crm.vercel.app/book?agent=${currentAgent.route}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
        </div>` : `<div style="font-size:12px;color:var(--text-muted);padding:10px;background:var(--surface-1);border-radius:6px;margin-bottom:10px;">No booking page route set. Contact your system admin to assign your agent route slug.</div>`}
        <div style="font-size:11px;color:var(--text-muted);line-height:1.6;">This link is automatically embedded in all outreach emails you send through the CRM. Prospects click it to see your available appointment types and request a booking.</div>
        <div style="margin-top:14px;border-top:0.5px solid var(--border);padding-top:14px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">External Booking URL (optional override — e.g. Calendly)</label>
          <input type="url" id="s-booking-link" value="${currentAgent.booking_link||''}" placeholder="https://calendly.com/yourname" style="width:100%;box-sizing:border-box;" />
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Only fill this in if you prefer to use Calendly or another scheduler instead of the CRM booking page.</div>
        </div>
      </div>

      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title"><i class="ti ti-link"></i>My Lead Capture Links</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;line-height:1.6;">
          These links are personalized to you — any lead who submits is automatically assigned to you in the CRM. Share them in ads, emails, social media, or as QR codes.
        </div>

        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent);margin-bottom:10px;">Kannon Financial Group</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">General (Client or Recruit chooser)</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=kfg&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=kfg&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=kfg&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">Client — Coverage Leads</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=kfg&type=client&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=kfg&type=client&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=kfg&type=client&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">Recruit — Career Leads</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=kfg&type=recruit&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=kfg&type=recruit&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=kfg&type=recruit&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
        </div>

        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent);margin-bottom:10px;border-top:0.5px solid var(--border);padding-top:16px;">Insured America Agency</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">General (Client or Recruit chooser)</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=ia&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=ia&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=ia&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">Client — Coverage Leads</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=ia&type=client&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=ia&type=client&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=ia&type=client&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">Recruit — Career Leads</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" value="https://kannon-crm.vercel.app/lead.html?co=ia&type=recruit&agent=${currentAgent.id}" readonly style="flex:1;box-sizing:border-box;background:var(--surface-1);color:var(--text-secondary);font-size:11px;cursor:text;" />
              <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('https://kannon-crm.vercel.app/lead.html?co=ia&type=recruit&agent=${currentAgent.id}').then(()=>showToast('Copied!'))"><i class="ti ti-copy"></i></button>
              <a href="https://kannon-crm.vercel.app/lead.html?co=ia&type=recruit&agent=${currentAgent.id}" target="_blank" class="btn btn-outline btn-sm"><i class="ti ti-external-link"></i></a>
            </div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:14px;padding-top:12px;border-top:0.5px solid var(--border);line-height:1.6;">
          <strong>Tip for ads:</strong> Add <code style="background:var(--surface-0);padding:1px 5px;border-radius:3px;font-size:10px;">&amp;utm_source=facebook&amp;utm_medium=paid_social&amp;utm_campaign=your-campaign</code> to any link for full ad tracking in the CRM.
        </div>
      </div>

      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title"><i class="ti ti-mail"></i>Gmail Connection</div>
        <div class="action-item">
          <div class="action-item-info">
            <div class="action-item-name">Gmail &amp; Calendar</div>
            <div class="action-item-sub">${currentAgent.gmail_connected ? (currentAgent.gmail_email || 'Connected') : 'Not connected — email sequences will not send'}</div>
          </div>
          ${currentAgent.gmail_connected && currentAgent.calendar_connected
            ? `<span style="display:flex;align-items:center;gap:6px;"><span class="badge badge-active"><i class="ti ti-check"></i> Gmail &amp; Calendar</span><button class="btn btn-outline btn-sm" onclick="showGmailSetup(true)" title="Reconnect to update permissions">&#128257; Reconnect</button></span>`
            : currentAgent.gmail_connected
            ? `<span style="display:flex;align-items:center;gap:6px;"><span class="badge badge-active"><i class="ti ti-check"></i> Gmail</span><button class="btn btn-primary btn-sm" onclick="connectCalendar()" title="Re-authorize to add Calendar sync">&#128197; Add Calendar</button><button class="btn btn-outline btn-sm" onclick="showGmailSetup(true)" title="Reconnect to update permissions">&#128257; Reconnect</button></span>`
            : `<button class="btn btn-primary btn-sm" onclick="showGmailSetup(true)">Connect Gmail</button>`}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.6;">Gmail must be connected so the CRM can send outreach emails on your behalf through your Gmail account.</div>
      </div>

      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title"><i class="ti ti-certificate"></i>Licenses</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-primary);">
            <input type="checkbox" id="s-life" ${currentAgent.has_life_license ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;" />
            Life Insurance License
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-primary);">
            <input type="checkbox" id="s-health" ${currentAgent.has_health_license ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;" />
            Health Insurance License
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-primary);">
            <input type="checkbox" id="s-investment" ${currentAgent.has_investment_license ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;" />
            Investment License (Series 6 / 63)
          </label>
        </div>
      </div>

            <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title">&#128279; Social Media</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">LinkedIn</label>
            <input type="text" id="s-linkedin" value="${currentAgent.linkedin_url||''}" placeholder="linkedin.com/in/username" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Facebook</label>
            <input type="text" id="s-facebook" value="${currentAgent.facebook_url||''}" placeholder="facebook.com/username" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Instagram</label>
            <input type="text" id="s-instagram" value="${currentAgent.instagram_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">X / Twitter</label>
            <input type="text" id="s-twitter" value="${currentAgent.twitter_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">WhatsApp</label>
            <input type="tel" id="s-whatsapp" value="${currentAgent.whatsapp_number||''}" placeholder="+1 406 555 0000" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">TikTok</label>
            <input type="text" id="s-tiktok" value="${currentAgent.tiktok_handle||''}" placeholder="@handle" style="width:100%;box-sizing:border-box;" />
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Telegram</label>
            <input type="text" id="s-telegram" value="${currentAgent.telegram_handle||''}" placeholder="@username" style="width:100%;box-sizing:border-box;" />
          </div>
        </div>
      </div>
<div style="display:flex;justify-content:space-between;align-items:center;">
        <button class="btn btn-outline btn-sm" onclick="signOut()"><i class="ti ti-logout"></i> Sign out</button>
        <button class="btn btn-primary" onclick="saveSettings()"><i class="ti ti-device-floppy"></i> Save Settings</button>
      </div>
    </div>
  `;
}

async function saveSettings() {
  const nameEl   = document.getElementById('s-name');
  const dispEl   = document.getElementById('s-display-name');
  const phoneEl  = document.getElementById('s-phone');
  const titleEl  = document.getElementById('s-title');
  const bookEl   = document.getElementById('s-booking-link');
  const lifeEl   = document.getElementById('s-life');
  const healthEl = document.getElementById('s-health');
  const invEl    = document.getElementById('s-investment');
  const linkedinEl  = document.getElementById('s-linkedin');
  const facebookEl  = document.getElementById('s-facebook');
  const instagramEl = document.getElementById('s-instagram');
  const twitterEl   = document.getElementById('s-twitter');
  const whatsappEl  = document.getElementById('s-whatsapp');
  const tiktokEl    = document.getElementById('s-tiktok');
  const telegramEl  = document.getElementById('s-telegram');
  if (!nameEl) return;

  const updates = {
    name:                  nameEl.value.trim(),
    display_name:          dispEl.value.trim() || null,
    phone:                 phoneEl.value.trim() || null,
    title:                 titleEl.value.trim() || null,
    booking_link:          bookEl.value.trim() || null,
    has_life_license:      lifeEl.checked,
    has_health_license:    healthEl.checked,
    has_investment_license: invEl.checked,
    linkedin_url:     linkedinEl ? linkedinEl.value.trim() || null : null,
    facebook_url:     facebookEl ? facebookEl.value.trim() || null : null,
    instagram_handle: instagramEl ? instagramEl.value.trim().replace(/^@/, '') || null : null,
    twitter_handle:   twitterEl  ? twitterEl.value.trim().replace(/^@/, '') || null : null,
    whatsapp_number:  whatsappEl ? whatsappEl.value.trim() || null : null,
    tiktok_handle:    tiktokEl   ? tiktokEl.value.trim().replace(/^@/, '') || null : null,
    telegram_handle:  telegramEl ? telegramEl.value.trim().replace(/^@/, '') || null : null,
  };

  const { error } = await supabaseClient.from('agents').update(updates).eq('id', currentAgent.id);
  if (error) { showToast('Error saving: ' + error.message); return; }
  Object.assign(currentAgent, updates);

  // Update sidebar display
  const snEl = document.getElementById('sidebar-user-name');
  if (snEl) snEl.textContent = currentAgent.name;
  const ndEl = document.getElementById('user-name-display');
  if (ndEl) ndEl.textContent = currentAgent.name;

  showToast('✓ Settings saved!');
}

// ============================================================
// OVERSIGHT DASHBOARD
// ============================================================
async function renderOversight() {
  const pg = document.getElementById('page-oversight');
  if (!pg) return;

  const now = new Date();
  const STALE_SEQ_DAYS  = 5;
  const STALE_DEAL_DAYS = 7;
  const WEB_LEAD_DAYS   = 30;

  function daysSince(ds) {
    if (!ds) return 999;
    return Math.floor((now - new Date(ds)) / 86400000);
  }
  function daysLabel(n) {
    if (n >= 999) return 'Never contacted';
    if (n === 0) return 'Today';
    if (n === 1) return '1 day ago';
    return n + ' days ago';
  }
  function agentLabel(agentId) {
    var a = allAgents.find(function(ag) { return ag.id === agentId; });
    return a ? a.name : '—';
  }

  var isOwner = currentAgent.role === 'system_owner' || currentAgent.role === 'agency_owner';
  var FINAL_STAGES = ['Enrolled', 'Active Client', 'Contracted', 'Active Agent'];

  // ── EXCEPTION SETS ──
  var webLeads = contacts.filter(function(c) {
    return c.sequence_status === 'not started'
      && c.notes && c.notes.includes('[Web Lead')
      && daysSince(c.created_at) <= WEB_LEAD_DAYS;
  }).sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

  var stalledSeq = contacts.filter(function(c) {
    return c.sequence_status === 'Active' && daysSince(c.last_called_at) >= STALE_SEQ_DAYS;
  }).sort(function(a, b) { return daysSince(b.last_called_at) - daysSince(a.last_called_at); });

  var dripContacts = contacts.filter(function(c) { return c.sequence_status === 'Drip'; })
    .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

  var actByDeal = {};
  dealActivities.forEach(function(act) {
    if (!actByDeal[act.deal_id] || new Date(act.created_at) > new Date(actByDeal[act.deal_id])) {
      actByDeal[act.deal_id] = act.created_at;
    }
  });

  var stalledDeals = deals.filter(function(d) {
    if (FINAL_STAGES.includes(d.stage)) return false;
    return daysSince(actByDeal[d.id] || d.created_at) >= STALE_DEAL_DAYS;
  }).sort(function(a, b) {
    return daysSince(actByDeal[b.id] || b.created_at) - daysSince(actByDeal[a.id] || a.created_at);
  });

  var totalExceptions = webLeads.length + stalledSeq.length + stalledDeals.length;

  pg.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <div>
        <h2 class="section-title" style="margin-bottom:4px;">&#9888;&#65039; Oversight Dashboard</h2>
        <div style="font-size:13px;color:var(--text-muted);">${isOwner ? 'Team-wide exceptions that need a human decision.' : 'Your exceptions that need attention.'}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="renderOversight()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px;">
      <div style="padding:10px 14px;border-radius:8px;border:0.5px solid #fecaca;background:rgba(239,68,68,0.05);border-left:3px solid #ef4444;cursor:pointer;" onclick="document.getElementById('ov-web').scrollIntoView({behavior:'smooth'})">
        <div style="font-size:22px;font-weight:700;color:#ef4444;line-height:1.2;">${webLeads.length}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Web leads untouched</div>
      </div>
      <div style="padding:10px 14px;border-radius:8px;border:0.5px solid #fde68a;background:rgba(245,158,11,0.05);border-left:3px solid #f59e0b;cursor:pointer;" onclick="document.getElementById('ov-seq').scrollIntoView({behavior:'smooth'})">
        <div style="font-size:22px;font-weight:700;color:#f59e0b;line-height:1.2;">${stalledSeq.length}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Stalled in sequence</div>
      </div>
      <div style="padding:10px 14px;border-radius:8px;border:0.5px solid #bfdbfe;background:rgba(59,130,246,0.05);border-left:3px solid #3b82f6;cursor:pointer;" onclick="document.getElementById('ov-drip').scrollIntoView({behavior:'smooth'})">
        <div style="font-size:22px;font-weight:700;color:#3b82f6;line-height:1.2;">${dripContacts.length}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">In drip campaign</div>
      </div>
      <div style="padding:10px 14px;border-radius:8px;border:0.5px solid #e9d5ff;background:rgba(139,92,246,0.05);border-left:3px solid #8b5cf6;cursor:pointer;" onclick="document.getElementById('ov-deals').scrollIntoView({behavior:'smooth'})">
        <div style="font-size:22px;font-weight:700;color:#8b5cf6;line-height:1.2;">${stalledDeals.length}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">Stalled pipeline deals</div>
      </div>
    </div>

    ${totalExceptions === 0 && dripContacts.length === 0 ? `
    <div class="dash-card" style="text-align:center;padding:48px 24px;">
      <div style="font-size:40px;margin-bottom:12px;">&#10003;</div>
      <div style="font-size:18px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">All clear!</div>
      <div style="font-size:13px;color:var(--text-muted);">No exceptions right now. Check back later.</div>
    </div>` : ''}

    <div id="ov-web" class="dash-card" style="margin-bottom:16px;">
      <div class="dash-card-title" style="color:#ef4444;"><i class="ti ti-world"></i>New Web Leads — Untouched
        <span style="margin-left:8px;font-size:11px;font-weight:700;background:rgba(239,68,68,0.12);color:#ef4444;padding:2px 8px;border-radius:10px;">${webLeads.length}</span>
        <span style="margin-left:6px;font-size:11px;font-weight:400;color:var(--text-muted);">(last ${WEB_LEAD_DAYS} days, sequence not started)</span>
      </div>
      ${webLeads.length === 0
        ? '<div style="padding:16px 0;font-size:13px;color:var(--text-muted);text-align:center;">No untouched web leads &#10003;</div>'
        : webLeads.map(function(c) {
            var srcMatch = c.notes ? c.notes.match(/Source: ([^\n]+)/) : null;
            var src = srcMatch ? srcMatch[1] : 'web';
            var daysOld = daysSince(c.created_at);
            var ageColor = daysOld === 0 ? '#ef4444' : daysOld <= 2 ? '#ef4444' : '#f59e0b';
            var ageStr = daysOld === 0 ? 'Today' : daysOld === 1 ? '1 day ago' : daysOld + ' days ago';
            return '<div class="action-item" style="border:0.5px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:8px;background:rgba(239,68,68,0.02);">'
              + '<div class="action-item-info">'
              + '<div class="action-item-name" style="cursor:pointer;display:flex;align-items:center;gap:8px;" onclick="viewContact(\'' + c.id + '\')">'
              + (c.name || '(no name)')
              + '<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:rgba(239,68,68,0.12);color:#ef4444;">Web Lead</span>'
              + '</div>'
              + '<div class="action-item-sub" style="margin-top:3px;">'
              + (c.phone ? c.phone + ' &middot; ' : '') + src
              + ' &middot; <strong style="color:' + ageColor + ';">' + ageStr + '</strong>'
              + (isOwner && c.agent_id ? ' &middot; Agent: <strong>' + agentLabel(c.agent_id) + '</strong>' : '')
              + '</div></div>'
              + '<button class="btn btn-primary btn-sm" onclick="viewContact(\'' + c.id + '\')"><i class="ti ti-phone"></i> Work Lead</button>'
              + '</div>';
          }).join('')
      }
    </div>

    <div id="ov-seq" class="dash-card" style="margin-bottom:16px;">
      <div class="dash-card-title" style="color:#f59e0b;"><i class="ti ti-clock-pause"></i>Stalled in Sequence
        <span style="margin-left:8px;font-size:11px;font-weight:700;background:rgba(245,158,11,0.12);color:#f59e0b;padding:2px 8px;border-radius:10px;">${stalledSeq.length}</span>
        <span style="margin-left:6px;font-size:11px;font-weight:400;color:var(--text-muted);">(Active, no action in ${STALE_SEQ_DAYS}+ days)</span>
      </div>
      ${stalledSeq.length === 0
        ? '<div style="padding:16px 0;font-size:13px;color:var(--text-muted);text-align:center;">No stalled sequence contacts &#10003;</div>'
        : stalledSeq.map(function(c) {
            var stale = daysSince(c.last_called_at);
            return '<div class="action-item" style="border:0.5px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:8px;background:rgba(245,158,11,0.02);">'
              + '<div class="action-item-info">'
              + '<div class="action-item-name" style="cursor:pointer;" onclick="viewContact(\'' + c.id + '\')">' + (c.name || '(no name)') + '</div>'
              + '<div class="action-item-sub" style="margin-top:3px;">'
              + 'Last contacted: <strong style="color:#f59e0b;">' + daysLabel(stale) + '</strong>'
              + ' &middot; ' + (c.type || '—')
              + (isOwner && c.agent_id ? ' &middot; Agent: <strong>' + agentLabel(c.agent_id) + '</strong>' : '')
              + '</div></div>'
              + '<button class="btn btn-outline btn-sm" onclick="viewContact(\'' + c.id + '\')"><i class="ti ti-eye"></i> View</button>'
              + '</div>';
          }).join('')
      }
    </div>

    <div id="ov-drip" class="dash-card" style="margin-bottom:16px;">
      <div class="dash-card-title" style="color:#3b82f6;"><i class="ti ti-send"></i>Drip Campaign Contacts
        <span style="margin-left:8px;font-size:11px;font-weight:700;background:rgba(59,130,246,0.12);color:#3b82f6;padding:2px 8px;border-radius:10px;">${dripContacts.length}</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);line-height:1.7;padding:10px 12px;background:var(--surface-1);border-radius:8px;border-left:3px solid #3b82f6;margin-bottom:${dripContacts.length > 0 ? '14px' : '0'};">
        <strong style="color:var(--text-primary);">Goal: Indefinite drip until opt-out.</strong>
        These contacts completed the main 4-email sequence. They should continue receiving drip content indefinitely.
        If you are running low on drip emails, this count is your signal to write more.
        <button class="btn btn-outline btn-sm" style="margin-left:10px;" onclick="showPage('campaigns')"><i class="ti ti-send"></i> Manage Drip Content</button>
      </div>
      ${dripContacts.length === 0
        ? '<div style="padding:8px 0 4px;font-size:13px;color:var(--text-muted);text-align:center;">No contacts in drip campaign yet.</div>'
        : dripContacts.slice(0, 10).map(function(c) {
            return '<div class="action-item" style="border:0.5px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:6px;">'
              + '<div class="action-item-info">'
              + '<div class="action-item-name" style="cursor:pointer;font-size:13px;" onclick="viewContact(\'' + c.id + '\')">' + (c.name || '(no name)') + '</div>'
              + '<div class="action-item-sub">' + (c.type || '—')
              + (isOwner && c.agent_id ? ' &middot; ' + agentLabel(c.agent_id) : '')
              + '</div></div>'
              + '<button class="btn btn-outline btn-sm" onclick="viewContact(\'' + c.id + '\')"><i class="ti ti-eye"></i></button>'
              + '</div>';
          }).join('')
          + (dripContacts.length > 10 ? '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px 0;">+ ' + (dripContacts.length - 10) + ' more in drip campaign</div>' : '')
      }
    </div>

    <div id="ov-deals" class="dash-card" style="margin-bottom:16px;">
      <div class="dash-card-title" style="color:#8b5cf6;"><i class="ti ti-layout-kanban"></i>Stalled Pipeline Deals
        <span style="margin-left:8px;font-size:11px;font-weight:700;background:rgba(139,92,246,0.12);color:#8b5cf6;padding:2px 8px;border-radius:10px;">${stalledDeals.length}</span>
        <span style="margin-left:6px;font-size:11px;font-weight:400;color:var(--text-muted);">(no activity in ${STALE_DEAL_DAYS}+ days)</span>
      </div>
      ${stalledDeals.length === 0
        ? '<div style="padding:16px 0;font-size:13px;color:var(--text-muted);text-align:center;">No stalled pipeline deals &#10003;</div>'
        : stalledDeals.map(function(d) {
            var lastAct = actByDeal[d.id] || d.created_at;
            var stale = daysSince(lastAct);
            var pName = (PIPELINES[d.pipeline] && PIPELINES[d.pipeline].name) || d.pipeline || '—';
            var contact = contacts.find(function(c) { return c.id === d.contact_id; });
            return '<div class="action-item" style="border:0.5px solid #e9d5ff;border-radius:8px;padding:10px 14px;margin-bottom:8px;background:rgba(139,92,246,0.02);">'
              + '<div class="action-item-info">'
              + '<div class="action-item-name" style="cursor:pointer;display:flex;align-items:center;gap:8px;" onclick="showPage(\'pipelines\')">'
              + (d.title || '(untitled deal)')
              + '<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:rgba(139,92,246,0.12);color:#8b5cf6;">' + (d.stage || '—') + '</span>'
              + '</div>'
              + '<div class="action-item-sub" style="margin-top:3px;">'
              + pName
              + (contact ? ' &middot; ' + contact.name : '')
              + ' &middot; Last activity: <strong style="color:#8b5cf6;">' + daysLabel(stale) + '</strong>'
              + (d.value ? ' &middot; $' + parseFloat(d.value).toLocaleString() : '')
              + '</div></div>'
              + '<button class="btn btn-outline btn-sm" onclick="showPage(\'pipelines\')"><i class="ti ti-layout-kanban"></i> Pipeline</button>'
              + '</div>';
          }).join('')
      }
    </div>
  `;
}

// ============================================================
// APPOINTMENTS — CALENDAR
// ============================================================
const CAL_STATUS = {
  pending:     { bg:'rgba(251,191,36,0.18)',  border:'#d97706', dot:'#d97706',  label:'Pending'     },
  scheduled:   { bg:'rgba(52,211,153,0.18)',  border:'#10b981', dot:'#10b981',  label:'Scheduled'   },
  completed:   { bg:'rgba(156,163,175,0.12)', border:'#6b7280', dot:'#6b7280',  label:'Completed'   },
  cancelled:   { bg:'rgba(248,113,113,0.18)', border:'#ef4444', dot:'#ef4444',  label:'Cancelled'   },
  no_show:     { bg:'rgba(156,163,175,0.12)', border:'#9ca3af', dot:'#9ca3af',  label:'No-show'     },
  rescheduled: { bg:'rgba(139,92,246,0.18)',  border:'#8b5cf6', dot:'#8b5cf6',  label:'Rescheduled' },
};

function _calStatus(s) { return CAL_STATUS[s||'pending'] || CAL_STATUS.pending; }
function _calDateKey(dt) { const d=new Date(dt); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function _calTodayKey() { return _calDateKey(new Date()); }

async function renderAppointments() {
  const pg = document.getElementById('page-appointments');
  if (!pg) return;
  pg.innerHTML = `<div style="color:var(--text-muted);padding:40px;text-align:center;"><i class="ti ti-loader" style="font-size:24px;"></i> Loading...</div>`;

  let q = supabaseClient.from('booking_intents').select('*').neq('status','cancelled');
  const role = previewRole || currentAgent.role;
  if (role === 'agent') {
    q = q.eq('agent_id', currentAgent.id);
  } else if (role === 'agency_owner') {
    const ids = [...new Set([currentAgent.id, ...allAgents.filter(a=>a.agency_id===currentAgent.agency_id).map(a=>a.id)])];
    q = q.in('agent_id', ids);
  }
  const { data, error } = await q.order('scheduled_at',{ascending:true}).limit(500);
  if (error) { pg.innerHTML = `<div style="color:var(--danger);padding:40px;">${error.message}</div>`; return; }
  calAppointments = data || [];
  loadNeedsAttention();
  _calRenderShell(pg);
  _calRenderView();
}

function _calRenderShell(pg) {
  pg.innerHTML = `
    <div id="cal-pending"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="calNav(-1)" style="width:30px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;"><i class="ti ti-chevron-left"></i></button>
        <div id="cal-title" style="font-size:16px;font-weight:700;color:var(--text-primary);min-width:190px;text-align:center;"></div>
        <button class="btn btn-outline btn-sm" onclick="calNav(1)" style="width:30px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;"><i class="ti ti-chevron-right"></i></button>
        <button class="btn btn-outline btn-sm" onclick="calGoToday()" style="font-size:11px;">Today</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <div style="display:flex;background:var(--surface-0);border:0.5px solid var(--border);border-radius:8px;padding:2px;gap:2px;">
          <button id="cal-v-day"   onclick="calSwitchView('day')"   style="padding:4px 12px;border-radius:6px;font-size:12px;border:none;cursor:pointer;font-weight:500;transition:all .15s;">Day</button>
          <button id="cal-v-week"  onclick="calSwitchView('week')"  style="padding:4px 12px;border-radius:6px;font-size:12px;border:none;cursor:pointer;font-weight:500;transition:all .15s;">Week</button>
          <button id="cal-v-month" onclick="calSwitchView('month')" style="padding:4px 12px;border-radius:6px;font-size:12px;border:none;cursor:pointer;font-weight:500;transition:all .15s;">Month</button>
        </div>
        <button class="btn btn-accent btn-sm" onclick="apptLog()"><i class="ti ti-plus"></i> Add</button>
      </div>
    </div>
    <div id="cal-body" style="min-height:500px;"></div>`;
}

function _calUpdateViewBtns() {
  ['day','week','month'].forEach(v => {
    const el = document.getElementById('cal-v-'+v);
    if (!el) return;
    if (v === calView) {
      el.style.background = 'var(--surface-2)';
      el.style.color = 'var(--text-primary)';
    } else {
      el.style.background = 'none';
      el.style.color = 'var(--text-muted)';
    }
  });
}

function _calRenderView() {
  _calUpdateViewBtns();
  _calPending(); // always render pending strip first (appears above calendar)
  if (calView === 'month') _calMonth();
  else if (calView === 'week') _calWeek();
  else _calDay();
}

// ── MONTH VIEW ──
function _calMonth() {
  const titleEl = document.getElementById('cal-title');
  const body    = document.getElementById('cal-body');
  if (!titleEl || !body) return;

  const yr = calDate.getFullYear(), mo = calDate.getMonth();
  titleEl.textContent = new Date(yr,mo,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});

  const today     = _calTodayKey();
  const firstDay  = new Date(yr,mo,1).getDay(); // 0=Sun
  const daysInMo  = new Date(yr,mo+1,0).getDate();
  const daysInPrev= new Date(yr,mo,0).getDate();

  // Build lookup: dateKey → appointments
  const byDate = {};
  calAppointments.forEach(a => {
    if (!a.scheduled_at) return;
    const k = _calDateKey(a.scheduled_at);
    if (!byDate[k]) byDate[k] = [];
    byDate[k].push(a);
  });

  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let cells = '';
  const totalCells = Math.ceil((firstDay + daysInMo) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    let day, dateKey, isCurrentMo = true;
    if (i < firstDay) {
      day = daysInPrev - firstDay + 1 + i;
      dateKey = `${yr}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if (mo === 0) dateKey = `${yr-1}-12-${String(day).padStart(2,'0')}`;
      isCurrentMo = false;
    } else if (i >= firstDay + daysInMo) {
      day = i - firstDay - daysInMo + 1;
      dateKey = `${yr}-${String(mo+2).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if (mo === 11) dateKey = `${yr+1}-01-${String(day).padStart(2,'0')}`;
      isCurrentMo = false;
    } else {
      day = i - firstDay + 1;
      dateKey = `${yr}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }

    const isToday = dateKey === today;
    const dayAppts = byDate[dateKey] || [];

    const chips = dayAppts.slice(0,3).map(a => {
      const st = _calStatus(a.status);
      const _isPb = !a.contact_id || a.duration_minutes === 1440;
      const name = _isPb ? (a.appointment_label || a.appointment_type || 'Personal Block') : (a.appointment_type || 'Appointment');
      const nameTip = _isPb ? '' : (a.booker_name || a.contact_name || '').replace(/"/g,'&quot;');
      const stc = (a.cohost_agent_id && a.cohost_agent_id===(currentAgent&&currentAgent.id) && a.cohost_status==='confirmed') ? {bg:'rgba(56,189,248,0.15)',border:'#38bdf8'} : _isPb ? {bg:'rgba(139,92,246,0.18)',border:'#8b5cf6'} : st;
      const time = a.scheduled_at ? new Date(a.scheduled_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
      return `<div title="${nameTip}" onclick="event.stopPropagation();apptDetail('${a.id}')" draggable="true" ondragstart="event.stopPropagation();event.dataTransfer.setData('text/plain','${a.id}');event.dataTransfer.effectAllowed='move';" style="font-size:10px;padding:2px 5px;border-radius:3px;background:${stc.bg};border-left:2px solid ${stc.border};color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:grab;margin-bottom:2px;">${time ? time+' ' : ''}${name}</div>`;
    }).join('');
    const more = dayAppts.length > 3 ? `<div style="font-size:10px;color:var(--text-muted);padding-left:4px;">+${dayAppts.length-3} more</div>` : '';

    cells += `<div onclick="calDayClick('${dateKey}')" ondragover="event.preventDefault();this.style.outline='2px solid #8b5cf6';this.style.outlineOffset='-2px';" ondragleave="this.style.outline='';" ondrop="calDrop(event,'month','${dateKey}');this.style.outline='';" style="min-height:90px;padding:6px;border-right:0.5px solid var(--border);border-bottom:0.5px solid var(--border);cursor:pointer;background:${isToday ? 'rgba(200,168,75,0.08)' : 'transparent'};transition:background .1s;" onmouseover="this.style.background='${isToday ? 'rgba(200,168,75,0.12)' : 'var(--surface-1)'}'" onmouseout="this.style.background='${isToday ? 'rgba(200,168,75,0.08)' : 'transparent'}'">
      <div style="font-size:13px;font-weight:${isToday?'700':'500'};color:${!isCurrentMo?'var(--text-muted)':isToday?'var(--text-accent)':'var(--text-primary)'};${isToday?'width:24px;height:24px;background:var(--fill-accent);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#000;font-size:12px;margin-bottom:4px;':''}">${day}</div>
      <div>${chips}${more}</div>
    </div>`;
  }

  body.innerHTML = `
    <div style="border:0.5px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--surface-1);border-bottom:0.5px solid var(--border);">
        ${DOW.map(d=>`<div style="padding:8px;text-align:center;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">${d}</div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);">${cells}</div>
    </div>`;
}

// ── WEEK VIEW ──
function _calWeek() {
  const titleEl = document.getElementById('cal-title');
  const body    = document.getElementById('cal-body');
  if (!titleEl || !body) return;

  // Get Sunday of current week
  const d = new Date(calDate);
  d.setDate(d.getDate() - d.getDay());
  const weekDays = Array.from({length:7},(_,i) => { const x=new Date(d); x.setDate(d.getDate()+i); return x; });

  const today = _calTodayKey();
  const startStr = weekDays[0].toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const endStr   = weekDays[6].toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  titleEl.textContent = `${startStr} — ${endStr}`;

  const byDate = {};
  calAppointments.forEach(a => {
    if (!a.scheduled_at) return;
    const k = _calDateKey(a.scheduled_at);
    if (!byDate[k]) byDate[k] = [];
    byDate[k].push(a);
  });

  const HOURS = Array.from({length:14},(_,i)=>i+7); // 7am–8pm

  const cols = weekDays.map(wd => {
    const dk = _calDateKey(wd);
    const isToday = dk === today;
    const dayAppts = (byDate[dk]||[]);

    // Position events by hour (side-by-side columns for overlaps)
    const eventBlocks = _calLayoutAppts(dayAppts).map(a => {
      const dt = new Date(a.scheduled_at);
      const hr = dt.getHours(), mn = dt.getMinutes();
      const top = Math.max(0,(hr-7)*56 + Math.round(mn/60*56));
      const st = _calStatus(a.status);
      const stc = (a.cohost_agent_id && a.cohost_agent_id===(currentAgent&&currentAgent.id) && a.cohost_status==='confirmed') ? {bg:'rgba(56,189,248,0.15)',border:'#38bdf8'} : (!a.contact_id || a.duration_minutes === 1440) ? {bg:'rgba(139,92,246,0.18)',border:'#8b5cf6'} : st;
      const _isPbW = !a.contact_id || a.duration_minutes === 1440;
      const name = _isPbW ? (a.appointment_label || a.appointment_type || 'Personal Block') : (a.appointment_type || 'Appt');
      const nameTipW = _isPbW ? '' : (a.booker_name || a.contact_name || '').replace(/"/g,'&quot;');
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      const isAllDay = a.duration_minutes === 1440;
        const timeDiv = isAllDay ? '' : '<div style="font-size:9px;color:var(--text-muted);">' + timeStr + '</div>';
        const blockH = isAllDay ? 22 : Math.max(24, Math.round((a.duration_minutes||30)/60*56));
        const blockTop = isAllDay ? 2 : top;
      return `<div title="${nameTipW}" onclick="apptDetail('${a.id}')" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${a.id}');event.dataTransfer.effectAllowed='move';" style="position:absolute;left:calc(${a._col}/${a._totalCols}*100% + 2px);width:calc(100%/${a._totalCols} - ${a._totalCols>1?3:4}px);top:${blockTop}px;height:${blockH}px;background:${stc.bg};border-left:3px solid ${stc.border};border-radius:4px;padding:${isAllDay?'2px 5px':'3px 5px'};cursor:grab;overflow:hidden;z-index:${isAllDay?2:1};">
        <div style="font-size:10px;font-weight:600;color:var(--text-primary);line-height:1.2;">${name}${isAllDay?' — All Day':''}</div>
        ${timeDiv}
      </div>`;
    }).join('');

    const dow = wd.toLocaleDateString('en-US',{weekday:'short'});
    const dom = wd.getDate();
    return `<div style="flex:1;min-width:0;border-right:0.5px solid var(--border);">
      <div style="padding:8px 4px;text-align:center;background:${isToday?'rgba(200,168,75,0.1)':'var(--surface-1)'};border-bottom:0.5px solid var(--border);position:sticky;top:0;z-index:2;">
        <div style="font-size:10px;font-weight:600;color:${isToday?'var(--text-accent)':'var(--text-muted)'};text-transform:uppercase;letter-spacing:0.4px;">${dow}</div>
        <div style="font-size:${isToday?'18px':'14px'};font-weight:700;color:${isToday?'var(--text-accent)':'var(--text-primary)'};">${dom}</div>
      </div>
      <div ondragover="event.preventDefault();this.style.background='rgba(139,92,246,0.05)';" ondragleave="this.style.background='';" ondrop="calDrop(event,'week','${dk}');this.style.background='';" style="position:relative;height:${14*56}px;">${eventBlocks}</div>
    </div>`;
  }).join('');

  const timeCol = HOURS.map(h=>{
    const label = h===12?'12pm':h>12?`${h-12}pm`:`${h}am`;
    return `<div style="height:56px;padding-right:8px;text-align:right;font-size:10px;color:var(--text-muted);line-height:1;padding-top:4px;border-bottom:0.5px solid var(--border);">${label}</div>`;
  }).join('');

  const gridLines = HOURS.map(()=>`<div style="height:56px;border-bottom:0.5px solid var(--border);grid-column:1/-1;pointer-events:none;"></div>`).join('');

  body.innerHTML = `
    <div style="border:0.5px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="display:flex;">
        <div style="width:44px;flex-shrink:0;border-right:0.5px solid var(--border);">
          <div style="height:49px;border-bottom:0.5px solid var(--border);"></div>
          <div>${timeCol}</div>
        </div>
        <div style="flex:1;display:flex;min-width:0;overflow-x:auto;">${cols}</div>
      </div>
    </div>`;
}

// ── DAY VIEW ──
function _calLayoutAppts(appts) {
  // Separate all-day from timed events
  const allDay = appts.filter(a => a.duration_minutes === 1440)
    .map(a => ({...a, _col:0, _totalCols:1}));
  const timed  = appts.filter(a => a.duration_minutes !== 1440)
    .map(a => ({...a}));
  // Sort timed by start time
  timed.sort((a,b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  // Assign each event to the first lane where it doesn't overlap
  const lanes = []; // lanes[i] = end-timestamp of last event in lane i
  timed.forEach(a => {
    const start = new Date(a.scheduled_at).getTime();
    const end   = start + (a.duration_minutes||30) * 60000;
    a._start = start; a._end = end;
    let col = 0;
    while (lanes[col] !== undefined && lanes[col] > start) col++;
    lanes[col] = end;
    a._col = col;
  });
  // For each event, count total lanes needed in its overlap cluster
  timed.forEach(a => {
    const overlapping = timed.filter(b => b._start < a._end && b._end > a._start);
    a._totalCols = Math.max(...overlapping.map(b => b._col)) + 1;
  });
  return [...allDay, ...timed];
}

async function calDrop(event, view, dateStr) {
  event.preventDefault();
  const id = event.dataTransfer.getData('text/plain');
  if (!id) return;
  const appt = calAppointments.find(a => a.id === id);
  if (!appt) return;
  const origDt  = appt.scheduled_at ? new Date(appt.scheduled_at) : new Date();
  const isAllDay = appt.duration_minutes === 1440;
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  let newDt;
  if (isAllDay || view === 'month') {
    // Keep time of day, just move to new date (All Day → midnight)
    newDt = new Date(origDt);
    newDt.setFullYear(yr); newDt.setMonth(mo-1); newDt.setDate(dy);
    if (isAllDay) newDt.setHours(0,0,0,0);
  } else {
    // week / day: derive time from drop Y position
    const pxPerHour = view === 'week' ? 56 : 64;
    const rect      = event.currentTarget.getBoundingClientRect();
    const rawY      = Math.max(0, event.clientY - rect.top);
    const hourFrac  = rawY / pxPerHour + 7;
    const hour      = Math.min(21, Math.max(7, Math.floor(hourFrac)));
    const minute    = Math.min(45, Math.max(0, Math.round((hourFrac - hour) * 60 / 15) * 15));
    newDt = new Date(yr, mo-1, dy, hour, minute, 0, 0);
  }
  const newScheduledAt = newDt.toISOString();
  if (newScheduledAt === appt.scheduled_at) return;
  const { error } = await supabaseClient.from('booking_intents')
    .update({ scheduled_at: newScheduledAt }).eq('id', id);
  if (error) { showToast('Error: ' + error.message); return; }
  const idx = calAppointments.findIndex(a => a.id === id);
  if (idx >= 0) calAppointments[idx].scheduled_at = newScheduledAt;
  calDate = newDt;
  _calRenderView();
  showToast('✓ Appointment moved!');
}

function _calDay() {
  const titleEl = document.getElementById('cal-title');
  const body    = document.getElementById('cal-body');
  if (!titleEl || !body) return;

  const today   = _calTodayKey();
  const dateKey = _calDateKey(calDate);
  const isToday = dateKey === today;
  titleEl.textContent = calDate.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  const dayAppts = calAppointments.filter(a => a.scheduled_at && _calDateKey(a.scheduled_at)===dateKey);
  const HOURS = Array.from({length:14},(_,i)=>i+7);

  // Side-by-side columns for overlapping events
  const eventBlocks = _calLayoutAppts(dayAppts).map(a => {
    const dt = new Date(a.scheduled_at);
    const hr = dt.getHours(), mn = dt.getMinutes();
    const top = Math.max(0,(hr-7)*64 + Math.round(mn/60*64));
    const st = _calStatus(a.status);
    const _isPbDv = !a.contact_id || a.duration_minutes === 1440;
    const name = _isPbDv ? (a.appointment_label || a.appointment_type || 'Personal Block') : (a.appointment_type || 'Appointment');
    const nameTipDv = _isPbDv ? '' : (a.booker_name || a.contact_name || '').replace(/"/g,'&quot;');
    const isAllDay = a.duration_minutes === 1440;
    const stc = (a.cohost_agent_id && a.cohost_agent_id===(currentAgent&&currentAgent.id) && a.cohost_status==='confirmed') ? {bg:'rgba(56,189,248,0.15)',border:'#38bdf8'} : _isPbDv ? {bg:'rgba(139,92,246,0.18)',border:'#8b5cf6'} : st;
    const timeStr = isAllDay ? 'All Day' : dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    const _who = _isPbDv ? '' : (a.booker_name || a.contact_name || '');
    const typeDiv = isAllDay ? '' : '<div style="font-size:11px;color:var(--text-muted);">' + (timeStr + (_who ? '  |  '+_who : '')) + '</div>';
    const agentRow = allAgents.find(x=>x.id===a.agent_id);
    return `<div title="${nameTipDv}" onclick="apptDetail('${a.id}')" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${a.id}');event.dataTransfer.effectAllowed='move';" style="position:absolute;left:calc(${a._col}/${a._totalCols}*100% + 4px);width:calc(100%/${a._totalCols} - ${a._totalCols>1?6:8}px);top:${top}px;height:${isAllDay?28:58}px;background:${stc.bg};border-left:4px solid ${stc.border};border-radius:6px;padding:5px 10px;cursor:grab;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${name}${isAllDay?' — All Day':''}</div>
      ${typeDiv}
      ${agentRow && (previewRole||currentAgent.role)!=='agent' ? `<div style="font-size:10px;color:var(--text-muted);">${agentRow.name}</div>` : ''}
    </div>`;
  }).join('');

  const timeCol = HOURS.map(h=>{
    const label = h===12?'12pm':h>12?`${h-12}pm`:`${h}am`;
    return `<div style="height:64px;padding-right:10px;text-align:right;font-size:11px;color:var(--text-muted);line-height:1;padding-top:5px;border-bottom:0.5px solid var(--border);">${label}</div>`;
  }).join('');

  const noAppts = dayAppts.length === 0 ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--text-muted);pointer-events:none;"><i class="ti ti-calendar" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.3;"></i><div style="font-size:13px;">No appointments</div></div>` : '';

  body.innerHTML = `
    <div style="border:0.5px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="padding:10px 16px;background:${isToday?'rgba(200,168,75,0.08)':'var(--surface-1)'};border-bottom:0.5px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:13px;font-weight:600;color:${isToday?'var(--text-accent)':'var(--text-primary)'};">${isToday?'Today — ':''}${calDate.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
        <div style="font-size:12px;color:var(--text-muted);">${dayAppts.length} appointme        <div style="font-size:12px;color:var(--text-muted);">${dayAppts.length} appointment${dayAppts.length!==1?'s':''}</div>
      </div>
      <div style="display:flex;">
        <div style="width:52px;flex-shrink:0;border-right:0.5px solid var(--border);">${timeCol}</div>
        <div ondragover="event.preventDefault();this.style.background='rgba(139,92,246,0.04)';" ondragleave="this.style.background='';" ondrop="calDrop(event,'day','${dateKey}');this.style.background='';" style="flex:1;position:relative;min-height:${14*64}px;">${noAppts}${eventBlocks}</div>
      </div>
    </div>`;
}

function _calPending() {
  const el = document.getElementById('cal-pending');
  if (!el) return;
  const html = _buildNeedsAttentionHTML();
  if (!html) { el.innerHTML = ''; el.style.marginBottom = '0'; return; }
  el.style.marginBottom = '14px';
  el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// NEEDS ATTENTION — unified loader + renderer
// ─────────────────────────────────────────────────────────────
async function loadNeedsAttention() {
  if (!currentAgent) return;
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Unread reply / complaint activities owned by this agent
    const { data: acts } = await supabaseClient
      .from('activities')
      .select('id,contact_id,activity_type,subject,body_snippet,created_at')
      .in('activity_type', ['email_replied', 'email_complained'])
      .is('read_at', null)
      .eq('agent_id', currentAgent.id)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(20);

    // 2. No-show and prospect-cancelled booking_intents
    const { data: appts } = await supabaseClient
      .from('booking_intents')
      .select('id,contact_id,contact_name,company,appointment_label,appointment_type,scheduled_at,status,rescheduled_by,created_at')
      .eq('agent_id', currentAgent.id)
      .in('status', ['no_show', 'Cancelled', 'cancelled'])
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(10);

    naItems = [
      ...(acts || []).map(a => ({ kind: a.activity_type, activityId: a.id, contactId: a.contact_id, subject: a.subject, snippet: a.body_snippet, createdAt: a.created_at })),
      ...(appts || []).filter(a => a.status === 'no_show' || ((a.status === 'Cancelled' || a.status === 'cancelled') && a.rescheduled_by === 'prospect'))
        .map(a => ({ kind: a.status === 'no_show' ? 'meeting_no_show' : 'meeting_canceled', bookingId: a.id, contactId: a.contact_id, contactName: a.contact_name, company: a.company, apptLabel: a.appointment_label || a.appointment_type || 'Appointment', scheduledAt: a.scheduled_at, createdAt: a.created_at }))
    ];

    _refreshNeedsAttentionUI();
  } catch(e) { console.error('loadNeedsAttention:', e); }
}

function _refreshNeedsAttentionUI() {
  // Dashboard
  const dashDiv = document.getElementById('dash-needs-attention');
  if (dashDiv) dashDiv.innerHTML = _buildNeedsAttentionHTML();
  // Calendar pending strip
  const calDiv = document.getElementById('cal-pending');
  if (calDiv) {
    const html = _buildNeedsAttentionHTML();
    calDiv.innerHTML = html || '';
    calDiv.style.marginBottom = html ? '14px' : '0';
  }
}

async function naDismissActivity(activityId) {
  await supabaseClient.from('activities').update({ read_at: new Date().toISOString() }).eq('id', activityId);
  naItems = naItems.filter(x => x.activityId !== activityId);
  _refreshNeedsAttentionUI();
}

async function naReengage(bookingId) {
  // Mark no_show / cancelled as "seen" by setting a dismissed note, then open contact
  const item = naItems.find(x => x.bookingId === bookingId);
  await supabaseClient.from('booking_intents').update({ agent_notes: (item && item.apptLabel ? '[Re-engaged after ' + (item.kind === 'meeting_no_show' ? 'no-show' : 'cancellation') + ']' : '[Re-engaged]') }).eq('id', bookingId);
  naItems = naItems.filter(x => x.bookingId !== bookingId);
  _refreshNeedsAttentionUI();
  if (item && item.contactId) {
    const c = contacts.find(x => x.id === item.contactId);
    if (c) viewContact(c.id);
  }
}

function _buildNeedsAttentionHTML() {
  // Combine: pending booking_intents (from calAppointments) + naItems
  const pending = (calAppointments || []).filter(a => !a.status || a.status === 'pending' || a.status === 'rescheduled');
  const total = pending.length + naItems.length;
  if (total === 0) return '';

  const hasUrgent = naItems.some(x => x.kind === 'email_complained');
  const headerColor = hasUrgent ? '#ef4444' : '#d97706';
  const headerBg    = hasUrgent ? 'rgba(239,68,68,0.05)' : 'rgba(251,191,36,0.05)';
  const headerBord  = hasUrgent ? 'rgba(239,68,68,0.3)'  : 'rgba(217,119,6,0.3)';

  const pendingCards = pending.map(a => {
    const name = a.booker_name || a.contact_name || '—';
    const received = new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let badge = '', borderColor = '#d97706', btnLabel = '📋 Schedule';
    if (a.status === 'rescheduled' && a.rescheduled_by === 'agent') {
      badge = `<div style="font-size:10px;background:rgba(234,179,8,0.15);color:#b45309;border-radius:4px;padding:2px 6px;margin-bottom:5px;font-weight:600;">⚠ Awaiting prospect confirm</div>`;
      borderColor = '#d97706'; btnLabel = '📋 Update';
    } else if (a.status === 'rescheduled' && a.rescheduled_by === 'prospect') {
      badge = `<div style="font-size:10px;background:rgba(139,92,246,0.15);color:#7c3aed;border-radius:4px;padding:2px 6px;margin-bottom:5px;font-weight:600;">🔄 Prospect requested reschedule</div>`;
      borderColor = '#8b5cf6'; btnLabel = '📋 New Time';
    }
    const proposedTime = a.scheduled_at && a.status === 'rescheduled'
      ? `<div style="font-size:11px;color:var(--text-primary);font-weight:500;margin-bottom:5px;">📅 ${new Date(a.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>` : '';
    return `<div style="flex-shrink:0;width:220px;background:var(--surface-1);border:0.5px solid var(--border);border-left:3px solid ${borderColor};border-radius:8px;padding:9px 11px;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:${borderColor};margin-bottom:4px;">📅 Appointment</div>
      ${badge}
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
      ${a.company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.company}</div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${a.appointment_label || a.appointment_type || 'Appointment'} · ${received}</div>
      ${proposedTime}
      <div style="display:flex;gap:4px;margin-top:6px;">
        <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="apptSchedule('${a.id}')">${btnLabel}</button>
        <button class="btn btn-danger btn-sm" style="font-size:11px;padding:3px 8px;" onclick="apptCancel('${a.id}')">✕</button>
      </div>
    </div>`;
  }).join('');

  const naCards = naItems.map(item => {
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const contact = contacts.find(x => x.id === item.contactId);
    const name = (contact && contact.name) || item.contactName || 'Unknown Contact';
    const company = (contact && contact.company) || item.company || '';
    const timeAgo = formatTimeAgo(item.createdAt);

    if (item.kind === 'email_replied') {
      return `<div style="flex-shrink:0;width:220px;background:var(--surface-1);border:0.5px solid var(--border);border-left:3px solid #34d399;border-radius:8px;padding:9px 11px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#34d399;margin-bottom:4px;">💬 Reply Received</div>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>
        ${company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(company)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">${timeAgo}</div>
        ${item.subject ? `<div style="font-size:11px;color:var(--text-secondary);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px;">${esc(item.subject)}</div>` : ''}
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn btn-primary btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="naDismissActivity('${item.activityId}');openCallScript('${item.contactId}')">📞 Call Now</button>
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;" onclick="naDismissActivity('${item.activityId}')">✓</button>
        </div>
      </div>`;
    }

    if (item.kind === 'email_complained') {
      return `<div style="flex-shrink:0;width:220px;background:rgba(239,68,68,0.04);border:0.5px solid rgba(239,68,68,0.3);border-left:3px solid #ef4444;border-radius:8px;padding:9px 11px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#ef4444;margin-bottom:4px;">🔥 Spam Complaint <span style="background:#ef4444;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:2px;">URGENT</span></div>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>
        ${company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(company)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${timeAgo}</div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn btn-danger btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="naDismissActivity('${item.activityId}');viewContact('${item.contactId}','')">👁 Review</button>
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;" onclick="naDismissActivity('${item.activityId}')">✓</button>
        </div>
      </div>`;
    }

    if (item.kind === 'meeting_no_show') {
      const apptDate = item.scheduledAt ? new Date(item.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      return `<div style="flex-shrink:0;width:220px;background:var(--surface-1);border:0.5px solid var(--border);border-left:3px solid #fbbf24;border-radius:8px;padding:9px 11px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#f59e0b;margin-bottom:4px;">👻 No-Show</div>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>
        ${company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(company)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${esc(item.apptLabel)}${apptDate ? ' · ' + apptDate : ''}</div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="naReengage('${item.bookingId}')">🔄 Re-engage</button>
        </div>
      </div>`;
    }

    if (item.kind === 'meeting_canceled') {
      const apptDate = item.scheduledAt ? new Date(item.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      return `<div style="flex-shrink:0;width:220px;background:var(--surface-1);border:0.5px solid var(--border);border-left:3px solid #fbbf24;border-radius:8px;padding:9px 11px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#f59e0b;margin-bottom:4px;">❌ Meeting Canceled</div>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>
        ${company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(company)}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${esc(item.apptLabel)}${apptDate ? ' · ' + apptDate : ''}</div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="naReengage('${item.bookingId}')">📅 Reschedule</button>
        </div>
      </div>`;
    }

    return '';
  }).join('');

  return `<div style="background:${headerBg};border:0.5px solid ${headerBord};border-radius:10px;padding:10px 14px;margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${headerColor};">⚠ Needs Attention</span>
      <span style="background:${hasUrgent ? 'rgba(239,68,68,0.18)' : 'rgba(217,119,6,0.18)'};color:${hasUrgent ? '#ef4444' : '#b45309'};border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;">${total}</span>
    </div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin;">
      ${naCards}${pendingCards}
    </div>
  </div>`;
}

// ── NAVIGATION ──
function calNav(dir) {
  const d = new Date(calDate);
  if (calView === 'month') { d.setMonth(d.getMonth() + dir); }
  else if (calView === 'week') { d.setDate(d.getDate() + dir*7); }
  else { d.setDate(d.getDate() + dir); }
  calDate = d;
  _calRenderView();
}
function calGoToday() { calDate = new Date(); _calRenderView(); }
function calSwitchView(v) { calView = v; _calRenderView(); }
function calDayClick(dateStr) { calDate = new Date(dateStr+'T12:00:00'); calSwitchView('day'); }

// ── APPOINTMENT DETAIL MODAL ──


// ── CO-HOST / ATTENDEE INVITE HELPERS ──────────────────────────────────────
// ── CO-HOST / ATTENDEE INVITE HELPERS ────────────────────────────────────────

function _inviteSectionHtml(existingCohostId, existingCohostEmail, existingCohostName, existingExtra, proposedAt, durationMin) {
  existingCohostId    = existingCohostId    || null;
  existingCohostEmail = existingCohostEmail || null;
  existingCohostName  = existingCohostName  || null;
  existingExtra       = existingExtra       || [];
  if (proposedAt)  window._inviteProposedAt  = proposedAt;
  if (durationMin) window._inviteProposedDuration = durationMin;
  var ca = currentAgent || {};
  var agencyAgents = (allAgents||[]).filter(function(a) {
    return a.id !== ca.id && (!ca.agency_id || a.agency_id === ca.agency_id);
  });
  var agentOpts = agencyAgents.map(function(a) {
    return '<option value="' + a.id + '" data-email="' + (a.email||'') + '" data-name="' + (a.name||'') + '"'
      + (a.id === existingCohostId ? ' selected' : '') + '>' + (a.name||'') + '</option>';
  }).join('');
  var extSelected = !!(existingCohostEmail && !agencyAgents.find(function(a) { return a.id === existingCohostId; }));
  var extraHtml = existingExtra.map(function(e, i) {
    return '<div class="_earow" id="_ear-' + i + '" style="display:flex;gap:4px;margin-bottom:4px;">'
      + '<input type="text" placeholder="Name" id="_ean-' + i + '" value="' + ((e.name||'').replace(/"/g,'&quot;')) + '" style="flex:1;min-width:0;padding:6px 8px;border:0.5px solid var(--border);border-radius:4px;background:var(--surface-0);color:var(--text-primary);font-size:12px;" />'
      + '<input type="email" placeholder="Email" id="_eae-' + i + '" value="' + ((e.email||'').replace(/"/g,'&quot;')) + '" style="flex:2;min-width:0;padding:6px 8px;border:0.5px solid var(--border);border-radius:4px;background:var(--surface-0);color:var(--text-primary);font-size:12px;" />'
      + '<button type="button" onclick="window._removeExtraAtt(' + i + ')" style="padding:4px 8px;border:0.5px solid var(--danger,#ef4444);background:transparent;color:var(--danger,#ef4444);border-radius:4px;cursor:pointer;font-size:13px;">&times;</button>'
      + '</div>';
  }).join('');
  window._extraAttCount = existingExtra.length;
  setTimeout(function() {
    ['sched-dt','appt-dt','appt-scheduled-at','appt-edit-dt','sched-duration','appt-duration','appt-edit-duration'].forEach(function(eid) {
      var ef = document.getElementById(eid);
      if (ef && !ef._cohostWatched) {
        ef._cohostWatched = true;
        ef.addEventListener('change', function() {
          var s = document.getElementById('_cohost-sel');
          if (s && s.value && s.value !== '__ext__') {
            var op = s.options[s.selectedIndex];
            _checkCohostAvail(s.value, op ? op.text : '');
          }
        });
      }
    });
  }, 200);
  var hasExisting = !!(existingCohostId || existingCohostEmail || existingExtra.length);
  return '<div style="margin-top:14px;border-top:0.5px solid var(--border);padding-top:12px;">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;padding:4px 0;" onclick="var b=document.getElementById(\'_inv-body\');var ic=document.getElementById(\'_inv-ic\');if(b){var op=b.style.display!==\'none\';b.style.display=op?\'none\':\'\';ic.textContent=op?\'expand\':\'collapse\';}">'
    + '<span style="font-size:12px;font-weight:600;color:var(--text-secondary);">Invite Attendees</span>'
    + '<span id="_inv-ic" style="font-size:11px;color:var(--text-muted);">' + (hasExisting ? 'collapse' : 'expand') + '</span>'
    + '</div>'
    + '<div id="_inv-body" style="' + (hasExisting ? '' : 'display:none;') + 'margin-top:10px;">'
    + '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);">Co-host'
    + '<span style="font-weight:400;color:var(--text-muted);"> - gets invite email' + (agencyAgents.length ? ' + CRM calendar entry' : '') + '</span></label>'
    + '<select id="_cohost-sel" onchange="window._cohostSelChange(this)" style="width:100%;box-sizing:border-box;padding:7px 10px;border:0.5px solid var(--border);border-radius:6px;background:var(--surface-0);color:var(--text-primary);font-size:13px;margin-top:4px;">'
    + '<option value="">-- None --</option>'
    + agentOpts
    + '<option value="__ext__"' + (extSelected ? ' selected' : '') + '>Other (enter email)...</option>'
    + '</select>'
    + '<div id="_cohost-ext" style="margin-top:6px;' + (extSelected ? '' : 'display:none;') + '">'
    + '<input type="text" id="_cohost-ext-name" placeholder="Name" value="' + (extSelected ? (existingCohostName||'') : '') + '" style="width:100%;box-sizing:border-box;padding:6px 10px;border:0.5px solid var(--border);border-radius:6px;background:var(--surface-0);color:var(--text-primary);font-size:13px;margin-bottom:4px;" />'
    + '<input type="email" id="_cohost-ext-email" placeholder="Email address" value="' + (extSelected ? (existingCohostEmail||'') : '') + '" style="width:100%;box-sizing:border-box;padding:6px 10px;border:0.5px solid var(--border);border-radius:6px;background:var(--surface-0);color:var(--text-primary);font-size:13px;" />'
    + '</div>'
    + '<div id="_cohost-avail"></div>'
    + '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:12px;display:block;">Additional Attendees'
    + '<span style="font-weight:400;color:var(--text-muted);"> - any email, all get invite</span></label>'
    + '<div id="_ear-list" style="margin-top:6px;">' + extraHtml + '</div>'
    + '<button type="button" onclick="window._addExtraAtt()" style="margin-top:4px;padding:5px 12px;border:0.5px solid var(--border);background:var(--surface-1);border-radius:4px;cursor:pointer;font-size:12px;color:var(--text-secondary);">+ Add Attendee</button>'
    + '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface-0);border-radius:6px;border:0.5px solid var(--border);">'
    + '<input type="checkbox" id="_inv-send" checked style="width:14px;height:14px;cursor:pointer;" />'
    + '<label for="_inv-send" style="font-size:12px;margin:0;cursor:pointer;color:var(--text-primary);">Send invitation emails to all invitees</label>'
    + '</div>'
    + '</div>'
    + '</div>';
}

window._cohostSelChange = function(sel) {
  var ext = document.getElementById('_cohost-ext');
  if (ext) ext.style.display = sel.value === '__ext__' ? '' : 'none';
  if (sel.value && sel.value !== '__ext__') {
    var op = sel.options[sel.selectedIndex];
    _checkCohostAvail(sel.value, op ? op.text : '');
  } else {
    var box = document.getElementById('_cohost-avail');
    if (box) box.innerHTML = '';
  }
};

window._addExtraAtt = function() {
  var list = document.getElementById('_ear-list');
  if (!list) return;
  var i = (window._extraAttCount || 0);
  window._extraAttCount = i + 1;
  var div = document.createElement('div');
  div.id = '_ear-' + i;
  div.className = '_earow';
  div.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;';
  div.innerHTML = '<input type="text" placeholder="Name" id="_ean-' + i + '" style="flex:1;min-width:0;padding:6px 8px;border:0.5px solid var(--border);border-radius:4px;background:var(--surface-0);color:var(--text-primary);font-size:12px;" />'
    + '<input type="email" placeholder="Email" id="_eae-' + i + '" style="flex:2;min-width:0;padding:6px 8px;border:0.5px solid var(--border);border-radius:4px;background:var(--surface-0);color:var(--text-primary);font-size:12px;" />'
    + '<button type="button" onclick="window._removeExtraAtt(' + i + ')" style="padding:4px 8px;border:0.5px solid var(--danger,#ef4444);background:transparent;color:var(--danger,#ef4444);border-radius:4px;cursor:pointer;font-size:13px;">&times;</button>';
  list.appendChild(div);
};

window._removeExtraAtt = function(i) {
  var el = document.getElementById('_ear-' + i);
  if (el) el.remove();
};

function _readInviteSection() {
  var sel = document.getElementById('_cohost-sel');
  var selVal = sel ? sel.value : '';
  var cohostAgentId = null, cohostEmail = null, cohostName = null;
  if (selVal && selVal !== '__ext__') {
    cohostAgentId = selVal;
    var opt = sel.options[sel.selectedIndex];
    cohostEmail = opt ? (opt.getAttribute('data-email') || '') : '';
    cohostName  = opt ? (opt.getAttribute('data-name')  || '') : '';
  } else if (selVal === '__ext__') {
    cohostName  = (document.getElementById('_cohost-ext-name')  ? document.getElementById('_cohost-ext-name').value.trim()  : '') || null;
    cohostEmail = (document.getElementById('_cohost-ext-email') ? document.getElementById('_cohost-ext-email').value.trim() : '') || null;
  }
  var rows = document.querySelectorAll('._earow');
  var extraAttendees = [];
  rows.forEach(function(row) {
    var idx = (row.id||'').replace('_ear-','');
    var nm  = document.getElementById('_ean-' + idx);
    var em  = document.getElementById('_eae-' + idx);
    var nmv = nm ? nm.value.trim() : '';
    var emv = em ? em.value.trim() : '';
    if (emv && emv.indexOf('@') > -1) extraAttendees.push({ name: nmv || emv.split('@')[0], email: emv });
  });
  var sendChk = document.getElementById('_inv-send');
  var sendEmail = sendChk ? sendChk.checked !== false : true;
  return { cohostAgentId: cohostAgentId, cohostEmail: cohostEmail, cohostName: cohostName, extraAttendees: extraAttendees, sendEmail: sendEmail };
}

async function _sendCohostInvites(bookingId, inv, apptDetails) {
  if (!inv || !inv.sendEmail) return;
  if (inv.cohostEmail) {
    try {
      var u = new URL(APPS_SCRIPT_URL);
      u.searchParams.set('action','invite_cohost');
      u.searchParams.set('booking_intent_id', bookingId);
      u.searchParams.set('cohost_email', inv.cohostEmail);
      u.searchParams.set('cohost_name',  inv.cohostName  || '');
      if (inv.cohostAgentId) u.searchParams.set('cohost_agent_id', inv.cohostAgentId);
      u.searchParams.set('agent_id',          currentAgent.id);
      u.searchParams.set('agent_name',         currentAgent.name||'');
      u.searchParams.set('contact_name',       apptDetails.contactName      || '');
      u.searchParams.set('appointment_type',   apptDetails.appointmentType  || '');
      u.searchParams.set('datetime_iso',       apptDetails.dateIso          || '');
      if (apptDetails.notes) u.searchParams.set('notes', apptDetails.notes);
      fetch(u.toString());
    } catch(e) {}
  }
  var extras = inv.extraAttendees || [];
  for (var ai = 0; ai < extras.length; ai++) {
    var at = extras[ai];
    try {
      var u2 = new URL(APPS_SCRIPT_URL);
      u2.searchParams.set('action','invite_attendee');
      u2.searchParams.set('booking_intent_id', bookingId);
      u2.searchParams.set('to',      at.email);
      u2.searchParams.set('to_name', at.name  || '');
      u2.searchParams.set('agent_id',          currentAgent.id);
      u2.searchParams.set('agent_name',         currentAgent.name||'');
      u2.searchParams.set('contact_name',       apptDetails.contactName     || '');
      u2.searchParams.set('appointment_type',   apptDetails.appointmentType || '');
      u2.searchParams.set('datetime_iso',       apptDetails.dateIso         || '');
      if (apptDetails.notes) u2.searchParams.set('notes', apptDetails.notes);
      fetch(u2.toString());
    } catch(e) {}
  }
}

// ── CO-HOST AVAILABILITY HELPERS ────────────────────────────────────────────
// ── CO-HOST AVAILABILITY HELPERS ─────────────────────────────────────────────

window._toggleCohostSched = function(id) {
  var s  = document.getElementById(id);
  var ic = document.getElementById(id + '-ic');
  if (!s) return;
  var nowHidden = s.style.display === 'none';
  s.style.display = nowHidden ? '' : 'none';
  if (ic) ic.textContent = nowHidden ? '▴' : '▾';
};

function _getProposedApptTime() {
  var ids = ['sched-dt', 'appt-dt', 'appt-scheduled-at', 'appt-edit-dt'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && el.value) {
      try { return new Date(el.value).toISOString(); } catch(e) {}
    }
  }
  return window._inviteProposedAt || null;
}

function _getProposedApptDuration() {
  var ids = ['sched-duration', 'appt-duration', 'appt-edit-duration'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && el.value) {
      var v = parseInt(el.value);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return 60;
}

async function _checkCohostAvail(agentId, agentName) {
  var box = document.getElementById('_cohost-avail');
  if (!box) return;
  if (!agentId || agentId === '__ext__') { box.innerHTML = ''; return; }
  var proposedAt  = _getProposedApptTime();
  var durationMin = _getProposedApptDuration();
  if (!proposedAt) {
    box.innerHTML = '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);padding:5px 8px;border:0.5px solid var(--border);border-radius:5px;">Set the appointment date &amp; time above to check availability</div>';
    return;
  }
  box.innerHTML = '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);padding:5px 8px;">Checking availability…</div>';
  var d  = new Date(proposedAt);
  var d0 = new Date(d.getTime() - 86400000).toISOString();
  var d1 = new Date(d.getTime() + 86400000).toISOString();
  try {
    var res = await supabaseClient
      .from('booking_intents')
      .select('id,scheduled_at,duration_minutes,appointment_label,appointment_type,booker_name,contact_name,status,agent_id,cohost_agent_id')
      .or('agent_id.eq.' + agentId + ',cohost_agent_id.eq.' + agentId)
      .gte('scheduled_at', d0)
      .lte('scheduled_at', d1)
      .in('status', ['scheduled', 'pending', 'rescheduled'])
      .order('scheduled_at');
    if (res.error) { box.innerHTML = ''; return; }
    var propStart = d.getTime();
    var propEnd   = propStart + (durationMin || 60) * 60000;
    var dayAppts  = res.data || [];
    var conflicts = dayAppts.filter(function(a) {
      if (!a.scheduled_at) return false;
      var dur = a.duration_minutes || 60;
      if (dur === 1440) return false;
      var aStart = new Date(a.scheduled_at).getTime();
      var aEnd   = aStart + dur * 60000;
      return aStart < propEnd && aEnd > propStart;
    });
    box.innerHTML = _cohostAvailHtml(conflicts, dayAppts, agentName || 'Co-host', proposedAt, durationMin);
  } catch(e) { box.innerHTML = ''; }
}

function _cohostFreeWindows(dayAppts, proposedDurationMin, refTime) {
  var dur = proposedDurationMin || 60;
  var ref = refTime ? new Date(refTime) : (dayAppts.length ? new Date(dayAppts[0].scheduled_at) : new Date());
  var dayStart = new Date(ref); dayStart.setHours(7,0,0,0);
  var dayEnd   = new Date(ref); dayEnd.setHours(19,0,0,0);
  var busy = dayAppts
    .filter(function(a) { return a.scheduled_at && a.duration_minutes !== 1440; })
    .map(function(a) {
      var s = new Date(a.scheduled_at).getTime();
      return { s: s, e: s + (a.duration_minutes || 60) * 60000 };
    })
    .sort(function(a, b) { return a.s - b.s; });
  var free = [], cursor = dayStart.getTime();
  busy.forEach(function(b) {
    if (b.s >= cursor + dur * 60000) free.push({ start: cursor, end: b.s });
    if (b.e > cursor) cursor = b.e;
  });
  if (dayEnd.getTime() >= cursor + dur * 60000) free.push({ start: cursor, end: dayEnd.getTime() });
  return free;
}

function _cohostAvailHtml(conflicts, dayAppts, agentName, proposedAt, durationMin) {
  var bdr  = conflicts.length ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.35)';
  var html = '<div style="margin-top:8px;border-radius:6px;border:0.5px solid ' + bdr + ';overflow:hidden;">';
  if (conflicts.length === 0) {
    html += '<div style="padding:7px 10px;background:rgba(34,197,94,0.07);display:flex;align-items:center;gap:6px;">'
      + '<span>✅</span>'
      + '<span style="font-size:12px;color:var(--text-primary);">' + agentName + ' is available</span>'
      + '</div>';
  } else {
    var cLines = conflicts.map(function(c) {
      var label = c.appointment_label || c.appointment_type || 'Appointment';
      var ts = new Date(c.scheduled_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return label + ' at ' + ts + ' (' + (c.duration_minutes || 60) + ' min)';
    }).join('; ');
    html += '<div style="padding:7px 10px;background:rgba(239,68,68,0.07);display:flex;align-items:flex-start;gap:6px;">'
      + '<span>⚠️</span>'
      + '<span style="font-size:12px;color:var(--text-primary);"><strong>Conflict:</strong> ' + agentName + ' has ' + cLines + '</span>'
      + '</div>';
    var fw = _cohostFreeWindows(dayAppts, durationMin, proposedAt);
    html += '<div style="padding:6px 10px;border-top:0.5px solid var(--border);">';
    if (fw.length > 0) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:3px;">Open windows this day:</div>';
      fw.slice(0, 5).forEach(function(w) {
        var s = new Date(w.start).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        var e = new Date(w.end).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        html += '<div style="font-size:11px;color:var(--text-primary);padding:1px 0;">\u2705 ' + s + ' \u2013 ' + e + '</div>';
      });
    } else {
      html += '<div style="font-size:11px;color:var(--text-muted);">No open windows 7 AM \u2013 7 PM</div>';
    }
    html += '</div>';
  }
  if (dayAppts.length > 0) {
    var sid = '_cs' + Date.now();
    html += '<div onclick="window._toggleCohostSched(\'' + sid + '\')" style="border-top:0.5px solid var(--border);padding:5px 10px;cursor:pointer;font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center;user-select:none;">'
      + '<span>' + agentName + '\'s schedule this day</span>'
      + '<span id="' + sid + '-ic">▾</span></div>'
      + '<div id="' + sid + '" style="display:none;padding:4px 10px 6px;border-top:0.5px solid var(--border);">';
    dayAppts.forEach(function(a) {
      var isC   = conflicts.some(function(c) { return c.id === a.id; });
      var label = a.appointment_label || a.appointment_type || 'Appointment';
      var who   = a.booker_name || a.contact_name || '';
      var ts    = new Date(a.scheduled_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      var dur   = a.duration_minutes || 60;
      html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;border-bottom:0.5px solid var(--border);color:' + (isC ? '#ef4444' : 'var(--text-primary)') + ';">'
        + '<span style="font-weight:600;min-width:52px;">' + ts + '</span>'
        + '<span style="flex:1;">' + label + (who ? ' · ' + who : '') + ' <span style="color:var(--text-muted);">(' + dur + 'm)</span></span>'
        + (isC ? '<span style="font-weight:700;font-size:10px;color:#ef4444;">CONFLICT</span>' : '')
        + '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}




// Google Calendar sync helper
async function _syncCalendarEvent(bookingId, apptData, calAction, existingEventId) {
  if (!currentAgent || !currentAgent.calendar_connected) return;
  try {
    var url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('action',     'calendar_sync');
    url.searchParams.set('agent_id',   currentAgent.id);
    url.searchParams.set('booking_id', bookingId);
    url.searchParams.set('cal_action', calAction);
    if (apptData)        url.searchParams.set('event_data', JSON.stringify(apptData));
    if (existingEventId) url.searchParams.set('event_id',   existingEventId);
    var resp = await fetch(url.toString());
    var json = await resp.json();
    if (json.event_id && calAction !== 'delete') {
      await supabaseClient.from('booking_intents')
        .update({ google_calendar_event_id: json.event_id })
        .eq('id', bookingId);
      // keep local copy in sync
      var idx = calAppointments.findIndex(function(a) { return a.id === bookingId; });
      if (idx >= 0) calAppointments[idx].google_calendar_event_id = json.event_id;
    }
  } catch(e) { console.warn('Calendar sync failed:', e); }
}

function apptDetail(id) {
  const a = calAppointments.find(x=>x.id===id);
  if (!a) return;
  const st = _calStatus(a.status);
  const agentRow = allAgents.find(x=>x.id===a.agent_id);
  const isPersonal = !a.contact_id;
  const isAllDayAppt = a.duration_minutes === 1440;
  const pad = n => String(n).padStart(2,'0');
  let defaultDt = '', defaultDateOnly = '';
  if (a.scheduled_at) {
    const d = new Date(a.scheduled_at);
    defaultDt = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    defaultDateOnly = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  const editLabel = (a.appointment_label||'').replace(/"/g,'&quot;');
  const editType  = (a.appointment_type||'').replace(/"/g,'&quot;');
  const APPT_TYPES = [
    'Discovery Call','Benefits Review','Benefits Presentation','Enrollment Meeting',
    'Needs Analysis','Policy Review','Follow-Up Call','Annual Review',
    'Group Benefits Overview','Recruiting Call','Onboarding Meeting','Claims Review'
  ];
  const typeIsKnown = APPT_TYPES.includes(a.appointment_type||'');
  const typeOptsHtml = APPT_TYPES.map(t =>
    `<option value="${t}"${a.appointment_type===t?' selected':''}>${t}</option>`
  ).join('') + `<option value="__other__"${!typeIsKnown&&(a.appointment_type||'')?` selected`:''}>Other (type your own)...</option>`;
  // Duration options — match apptLog exactly (no 20 min; full label text)
  const _dm = a.duration_minutes;
  const durOpts = [
    {v:15,l:'15 minutes'},{v:30,l:'30 minutes'},{v:45,l:'45 minutes'},
    {v:60,l:'1 hour'},{v:90,l:'1 hour 30 minutes'},{v:120,l:'2 hours'}
  ].map(o=>`<option value="${o.v}"${_dm===o.v?' selected':''}>${o.l}</option>`).join('')
   + `<option value="allday"${isAllDayAppt?' selected':''}>All Day</option>`;
  const title = isPersonal
    ? (a.appointment_label||'Personal Block')
    : (a.booker_name||a.contact_name||'Appointment');
  // apptDurationChange defined here so it works even if apptLog() hasn't run yet.
  // Restores original appointment time when switching allday → timed.
  const _origTime = defaultDt ? defaultDt.split('T')[1] : '09:00';
  window.apptDurationChange = function(val) {
    var dt = document.getElementById('appt-dt');
    var da = document.getElementById('appt-dt-allday');
    if (!dt || !da) return;
    if (val === 'allday') {
      da.value = dt.value ? dt.value.split('T')[0] : da.value;
      dt.style.display = 'none'; da.style.display = '';
    } else {
      var dateOnly = da.value || (dt.value ? dt.value.split('T')[0] : '');
      dt.value = dateOnly ? (dateOnly + 'T' + _origTime) : defaultDt;
      da.style.display = 'none'; dt.style.display = '';
    }
  };
  setTimeout(function() {
    ['appt-dt', 'appt-dt-allday'].forEach(function(eid) {
      var el = document.getElementById(eid);
      if (!el) return;
      el.addEventListener('change', function() {
        var orig = eid === 'appt-dt-allday' ? defaultDateOnly : defaultDt;
        if (this.value && this.value !== orig) {
          var cb = document.getElementById('appt-edit-resend');
          if (cb && !cb.checked) cb.checked = true;
        }
      });
    });
  }, 200);
  showModal(title, `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
      ${isPersonal
        ? `<span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:rgba(139,92,246,0.15);border:1px solid #8b5cf6;color:#7c3aed;">Personal Block</span>`
        : `<span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${st.bg};border:1px solid ${st.border};color:var(--text-primary);">${st.label}</span>`}
    </div>
    ${isPersonal ? `
    <label>Block Title</label>
    <input type="text" id="appt-edit-label" value="${editLabel}"
      placeholder="e.g. Personal Time, Vacation, Training..."
      style="width:100%;box-sizing:border-box;" />` : `
    <label>Appointment Type</label>
    <select id="appt-edit-type-sel" style="width:100%;box-sizing:border-box;"
      onchange="var _o=document.getElementById('appt-edit-type-other');if(_o)_o.style.display=this.value==='__other__'?'':'none';">
      <option value="">— Select type —</option>
      ${typeOptsHtml}
    </select>
    <input type="text" id="appt-edit-type-other" value="${!typeIsKnown&&editType?editType:''}"
      placeholder="Custom appointment type..."
      style="width:100%;box-sizing:border-box;margin-top:6px;${!typeIsKnown&&editType?'':'display:none;'}" />
    <label style="margin-top:10px;">Calendar Display Name <span style="color:var(--text-muted);font-size:11px;">(optional)</span></label>
    <input type="text" id="appt-edit-label" value="${editLabel}"
      placeholder="Custom name shown on calendar (defaults to type)..."
      style="width:100%;box-sizing:border-box;" />`}
    <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;">
      <div style="flex:1.5;min-width:0;">
        <label style="display:block;margin-bottom:4px;">Date &amp; Time</label>
        <input type="datetime-local" id="appt-dt" value="${defaultDt}"
          onclick="try{this.showPicker()}catch(e){}"
          style="cursor:pointer;width:100%;box-sizing:border-box;${isAllDayAppt?'display:none;':''}" />
        <input type="date" id="appt-dt-allday" value="${defaultDateOnly}"
          onclick="try{this.showPicker()}catch(e){}"
          style="cursor:pointer;width:100%;box-sizing:border-box;${isAllDayAppt?'':'display:none;'}" />
      </div>
      <div style="flex:1;min-width:0;">
        <label style="display:block;margin-bottom:4px;">Duration</label>
        <select id="appt-duration" onchange="apptDurationChange(this.value)"
          style="width:100%;box-sizing:border-box;">${durOpts}</select>
      </div>
    </div>
    ${!isPersonal ? `
    <div style="margin-top:10px;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;font-size:13px;">
      <div style="font-weight:600;">${a.booker_name||a.contact_name||'—'}</div>
      ${a.company?`<div style="color:var(--text-muted);">${a.company}</div>`:''}
      ${a.booker_email?`<div style="color:var(--text-muted);">${a.booker_email}</div>`:''}
      ${agentRow?`<div style="color:var(--text-muted);font-size:12px;">Agent: ${agentRow.name}</div>`:''}
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:0.5px solid var(--border);">
        <input type="checkbox" id="appt-edit-resend" style="width:14px;height:14px;cursor:pointer;" />
        <label for="appt-edit-resend" style="font-size:13px;cursor:pointer;margin:0;">Resend confirmation email to contact</label>
      </div>
    </div>` : ''}
    ${_inviteSectionHtml(a.cohost_agent_id||null, a.cohost_email||null, a.cohost_name||null, a.extra_attendees||[], a.scheduled_at||null, a.duration_minutes||60)}
    <label style="margin-top:10px;">Notes</label>
    <textarea id="appt-edit-notes" rows="2"
      style="width:100%;box-sizing:border-box;">${a.agent_notes||''}</textarea>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid var(--border);">
      ${isPersonal
        ? `<button class="btn btn-danger btn-sm" onclick="closeModal();apptCancel('${id}')">🗑 Delete Block</button>`
        : `${a.status!=='scheduled'?`<button class="btn btn-outline btn-sm" onclick="closeModal();apptSchedule('${id}')">📋 Schedule</button>`:''}
           ${a.status!=='completed'?`<button class="btn btn-outline btn-sm" onclick="closeModal();apptComplete('${id}')">✓ Complete</button>`:''}
           <button class="btn btn-outline btn-sm" onclick="closeModal();apptReschedule('${id}')">↺ Reschedule</button>
           ${a.status!=='cancelled'?`<button class="btn btn-danger btn-sm" onclick="closeModal();apptCancel('${id}')">✕ Cancel</button>`:''}`}
    </div>
  `, async () => {
    const isDurAllDay = document.getElementById('appt-duration')?.value === 'allday';
    const dtEl = isDurAllDay
      ? document.getElementById('appt-dt-allday')
      : document.getElementById('appt-dt');
    const dtVal = dtEl?.value;
    if (!dtVal) { showToast('Please select a date'); return false; }
    const scheduled_at = isDurAllDay
      ? (dtVal + 'T00:00:00.000Z')
      : new Date(dtVal).toISOString();
    const duration_minutes  = isDurAllDay ? 1440 : (parseInt(document.getElementById('appt-duration')?.value)||30);
    const agent_notes        = document.getElementById('appt-edit-notes')?.value?.trim()||null;
    const appointment_label  = document.getElementById('appt-edit-label')?.value?.trim()||null;
    const inv = _readInviteSection();
    const updates = {scheduled_at, duration_minutes, agent_notes, appointment_label,
      cohost_agent_id: inv.cohostAgentId||null, cohost_email: inv.cohostEmail||null,
      cohost_name: inv.cohostName||null, cohost_status: inv.cohostAgentId?'pending':null,
      extra_attendees: inv.extraAttendees};
    if (!isPersonal) {
      const _tSel = document.getElementById('appt-edit-type-sel')?.value||'';
      updates.appointment_type = _tSel === '__other__'
        ? (document.getElementById('appt-edit-type-other')?.value?.trim()||null)
        : (_tSel||null);
    }
    const {error} = await supabaseClient.from('booking_intents').update(updates).eq('id',id);
    if (error) { showToast('Error: '+error.message); return false; }
    _syncCalendarEvent(id, Object.assign({}, a, updates), updates.scheduled_at ? 'update' : 'update', a.google_calendar_event_id||null);
    if (!isPersonal) await _sendCohostInvites(id, inv, {contactName: a.booker_name||a.contact_name||'', appointmentType: appointment_label||a.appointment_label||a.appointment_type||'', dateIso: a.scheduled_at||'', notes: agent_notes||''});
    if (!isPersonal && document.getElementById('appt-edit-resend')?.checked) {
      const toEmail = a.booker_email||contacts.find(c=>c.id===a.contact_id)?.email||'';
      if (toEmail) {
        try {
          const eurl = new URL(APPS_SCRIPT_URL);
          eurl.searchParams.set('action','appointment_confirm');
          eurl.searchParams.set('agent_id',currentAgent.id);
          eurl.searchParams.set('booking_intent_id',id);
          eurl.searchParams.set('to',toEmail);
          eurl.searchParams.set('to_name',a.booker_name||a.contact_name||'');
          eurl.searchParams.set('datetime_iso',scheduled_at);
          if (agent_notes) eurl.searchParams.set('notes',agent_notes);
          fetch(eurl.toString());
        } catch(_) {}
        showToast('✓ Saved & confirmation resent!');
      } else {
        showToast('✓ Saved (no email on file)');
      }
    } else {
      showToast(isPersonal ? '✓ Block updated!' : '✓ Appointment updated!');
    }
    const idx = calAppointments.findIndex(x=>x.id===id);
    if (idx >= 0) Object.assign(calAppointments[idx], updates);
    calDate = new Date(scheduled_at);
    _calRenderView();
  }, 'Save Changes');
}

// ── CRUD ACTIONS (update + refresh calendar) ──
async function apptSchedule(id) {
  const appt = calAppointments.find(a=>a.id===id);
  const name  = appt ? (appt.booker_name||appt.contact_name||'this appointment') : 'this appointment';
  // Best-effort email: linked contact record → booker_email → empty
  let bestEmail = appt?.booker_email || '';
  if (appt?.contact_id) {
    const linked = contacts.find(c => c.id === appt.contact_id);
    if (linked?.email) bestEmail = linked.email;
  }
  if (!bestEmail) {
    // Last resort: search contacts by name
    const byName = contacts.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
    if (byName?.email) bestEmail = byName.email;
  }
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(9,0,0,0);
  const pad = n => String(n).padStart(2,'0');
  // Pre-fill with existing scheduled_at if available (for rescheduled items), else tomorrow 9am
  const existingDt = appt?.scheduled_at ? new Date(appt.scheduled_at) : null;
  const fillDt = existingDt || tomorrow;
  const defaultDt = `${fillDt.getFullYear()}-${pad(fillDt.getMonth()+1)}-${pad(fillDt.getDate())}T${pad(fillDt.getHours())}:${pad(fillDt.getMinutes())}`;
  showModal(`Schedule: ${name}`, `
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <label style="flex:1;border:0.5px solid var(--accent);border-radius:8px;padding:10px 12px;cursor:pointer;" id="sched-lbl-confirm">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <input type="radio" name="sched-type" value="confirm" checked
            onchange="document.getElementById('sched-lbl-confirm').style.borderColor='var(--accent)';document.getElementById('sched-lbl-propose').style.borderColor='var(--border)';document.getElementById('sched-dt').disabled=true;document.getElementById('sched-dt-row').style.opacity='0.45';" />
          <span style="font-size:12px;font-weight:600;">✓ Confirm this time</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-left:18px;">Lock the time &amp; send confirmation email</div>
      </label>
      <label style="flex:1;border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;cursor:pointer;" id="sched-lbl-propose">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <input type="radio" name="sched-type" value="propose"
            onchange="document.getElementById('sched-lbl-propose').style.borderColor='var(--accent)';document.getElementById('sched-lbl-confirm').style.borderColor='var(--border)';document.getElementById('sched-dt').disabled=false;document.getElementById('sched-dt-row').style.opacity='1';" />
          <span style="font-size:12px;font-weight:600;">📧 Propose new time</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-left:18px;">Pick a new time &amp; ask prospect to confirm</div>
      </label>
    </div>
    <label>Prospect Email <span style="color:var(--danger);">*</span></label>
    <input type="email" id="sched-email" value="${bestEmail}" placeholder="prospect@email.com" style="width:100%;box-sizing:border-box;" />
    <div id="sched-dt-row" style="opacity:0.45;transition:opacity .2s;">
      <label style="margin-top:12px;display:block;">Date &amp; Time <span style="font-size:11px;color:var(--text-muted);">(locked — switch to Propose to change)</span></label>
      <input type="datetime-local" id="sched-dt" value="${defaultDt}" disabled style="width:100%;box-sizing:border-box;" />
    </div>
  ${_inviteSectionHtml(appt&&appt.cohost_agent_id||null, appt&&appt.cohost_email||null, appt&&appt.cohost_name||null, appt&&appt.extra_attendees||[])}
    <label style="margin-top:12px;">Notes to prospect (optional)</label>
    <input type="text" id="sched-notes" placeholder="Zoom link, phone number, location, etc." style="width:100%;box-sizing:border-box;" />
  `, async () => {
    const dtVal  = document.getElementById('sched-dt').value;
    const toEmail = document.getElementById('sched-email').value.trim();
    if (!dtVal)    { showToast('Please select a date and time'); return false; }
    if (!toEmail)  { showToast('Please enter the prospect email'); return false; }
    const schedType = document.querySelector('input[name="sched-type"]:checked')?.value || 'confirm';
    const notes  = document.getElementById('sched-notes').value.trim();
    const parsed = new Date(dtVal);
    const isPropose = schedType === 'propose';
    const inv = _readInviteSection();
    const updates = {
      status:         isPropose ? 'rescheduled' : 'scheduled',
      scheduled_at:   parsed.toISOString(),
      rescheduled_by: isPropose ? 'agent' : null,
      booker_email:   toEmail,
      cohost_agent_id: inv.cohostAgentId||null, cohost_email: inv.cohostEmail||null,
      cohost_name: inv.cohostName||null, cohost_status: inv.cohostAgentId?'pending':null,
      extra_attendees: inv.extraAttendees,
      ...(notes ? { agent_notes: notes } : {})
    };
    const { error } = await supabaseClient.from('booking_intents').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }
    _syncCalendarEvent(id, Object.assign({}, appt, updates), appt&&appt.google_calendar_event_id ? 'update' : 'create', appt&&appt.google_calendar_event_id||null);
    // Fire-and-forget email via Apps Script
    try {
      const url = new URL(APPS_SCRIPT_URL);
      url.searchParams.set('action',            isPropose ? 'appointment_reschedule' : 'appointment_confirm');
      url.searchParams.set('agent_id',          currentAgent.id);
      url.searchParams.set('booking_intent_id', id);
      url.searchParams.set('to',                toEmail);
      url.searchParams.set('to_name',           name);
      url.searchParams.set('datetime_iso',      parsed.toISOString());
      if (notes) url.searchParams.set('notes', notes);
      fetch(url.toString()); // non-blocking
    } catch(_) {}
    showToast(isPropose ? '📧 Reschedule proposal sent!' : '📋 Appointment confirmed!');
    const idx = calAppointments.findIndex(a => a.id === id);
    if (idx >= 0) Object.assign(calAppointments[idx], updates);
    await _sendCohostInvites(id, inv, {contactName: name, appointmentType: appt&&appt.appointment_label||appt&&appt.appointment_type||'', dateIso: parsed.toISOString(), notes: notes||''});
    calDate = parsed;
    _calRenderView();
  });
}

async function apptComplete(id) {
  const notes = prompt('Completion notes (optional):') || null;
  const { error } = await supabaseClient.from('booking_intents').update({ status:'completed', completed_at:new Date().toISOString(), agent_notes:notes }).eq('id',id);
  if (error) { showToast('Error: '+error.message); return; }
  showToast('✓ Complete!');
  const idx = calAppointments.findIndex(a=>a.id===id);
  if (idx>=0) { calAppointments[idx].status='completed'; calAppointments[idx].agent_notes=notes; }
  _calRenderView();
}

async function apptReschedule(id) {
  const appt = calAppointments.find(a => a.id === id);
  if (!appt) return;

  // Pre-fill with existing scheduled_at or tomorrow 9am
  let prefill = '';
  if (appt.scheduled_at) {
    const d = new Date(appt.scheduled_at);
    const pad = n => String(n).padStart(2,'0');
    prefill = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    const tmr = new Date(); tmr.setDate(tmr.getDate()+1); tmr.setHours(9,0,0,0);
    const pad = n => String(n).padStart(2,'0');
    prefill = `${tmr.getFullYear()}-${pad(tmr.getMonth()+1)}-${pad(tmr.getDate())}T09:00`;
  }

  const name = appt.contact_name || appt.booker_name || 'this prospect';

  // Best-effort email lookup
  let bestEmail = appt.booker_email || '';
  if (appt.contact_id) { const linked = contacts.find(c => c.id === appt.contact_id); if (linked?.email) bestEmail = linked.email; }
  if (!bestEmail) { const byName = contacts.find(c => c.name?.toLowerCase() === name.toLowerCase()); if (byName?.email) bestEmail = byName.email; }

  showModal(
    `Reschedule: ${name}`,
    `<p style="margin:0 0 14px;color:#64748b;font-size:14px;">Pick a new date/time to propose. An email will be sent automatically.</p>
     <label style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#374151;display:block;margin-bottom:4px;">Prospect Email</label>
     <input type="email" id="modal-reschedule-email" value="${bestEmail}"
       style="width:100%;padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:14px;" placeholder="prospect@email.com">
     <label style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#374151;display:block;margin-bottom:4px;">New Date &amp; Time</label>
     <input type="datetime-local" id="modal-reschedule-dt" value="${prefill}"
       style="width:100%;padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:14px;">
     <label style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#374151;display:block;margin-bottom:4px;">Notes (optional)</label>
     <textarea id="modal-reschedule-notes" rows="3" placeholder="Reason for reschedule, new instructions, etc."
       style="width:100%;padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;">${appt.agent_notes||''}</textarea>`,
    async () => {
      const dtVal    = document.getElementById('modal-reschedule-dt')?.value || '';
      const notesVal = document.getElementById('modal-reschedule-notes')?.value?.trim() || null;
      const toEmail  = document.getElementById('modal-reschedule-email')?.value?.trim() || bestEmail;
      const updates  = { status:'rescheduled', rescheduled_by:'agent', agent_notes:notesVal, booker_email:toEmail };
      if (dtVal) updates.scheduled_at = new Date(dtVal).toISOString();
      const { error } = await supabaseClient.from('booking_intents').update(updates).eq('id',id);
      if (error) { showToast('Error: '+error.message); return false; }
      try {
        const url = new URL(APPS_SCRIPT_URL);
        url.searchParams.set('action',            'appointment_reschedule');
        url.searchParams.set('agent_id',          currentAgent.id);
        url.searchParams.set('booking_intent_id', id);
        url.searchParams.set('to',                toEmail);
        url.searchParams.set('to_name',           name);
        if (dtVal) url.searchParams.set('datetime_iso', new Date(dtVal).toISOString());
        if (notesVal) url.searchParams.set('notes', notesVal);
        fetch(url.toString());
      } catch(_) {}
      showToast('↺ Reschedule proposed to prospect');
      const idx = calAppointments.findIndex(a=>a.id===id);
      if (idx>=0) {
        calAppointments[idx].status='rescheduled';
        calAppointments[idx].rescheduled_by='agent';
        calAppointments[idx].agent_notes=notesVal;
        if (dtVal) calAppointments[idx].scheduled_at=new Date(dtVal).toISOString();
      }
      _calRenderView();
    },
    'Propose New Time'
  );
}

async function apptCancel(id) {
  const appt = calAppointments.find(a=>a.id===id);
  if (appt && appt.google_calendar_event_id) _syncCalendarEvent(id, appt, 'delete', appt.google_calendar_event_id);
  const who = appt ? (appt.booker_name||appt.contact_name||'this request') : 'this request';
  showModal('Dismiss Request', `
    <p style="font-size:14px;color:var(--text-primary);margin:0 0 8px 0;">Cancel the appointment request from <strong>${who}</strong>?</p>
    <p style="font-size:13px;color:var(--text-muted);margin:0;">This will remove it from your list. The prospect will not be notified automatically.</p>
  `, async () => {
    const { error } = await supabaseClient.from('booking_intents').update({ status:'cancelled' }).eq('id',id);
    if (error) { showToast('Error: '+error.message); return false; }
    showToast('Request dismissed');
    const idx = calAppointments.findIndex(a=>a.id===id);
    if (idx>=0) calAppointments.splice(idx, 1);
    _calRenderView();
  });
}

async function apptLog() {
  var _d = new Date(); _d.setDate(_d.getDate() + 1); _d.setHours(9, 0, 0, 0);
  var _pad = function(n) { return String(n).padStart(2,'0'); };
  var _defaultDt = _d.getFullYear() + '-' + _pad(_d.getMonth()+1) + '-' + _pad(_d.getDate()) + 'T09:00';
  window.apptModeSwitch = function(mode) {
    var isC = mode === 'contact';
    var cs  = document.getElementById('appt-contact-section');
    var cr  = document.getElementById('appt-contact-row');
    var ps  = document.getElementById('appt-personal-section');
    var er  = document.getElementById('appt-email-row');
    var bc  = document.getElementById('appt-mode-contact');
    var bp  = document.getElementById('appt-mode-personal');
    if (cs) cs.style.display = isC ? '' : 'none';
    if (cr) cr.style.display = isC ? '' : 'none';
    if (ps) ps.style.display = isC ? 'none' : '';
    if (er) er.style.display = isC ? 'flex' : 'none';
    if (bc) { bc.style.background = isC ? 'var(--fill-accent)' : 'var(--surface-2)'; bc.style.color = isC ? '#fff' : 'var(--text-secondary)'; }
    if (bp) { bp.style.background = isC ? 'var(--surface-2)' : 'var(--fill-accent)'; bp.style.color = isC ? 'var(--text-secondary)' : '#fff'; }
  };
  window.apptDurationChange = function(val) {
    var d = document.getElementById('appt-dt');
    var a = document.getElementById('appt-dt-allday');
    if (!d || !a) return;
    if (val === 'allday') {
      a.value = d.value ? d.value.split('T')[0] : a.value;
      d.style.display = 'none'; a.style.display = '';
    } else {
      d.value = a.value ? a.value + 'T09:00' : d.value;
      a.style.display = 'none'; d.style.display = '';
    }
  };
  showModal('Add Appointment', `
    <div style="display:flex;margin-bottom:16px;border:0.5px solid var(--border);border-radius:8px;overflow:hidden;">
      <button id="appt-mode-contact" onclick="apptModeSwitch('contact')"
        style="flex:1;padding:10px;font-size:12px;font-weight:600;border:none;cursor:pointer;background:var(--fill-accent);color:#fff;transition:all .15s;">
        &#128100; Contact Appointment</button>
      <button id="appt-mode-personal" onclick="apptModeSwitch('personal')"
        style="flex:1;padding:10px;font-size:12px;font-weight:600;border:none;cursor:pointer;background:var(--surface-2);color:var(--text-secondary);transition:all .15s;">
        &#128197; Personal Block</button>
    </div>
    <div id="appt-contact-section">
      <label>Appointment Type</label>
      <input type="text" id="appt-type" placeholder="e.g. Discovery Call..." list="appt-type-list" autocomplete="off" style="width:100%;box-sizing:border-box;" />
      <datalist id="appt-type-list">
        <option value="Discovery Call">
        <option value="Benefits Review">
        <option value="Benefits Presentation">
        <option value="Enrollment Meeting">
        <option value="Needs Analysis">
        <option value="Policy Review">
        <option value="Follow-Up Call">
        <option value="Annual Review">
        <option value="Group Benefits Overview">
        <option value="Recruiting Call">
        <option value="Onboarding Meeting">
        <option value="Claims Review">
      </datalist>
    </div>
    <div id="appt-personal-section" style="display:none;">
      <label>Block Title</label>
      <input type="text" id="appt-personal-title" placeholder="e.g. Team Meeting, Lunch, Out of Office..." style="width:100%;box-sizing:border-box;" />
    </div>
    <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;">
      <div style="flex:1.5;min-width:0;">
        <label style="display:block;margin-bottom:4px;">Date &amp; Time</label>
        <input type="datetime-local" id="appt-dt" value="${_defaultDt}" onclick="try{this.showPicker()}catch(e){}" style="cursor:pointer;width:100%;box-sizing:border-box;" />
        <input type="date" id="appt-dt-allday" value="${_defaultDt.split('T')[0]}" onclick="try{this.showPicker()}catch(e){}" style="cursor:pointer;width:100%;box-sizing:border-box;display:none;" />
      </div>
      <div style="flex:1;min-width:0;">
        <label style="display:block;margin-bottom:4px;">Duration</label>
        <select id="appt-duration" onchange="apptDurationChange(this.value)" style="width:100%;box-sizing:border-box;">
          <option value="15">15 minutes</option>
          <option value="30" selected>30 minutes</option>
          <option value="45">45 minutes</option>
          <option value="60">1 hour</option>
          <option value="90">1 hr 30 min</option>
          <option value="120">2 hours</option>
          <option value="allday">All Day</option>
        </select>
      </div>
    </div>
    <div id="appt-contact-row">
      <label style="margin-top:10px;">Contact</label>
      ${buildContactSearch('', 'appt-contact', null)}
      <div id="appt-email-row" style="margin-top:8px;display:flex;align-items:center;gap:8px;padding:10px;background:var(--surface-0);border-radius:var(--radius);border:0.5px solid var(--border-accent);">
        <input type="checkbox" id="appt-send-email" checked style="width:15px;height:15px;accent-color:var(--fill-accent);flex-shrink:0;cursor:pointer;" />
        <label for="appt-send-email" style="font-size:13px;margin:0;cursor:pointer;font-weight:400;color:var(--text-primary);">Send confirmation email to contact</label>
      </div>
    </div>
  ${_inviteSectionHtml(null,null,null,[])}
    <label style="margin-top:10px;">Notes</label>
    <textarea id="appt-notes" placeholder="Any context or details..." style="width:100%;box-sizing:border-box;"></textarea>
  `, async () => {
    var isPersonal = (document.getElementById('appt-personal-section') || {}).style.display !== 'none';
    var contactId, apptType, contact;
    if (isPersonal) {
      apptType = ((document.getElementById('appt-personal-title') || {}).value || '').trim();
      if (!apptType) { showToast('Please enter a block title'); return false; }
      contactId = null; contact = null;
    } else {
      contactId = ((document.getElementById('appt-contact') || {}).value || '').trim() || null;
      apptType  = ((document.getElementById('appt-type') || {}).value || '').trim();
      if (!apptType) { showToast('Appointment type required'); return false; }
      contact = contactId ? contacts.find(function(c) { return c.id === contactId; }) : null;
    }
    var _durVal   = ((document.getElementById('appt-duration') || {}).value) || '30';
    var _isAllDay = _durVal === 'allday';
    var dt        = _isAllDay
      ? (((document.getElementById('appt-dt-allday') || {}).value || '') + 'T00:00')
      : ((document.getElementById('appt-dt') || {}).value || '');
    var duration  = _isAllDay ? 1440 : (parseInt(_durVal) || 30);
    var notes     = ((document.getElementById('appt-notes') || {}).value || '').trim();
    var sendEmail = !isPersonal && ((document.getElementById('appt-send-email') || {}).checked);
    var inv = _readInviteSection();
    var newAppt = {
      agent_id:          currentAgent.id,
      contact_id:        contactId || null,
      contact_name:      contact ? contact.name    : null,
      booker_name:       contact ? contact.name    : null,
      booker_email:      contact ? contact.email   : null,
      company:           contact ? contact.company : null,
      appointment_type:  apptType,
      appointment_label: apptType,
      scheduled_at:      dt ? new Date(dt).toISOString() : null,
      duration_minutes:  duration,
      agent_notes:       notes || null,
      status:            dt ? 'scheduled' : 'pending',
      cohost_agent_id:   inv.cohostAgentId   || null,
      cohost_email:      inv.cohostEmail      || null,
      cohost_name:       inv.cohostName       || null,
      cohost_status:     inv.cohostAgentId    ? 'pending' : null,
      extra_attendees:   inv.extraAttendees,
    };
    var ins = await supabaseClient.from('booking_intents').insert(newAppt).select().single();
    if (ins.error) { showToast('Error: ' + ins.error.message); return false; }
    calAppointments.push(ins.data);
    if (ins.data.scheduled_at) _syncCalendarEvent(ins.data.id, ins.data, 'create', null);
    if (dt) { calDate = new Date(dt); calView = calDate.toDateString() === new Date().toDateString() ? calView : 'month'; }
    if (sendEmail && contact && contact.email && dt) {
      try {
        var eUrl = new URL(APPS_SCRIPT_URL);
        eUrl.searchParams.set('action',            'appointment_confirm');
        eUrl.searchParams.set('agent_id',          currentAgent.id);
        eUrl.searchParams.set('booking_intent_id', ins.data.id);
        eUrl.searchParams.set('to',                contact.email);
        eUrl.searchParams.set('to_name',           contact.name || '');
        eUrl.searchParams.set('datetime_iso',      new Date(dt).toISOString());
        if (notes) eUrl.searchParams.set('notes', notes);
        fetch(eUrl.toString());
        showToast('Appointment added — confirmation sent to ' + (contact.name || contact.email) + '!');
      } catch(e) {
        showToast('Appointment added (email error: ' + e.message + ')');
      }
    } else {
      showToast(isPersonal ? 'Personal block added to calendar!' : '✓ Appointment added!');
    }
    _calRenderView();
  });
}

// ============================================================
// CONTACT TRANSFER
// ============================================================
async function transferContact(contactId) {
  const contact = contacts.find(c => c.id === contactId);
  if (!contact) { showToast('Contact not found'); return; }

  const role = previewRole || currentAgent.role;
  let eligible;
  if (role === 'system_owner') {
    eligible = allAgents.filter(a => a.id !== currentAgent.id && (a.status === 'active' || !a.status));
  } else {
    eligible = allAgents.filter(a => a.agency_id === currentAgent.agency_id && a.id !== currentAgent.id && (a.status === 'active' || !a.status));
  }

  if (eligible.length === 0) {
    showToast('No other agents available to transfer to in your agency.');
    return;
  }

  const agentOptions = eligible.map(a => `<option value="${a.id}">${a.name} (${a.email})</option>`).join('');

  showModal(`Transfer: ${contact.name}`, `
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;line-height:1.6;">The selected agent will become the new owner of this contact and all its history. Your copy will be removed.</p>
    <label>Transfer to Agent</label>
    <select id="xfer-agent">${agentOptions}</select>
    <label style="margin-top:12px;">Note for the receiving agent (optional)</label>
    <textarea id="xfer-note" placeholder="Context about this contact, why you're transferring, next steps..."></textarea>
  `, async () => {
    const newAgentId = document.getElementById('xfer-agent').value;
    if (!newAgentId) { showToast('Select an agent'); return false; }
    const newAgent = eligible.find(a => a.id === newAgentId);
    const note = document.getElementById('xfer-note').value.trim();

    const updates = { agent_id: newAgentId };
    // Include note in contact notes field so it's visible to the new owner
    if (note) {
      const existingNotes = contact.notes ? contact.notes + '\n\n' : '';
      updates.notes = existingNotes + `[Transferred from ${currentAgent.name} on ${new Date().toLocaleDateString()}] ${note}`;
    }

    const { error } = await supabaseClient.from('contacts').update(updates).eq('id', contactId);
    if (error) { showToast('Error: ' + error.message); return false; }

    // Update local state
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx >= 0) Object.assign(contacts[idx], updates);

    showToast(`✓ Contact transferred to ${newAgent?.name || 'agent'}`);
    renderContacts();
  });
}

// ============================================================
// STARTUP
// ============================================================
init();
