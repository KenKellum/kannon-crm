// ============================================================
// CONFIG & STATE
// ============================================================
const SUPABASE_URL = 'https://ilrylhseqnllmejebozq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlscnlsaHNlcW5sbG1lamVib3pxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NDk1MTIsImV4cCI6MjA5ODMyNTUxMn0.ga1b6-xCpXYa-p6axyLMoXj6oHVHEKTFoDEtmVIc3Uw';


// GMAIL OAUTH CONFIG—fill these in after Google Cloud setup
const GOOGLE_OAUTH_CLIENT_ID = 'PASTE_CLIENT_ID_HERE';
const APPS_SCRIPT_URL        = 'https://script.google.com/macros/s/AKfycbw4XGkFjwmillnNNEBKKI008Slwy-xd_ZDouIf0pVpkzmL1Olun-Lbda7FY3XA_uDm0ww/exec';
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';
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
let currentAgentCompanies = []; // company names agent belongs to
let allAgents = [];             // for admin panel + dropdowns
let allAgencies = [];
let allCompanies = [];
let contacts = [];
let deals = [];
let draggedDeal = null;
let currentPipeline = 'group-employer';
let contactSearch = '';
let contactTypeFilter = '';
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
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      await loadAgentProfile();
      if (currentAgent) { showApp(); } else { showAuthError('Your account is not set up in the CRM yet. Contact Ken to be added.'); }
    }
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
    renderDashboard();
    showToast('✓ Gmail connected!');
  } else if (currentAgent.role === 'agent' && !currentAgent.gmail_connected) {
    setTimeout(() => showGmailSetup(false), 500);
  }
}

const PAGE_TITLES = {
  dashboard: 'Dashboard', pipelines: 'Pipelines', contacts: 'Contacts',
  opens: 'Email Opens', campaigns: 'Email Campaigns', compliance: 'Compliance',
  admin: 'Admin', dialer: 'Work My Leads', settings: 'Settings', appointments: 'Appointments'
};

function showPage(page) {
  ['dashboard','pipelines','contacts','opens','campaigns','compliance','admin','dialer','settings','appointments'].forEach(p => {
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
        { icon: 'ti-shield-check',     text: 'Compliance',         page: 'compliance'},
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
  if (currentAgent.role === 'agent') dq = dq.eq('user_id', currentUser.id);

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
      <div><div class="dash-greeting">${g}, ${firstName}</div><div class="dash-date">${dateStr} &nbsp;┬╖&nbsp; <span style="color:var(--text-muted);">${agencyName}</span></div></div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="shareBookingLink()"><i class="ti ti-calendar"></i> Booking link</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('contacts');openAddContact()"><i class="ti ti-plus"></i> Add Lead</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('dialer')"><i class="ti ti-bolt"></i> Work leads</button>
      </div>
    </div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));">
      <div class="stat-card"><div class="stat-num">${totalContacts.toLocaleString()}</div><div class="stat-label">Agency contacts</div></div>
      <div class="stat-card" style="border-left-color:#34d399;background:rgba(52,211,153,0.05);"><div class="stat-num">${inSequence}</div><div class="stat-label">In sequence</div></div>
      <div class="stat-card" style="border-left-color:#c8a84b;background:rgba(200,168,75,0.05);"><div class="stat-num">${openRatePct}%</div><div class="stat-label">Open rate</div></div>
      <div class="stat-card" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.05);"><div class="stat-num">${pendingApps}</div><div class="stat-label">Pending hires</div><div class="${pendingApps > 0 ? 'stat-delta-warn' : 'stat-delta'}">${pendingApps > 0 ? 'Needs review' : 'None pending'}</div></div>
    </div>
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
  const inSequence   = contacts.filter(c => c.sequence_status === 'Active').length;
  const replied      = contacts.filter(c => c.sequence_status === 'Replied').length;
  const activeDeals  = deals.filter(d => !['Enrolled','Active Client','Active Agent','Contracted'].includes(d.stage)).length;
  const notStarted   = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started' || c.sequence_status === 'not_started');
  const hotLeads     = contacts.filter(c => c.sequence_status === 'Replied');

  // Pipeline snapshot by stage — use real PIPELINES stages
  const stageOrder = PIPELINES['group-employer'].stages.slice(0, 4);
  const stageMap = {};
  deals.forEach(d => { if (!stageMap[d.stage]) stageMap[d.stage] = []; stageMap[d.stage].push(d); });

  // Avatar initials helper
  const initials = name => (name||'??').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

  el.innerHTML = `
    <div class="dash-header" style="margin-bottom:10px;">
      <div><div class="dash-greeting">${g}, ${firstName}</div><div class="dash-date">${dateStr}</div></div>
      <button class="btn btn-outline btn-sm" onclick="shareBookingLink()"><i class="ti ti-calendar"></i> Booking link</button>
    </div>

    <div class="dash-card" style="margin-bottom:10px;background:var(--surface-1);border-color:var(--border);">
      <div style="font-size:14px;font-weight:500;color:var(--text-primary);">You have <strong style="color:var(--text-accent);">${notStarted.length} lead${notStarted.length !== 1 ? 's' : ''}</strong> to work${replied > 0 ? ` and <strong style="color:var(--text-success);">${replied} email open${replied !== 1 ? 's' : ''}</strong> waiting` : ''}.</div>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="btn btn-primary" onclick="showPage('dialer')"><i class="ti ti-bolt"></i> Start working leads</button>
        <button class="btn btn-outline btn-sm" onclick="showPage('contacts');openAddContact()"><i class="ti ti-plus"></i> Add new lead</button>
      </div>
    </div>

    <div class="stats-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:10px;">
      <div class="stat-card"><div class="stat-num">${totalContacts.toLocaleString()}</div><div class="stat-label">My contacts</div></div>
      <div class="stat-card" style="border-left-color:#34d399;background:rgba(52,211,153,0.05);"><div class="stat-num">${inSequence}</div><div class="stat-label">In sequence</div></div>
      <div class="stat-card" style="border-left-color:#c8a84b;background:rgba(200,168,75,0.05);"><div class="stat-num">${replied}</div><div class="stat-label">Replied</div></div>
      <div class="stat-card" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.05);"><div class="stat-num">${activeDeals}</div><div class="stat-label">Active deals</div></div>
    </div>

    <div class="dash-grid">
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card">
          ${_ctitle('ti-flame', `Hot leads — follow up now ${hotLeads.length > 0 ? `<span style="background:rgba(139,92,246,0.2);color:#a78bfa;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">${hotLeads.length}</span>` : ''}`)}
          ${hotLeads.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:16px 0;"><i class="ti ti-inbox" style="font-size:24px;display:block;margin-bottom:6px;"></i>No replies yet — keep the sequence running!</div>`
            : hotLeads.slice(0, 5).map(c => `
            <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:0.5px solid var(--border);">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--surface-3);border:0.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:var(--text-secondary);flex-shrink:0;">${initials(c.name)}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name||'—'}</div>
                <div style="font-size:11px;color:var(--text-muted);">${c.company||c.email||'—'}</div>
              </div>
              <span class="badge badge-active">Replied</span>
              <button class="btn btn-outline btn-sm" onclick="viewContact('${c.id}','')">View</button>
            </div>`).join('')}
          ${hotLeads.length > 5 ? `<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage('contacts')">View all ${hotLeads.length} &rarr;</button></div>` : ''}
        </div>

        <div class="dash-card">
          ${_ctitle('ti-alert-circle', `Not yet contacted <span style="background:rgba(251,191,36,0.15);color:var(--text-warning);border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;">${notStarted.length}</span>`)}
          ${notStarted.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px 0;"><i class="ti ti-circle-check" style="font-size:22px;display:block;margin-bottom:5px;color:var(--text-success);"></i>All contacts are in the sequence!</div>`
            : notStarted.slice(0, 4).map(c => `
            <div class="action-item">
              <div class="action-item-info">
                <div class="action-item-name">${c.name||'—'}</div>
                <div class="action-item-sub">${c.company||c.email||'—'}</div>
              </div>
              <button class="btn btn-outline btn-sm" onclick="viewContact('${c.id}','')">View</button>
            </div>`).join('')}
          ${notStarted.length > 4 ? `<div style="margin-top:8px;"><button class="btn btn-outline btn-sm btn-full" onclick="showPage('contacts')">View all ${notStarted.length} &rarr;</button></div>` : ''}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="dash-card">
          ${_ctitle('ti-layout-kanban', 'Pipeline snapshot')}
          <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;">
            ${stageOrder.map(stage => {
              const stagDeals = stageMap[stage] || [];
              return `<div style="min-width:108px;background:var(--surface-1);border-radius:8px;padding:8px;flex-shrink:0;border:0.5px solid var(--border);">
                <div style="font-size:10px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">${stage}</div>
                ${stagDeals.length === 0
                  ? `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">—</div>`
                  : stagDeals.slice(0,3).map(d => `<div style="background:var(--surface-2);border:0.5px solid var(--border);border-radius:6px;padding:5px 7px;margin-bottom:3px;"><div style="font-size:11px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.title}</div>${d.value ? `<div style="font-size:11px;color:var(--text-success);">$${parseFloat(d.value).toLocaleString()}</div>` : ''}</div>`).join('')}
              </div>`;
            }).join('')}
          </div>
          <div style="margin-top:10px;">
            <button class="btn btn-outline btn-sm btn-full" onclick="showPage('pipelines')"><i class="ti ti-external-link"></i> Full pipeline view</button>
          </div>
        </div>

        <div class="dash-card">
          ${_ctitle('ti-mail-opened', 'Outreach sequence')}
          ${_seqTable(contacts, totalContacts)}
        </div>

        <div class="dash-card">
          ${_ctitle('ti-settings-automation', 'Automation status')}
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Email outreach</div><div class="action-item-sub">Apps Script trigger</div></div><span class="badge badge-active"><i class="ti ti-check"></i> Active</span></div>
          <div class="action-item"><div class="action-item-info"><div class="action-item-name">Your Gmail</div><div class="action-item-sub">${currentAgent.gmail_connected ? (currentAgent.gmail_email || 'Connected') : 'Not connected'}</div></div>${currentAgent.gmail_connected ? `<span class="badge badge-active"><i class="ti ti-check"></i> Connected</span>` : `<button class="btn btn-primary btn-sm" onclick="showGmailSetup(true)">Connect</button>`}</div>
        </div>
      </div>
    </div>
  `;
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
      ${currentAgent.role === 'system_owner' ? `<button class="qa-btn" onclick="showPage('admin')">&#9881;&#65039; Admin</button>` : ''}
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
function startDialerSession(filterType) {
  // If no filter specified, show picker modal
  if (!filterType) {
    const hotCount   = contacts.filter(c => c.sequence_status === 'Replied').length;
    const freshCount = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started').length;
    const allCount   = totalContactCountFull || contacts.length;
    showModal('&#9889; Start a Lead Session', `
      <p style="font-size:13px;color:var(--muted);margin-bottom:18px;">Choose which leads to work through. You can stop anytime.</p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${hotCount > 0 ? `<button class="btn btn-accent btn-full" onclick="closeModal();startDialerSession('replied')">
          &#128293; Hot leads — Replied (${hotCount})
        </button>` : ''}
        <button class="btn btn-primary btn-full" onclick="closeModal();startDialerSession('not_started')">
          &#128101; Fresh leads — Not yet contacted (${freshCount})
        </button>
        <button class="btn btn-outline btn-full" onclick="closeModal();startDialerSession('all')">
          &#128203; All my contacts (${allCount})
        </button>
      </div>
    `);
    return;
  }

  let queue;
  if (filterType === 'replied')     queue = contacts.filter(c => c.sequence_status === 'Replied');
  else if (filterType === 'not_started') queue = contacts.filter(c => !c.sequence_status || c.sequence_status === 'Not Started');
  else queue = [...contacts];

  if (queue.length === 0) {
    showToast('No contacts in this queue!');
    return;
  }

  dialerQueue = queue;
  dialerIndex = 0;
  showPage('dialer');
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

  const statusClass = contact.sequence_status === 'Replied' ? 'badge-replied'
    : contact.sequence_status === 'Active' ? 'badge-active' : 'badge-completed';
  const typeClass = contact.type === 'Recruit' ? 'badge-agent'
    : contact.type === 'Group/Employer' ? 'badge-group' : 'badge-individual';

  el.innerHTML = `
    <div style="max-width:700px;margin:0 auto;">

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
        <button class="btn btn-outline btn-sm" onclick="showPage('dashboard')">End session</button>
      </div>

      <!-- Contact card -->
      <div class="card" style="padding:28px;margin-bottom:16px;border-top:3px solid var(--accent);">

        <!-- Header row -->
        <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;">
          <div style="width:58px;height:58px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0;">${initials}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:22px;font-weight:700;color:var(--primary);margin-bottom:3px;">${contact.name || '—'}</div>
            <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">${[contact.company, contact.city ? contact.city + (contact.state ? ', ' + contact.state : '') : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ') || '&mdash;'}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span class="badge ${typeClass}">${contact.type || 'Contact'}</span>
              <span class="badge ${statusClass}">${contact.sequence_status || 'Not started'}</span>
              ${contact.sequence_step > 0 ? `<span class="badge badge-insured">Email ${contact.sequence_step} sent</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Added</div>
            <div style="font-size:13px;font-weight:600;color:var(--primary);margin-top:2px;">${contact.created_at ? new Date(contact.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'}</div>
          </div>
        </div>

        <!-- Meta grid -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px;background:#f8fafc;border-radius:10px;margin-bottom:20px;">
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Email</div>
            <div style="font-size:13px;font-weight:600;color:var(--primary);margin-top:3px;word-break:break-all;">${contact.email || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Phone</div>
            <div style="font-size:13px;font-weight:600;color:var(--primary);margin-top:3px;">${contact.phone || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Company</div>
            <div style="font-size:13px;font-weight:600;color:var(--primary);margin-top:3px;">${contact.company || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Sequence step</div>
            <div style="font-size:13px;font-weight:600;color:var(--primary);margin-top:3px;">Email ${contact.sequence_step || 0} of 3</div>
          </div>
        </div>

        <!-- Action buttons -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
          ${contact.phone
            ? `<button class="btn btn-primary" onclick="window.open('tel:${contact.phone.replace(/[^0-9+]/g,'')}')">&#128222; Call</button>`
            : `<button class="btn btn-outline" disabled style="opacity:0.45;cursor:not-allowed;">&#128222; No phone</button>`}
          <button class="btn btn-accent" onclick="viewContact('${contact.id}','')">&#128140; View / Email</button>
          <button class="btn btn-outline" style="border-color:#10b981;color:#10b981;" onclick="dialerMarkInterested('${contact.id}')">&#129309; Interested</button>
          <button class="btn btn-outline" onclick="dialerSkip()" style="margin-left:auto;">Skip &rarr;</button>
          <button class="btn btn-primary" onclick="dialerNext()">${isLast ? '&#127942; Finish' : 'Next &rarr;'}</button>
        </div>

        <!-- Notes area -->
        <div style="border-top:1px solid var(--border);padding-top:16px;">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Quick note</div>
          ${contact.notes ? `<div style="font-size:13px;color:var(--text);background:#f8fafc;padding:10px 12px;border-radius:8px;margin-bottom:10px;border-left:3px solid var(--accent);">${contact.notes}</div>` : ''}
          <div style="display:flex;gap:8px;">
            <input id="dialer-note-input" placeholder="Log a call, leave a note..." style="flex:1;font-size:13px;" value="" />
            <button class="btn btn-outline" onclick="dialerSaveNote('${contact.id}')">Save note</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function dialerMarkInterested(contactId) {
  try {
    await supabaseClient.from('contacts').update({ sequence_status: 'Replied' }).eq('id', contactId);
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx > -1) contacts[idx].sequence_status = 'Replied';
    const qi = dialerQueue.findIndex(c => c.id === contactId);
    if (qi > -1) dialerQueue[qi].sequence_status = 'Replied';
    showToast('&#129309; Marked as Interested / Replied!');
    dialerNext();
  } catch (e) { showToast('Error saving — try again'); }
}

async function dialerSaveNote(contactId) {
  const input = document.getElementById('dialer-note-input');
  const note = input?.value?.trim();
  if (!note) return;
  try {
    await supabaseClient.from('contacts').update({ notes: note }).eq('id', contactId);
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx > -1) contacts[idx].notes = note;
    const qi = dialerQueue.findIndex(c => c.id === contactId);
    if (qi > -1) dialerQueue[qi].notes = note;
    showToast('&#10003; Note saved');
    if (input) input.value = '';
    renderDialer();
  } catch (e) { showToast('Error saving note'); }
}

function dialerSkip() {
  showToast('Skipped &rarr;');
  dialerNext();
}

function dialerNext() {
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
  const { data: opens, error } = await supabaseClient.from('email_opens').select('*').order('opened_at', { ascending: false }).limit(1000);
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
    const initials = oName.split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase();
    return `<tr class="opens-row" onclick="viewContact('${contactId}','${oEmail.replace(/'/g,"\\'")}')">
      <td style="white-space:nowrap;"><span class="contact-avatar" style="width:30px;height:30px;font-size:11px;">${initials}</span><strong>${oName}</strong></td>
      <td style="color:var(--muted);font-size:13px;">${oEmail||'—'}</td>
      <td style="font-size:13px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${o.email_subject?o.email_subject.substring(0,60)+(o.email_subject.length>60?'…':''):'—'}</td>
      <td><span class="badge badge-group">${o.sequence_track||'—'}</span></td>
      <td style="font-size:12px;color:var(--muted);white-space:nowrap;">${formatTimeAgo(o.opened_at)}</td>
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
        : `<table><thead><tr><th>Name</th><th>Email</th><th>Subject</th><th>Email</th><th>Opened</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`}
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
        <div class="panel-label">Notes</div>
        <div class="panel-notes-box">${c.notes||'<em style="color:var(--muted)">No notes yet.</em>'}</div>
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
      <button class="btn btn-outline btn-sm" onclick="closeContactPanel();transferContact('${c.id}')" title="Transfer this contact to another agent"><i class="ti ti-arrows-exchange"></i> Transfer</button>
      <button class="btn btn-accent btn-sm" onclick="recruitContact('${c.id}')" title="Recruit this contact as a Kannon agent">&#128101; Recruit</button>
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
      return `<div class="deal-card" draggable="true" ondragstart="dragStart(event,'${deal.id}')" id="deal-${deal.id}">
        <div class="deal-name">${deal.title}</div>
        <div class="deal-contact">&#128100; ${contact ? contact.name : 'No contact'}</div>
        ${deal.value ? `<div class="deal-value">$${parseFloat(deal.value).toLocaleString()}</div>` : ''}
        ${deal.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;">${deal.notes.substring(0,80)}${deal.notes.length>80?'...':''}</div>` : ''}
        <div class="deal-actions">
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

function openAddDeal(stage = '') {
  const pipeline = PIPELINES[currentPipeline];
  const stageOptions = pipeline.stages.map(s => `<option value="${s}" ${s===stage?'selected':''}>${s}</option>`).join('');
  const contactOptions = contacts.map(c => `<option value="${c.id}">${c.name} — ${c.company||c.email||''}</option>`).join('');
  showModal('Add New Deal', `
    <label>Deal / Opportunity Name *</label><input type="text" id="deal-title" placeholder="e.g. Acme Corp Benefits Package" />
    <label>Stage</label><select id="deal-stage">${stageOptions}</select>
    <label>Contact</label><select id="deal-contact"><option value="">— No contact —</option>${contactOptions}</select>
    <label>Deal Value ($)</label><input type="number" id="deal-value" placeholder="0" min="0" />
    <label>Notes</label><textarea id="deal-notes" placeholder="Key details, next steps..."></textarea>
  `, async () => {
    const title = document.getElementById('deal-title').value.trim();
    if (!title) { showToast('Deal name is required'); return false; }
    const { data, error } = await supabaseClient.from('deals').insert({ title, pipeline: currentPipeline, stage: document.getElementById('deal-stage').value, contact_id: document.getElementById('deal-contact').value || null, value: parseFloat(document.getElementById('deal-value').value) || null, notes: document.getElementById('deal-notes').value.trim() || null, user_id: currentUser.id }).select().single();
    if (error) { showToast('Error: ' + error.message); return false; }
    deals.unshift(data); showToast('Deal added!'); renderPipelines();
  });
}

function editDeal(id) {
  const deal = deals.find(d => d.id === id); if (!deal) return;
  const pipeline = PIPELINES[deal.pipeline];
  const stageOptions = pipeline.stages.map(s => `<option value="${s}" ${s===deal.stage?'selected':''}>${s}</option>`).join('');
  const contactOptions = contacts.map(c => `<option value="${c.id}" ${c.id===deal.contact_id?'selected':''}>${c.name} — ${c.company||c.email||''}</option>`).join('');
  showModal('Edit Deal', `
    <label>Deal Name *</label><input type="text" id="deal-title" value="${deal.title}" />
    <label>Stage</label><select id="deal-stage">${stageOptions}</select>
    <label>Contact</label><select id="deal-contact"><option value="">— No contact —</option>${contactOptions}</select>
    <label>Deal Value ($)</label><input type="number" id="deal-value" value="${deal.value||''}" min="0" />
    <label>Notes</label><textarea id="deal-notes">${deal.notes||''}</textarea>
  `, async () => {
    const title = document.getElementById('deal-title').value.trim();
    if (!title) { showToast('Deal name is required'); return false; }
    const updates = { title, stage: document.getElementById('deal-stage').value, contact_id: document.getElementById('deal-contact').value || null, value: parseFloat(document.getElementById('deal-value').value) || null, notes: document.getElementById('deal-notes').value.trim() || null };
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
async function renderContacts() {
  const pg = document.getElementById('page-contacts');
  const PAGE_SIZE = 100;
  const typeClass  = { 'Group/Employer': 'badge-group', 'Individual/Family': 'badge-individual' };
  const seqClass   = { 'Active': 'badge-active', 'Replied': 'badge-replied', 'Completed': 'badge-completed', 'Drip': 'badge-group', 'Not Started': 'badge-agent' };
  const showOwnerCol = currentAgent.role !== 'agent';

  const typeFilterBtns = ['', ...CONTACT_TYPES].map(t =>
    `<button class="pipeline-tab ${contactTypeFilter === t ? 'active' : ''}" onclick="contactTypeFilter='${t}';contactPage=0;renderContacts();">${t || 'All Types'}</button>`
  ).join('');

  // Render shell immediately so tabs show while DB query runs
  const _searchFocused = document.activeElement && document.activeElement.id === 'contact-search-input';
  pg.innerHTML = `
    <div class="contacts-toolbar">
      <input id="contact-search-input" type="text" placeholder="&#128269; Search contacts..." value="${contactSearch}"
             oninput="contactSearch=this.value;contactPage=0;renderContacts();" style="max-width:280px;" />
      <select onchange="contactSort=this.value;contactPage=0;renderContacts();"
              style="padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:13px;color:#1e293b;background:#fff;cursor:pointer;">
        <option value="created_at_desc" ${contactSort==='created_at_desc'?'selected':''}>&#128197; Newest First</option>
        <option value="created_at_asc"  ${contactSort==='created_at_asc'?'selected':''}>&#128197; Oldest First</option>
        <option value="name_asc"        ${contactSort==='name_asc'?'selected':''}>A&#8594;Z Name</option>
        <option value="name_desc"       ${contactSort==='name_desc'?'selected':''}>Z&#8594;A Name</option>
        <option value="company_asc"     ${contactSort==='company_asc'?'selected':''}>A&#8594;Z Company</option>
        <option value="sequence_status_asc" ${contactSort==='sequence_status_asc'?'selected':''}>Sequence Status</option>
      </select>
      <button class="btn btn-accent" onclick="openAddContact()">+ Add Contact</button>
      <button class="btn btn-outline" onclick="verifyAllEmails()" style="font-size:13px;" title="SMTP-verify unverified emails">&#128269; Verify All Emails</button>
      <span style="font-size:13px;color:var(--muted);margin-left:auto;" id="contacts-count">Loading...</span>
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
  if (contactSearch) q = q.or(`name.ilike.%${contactSearch}%,email.ilike.%${contactSearch}%,company.ilike.%${contactSearch}%`);
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
      <td style="font-size:13px;">${c.email || '—'}${emailBadge}</td>
      <td style="font-size:13px;">${c.company || '—'}${dncBadge}</td>
      <td>${c.type ? `<span class="badge ${badgeClass}">${c.type}</span>` : '—'}</td>
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
    ? `Showing ${offset + 1}–${offset + shown_count} ┬╖ more on next page`
    : `${offset + shown_count} contact${offset + shown_count !== 1 ? 's' : ''}${(contactPage || 0) > 0 ? ` (page ${(contactPage || 0) + 1})` : ''}`;

  document.getElementById('contacts-count').textContent = countLabel;
  document.getElementById('contacts-table-body').innerHTML = shown_count === 0
    ? `<div class="empty-state"><div class="emoji">&#128101;</div><p>${contactSearch || contactTypeFilter ? 'No contacts match your filter.' : 'No contacts yet. Add your first one!'}</p></div>`
    : `${pageNav}<table><thead><tr>
        <th>Name</th><th>Email</th><th>Company</th><th>Type</th><th>Sequence</th>
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
  });
}

function editContact(id) {
  const c = contacts.find(x => x.id === id); if (!c) return;
  const typeOptions = CONTACT_TYPES.map(t => `<option value="${t}" ${t===c.type?'selected':''}>${t}</option>`).join('');
  const canAssign = currentAgent.role !== 'agent';
  const agentOptions = canAssign
    ? allAgents.map(a => `<option value="${a.id}" ${a.id===c.agent_id?'selected':''}>${a.name} — ${a.agencies?.name||'No agency'}</option>`).join('')
    : '';
  const trackOptions = [['standard','Standard'],['state-farm','State Farm Agent']].map(([v,l]) => `<option value="${v}" ${(c.sequence_track||'standard')===v?'selected':''}>${l}</option>`).join('');
  const _verifiedAt = c.email_verified_at ? ` (verified ${new Date(c.email_verified_at).toLocaleDateString()})` : '';
  const emailStatusNote = (c.email_status === 'bounced' || c.email_status === 'invalid' || c.email_status === 'bad-domain' || c.email_status === 'bad-syntax')
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#dc2626;">&#9888; <strong>Invalid Email</strong>${_verifiedAt} &#8212; ${c.email_verify_reason||'rejected'}. Correct it below.<br><button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Re-verify</button></div>`
    : c.email_status === 'opted_out'
    ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#854d0e;">&#128683; <strong>Opted Out</strong> &#8212; uncheck below to restore.</div>`
    : c.email_status === 'valid'
    ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#16a34a;">&#10003; <strong>Email Verified</strong>${_verifiedAt}</div>`
    : c.email_status === 'risky'
    ? `<div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#6b7280;">? <strong>Risky</strong>${_verifiedAt}${c.email_verify_reason ? ' &#8212; '+c.email_verify_reason : ''}.<br><button type="button" class="btn btn-outline btn-sm" style="margin-top:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Re-verify</button></div>`
    : c.email_status === 'catch-all'
    ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#854d0e;">~ <strong>Catch-All Domain</strong>${_verifiedAt} &#8212; mailbox unconfirmed.</div>`
    : c.email_status === 'pending'
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#2563eb;">... <strong>Verifying...</strong> Refresh in a moment.</div>`
    : c.email && !c.email_status
    ? `<div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#6b7280;">Not verified. <button type="button" class="btn btn-outline btn-sm" style="margin-left:6px;font-size:11px;" onclick="verifyContactEmail('${c.id}')">&#128269; Verify Now</button></div>`
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
  `, async () => {
    const name = document.getElementById('con-name').value.trim();
    if (!name) { showToast('Name is required'); return false; }
    const assignedAgentId = canAssign ? (document.getElementById('con-agent').value || c.agent_id) : c.agent_id;
    const assignedAgent = allAgents.find(a => a.id === assignedAgentId) || currentAgent;
    const newOptOut  = document.getElementById('con-optout').checked;
    const newDnc     = document.getElementById('con-dnc').checked;
    const newEmail   = document.getElementById('con-email').value.trim() || null;
    // If email was bounced and a new email was entered, clear the bounce status
    // When email changes, clear status so trigger re-verifies it
    const newEmailStatus = (c.email_status === 'bounced' && newEmail && newEmail !== c.email) ? null
      : newOptOut ? 'opted_out'
      : (c.email_status === 'opted_out' && !newOptOut) ? null
      : c.email_status || null;
    const updates = { name, email: newEmail, phone: document.getElementById('con-phone').value.trim()||null, company: document.getElementById('con-company').value.trim()||null, city: document.getElementById('con-city').value.trim()||null, state: (document.getElementById('con-state').value.trim().toUpperCase())||null, type: document.getElementById('con-type').value||null, sequence_track: document.getElementById('con-track').value||'standard', notes: document.getElementById('con-notes').value.trim()||null, agent_id: assignedAgentId, agency_id: assignedAgent.agency_id||null, opt_out_email: newOptOut, do_not_call: newDnc, email_status: newEmailStatus };
    const { error } = await supabaseClient.from('contacts').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }

    // Update contact_companies if agent changed
    if (assignedAgentId !== c.agent_id) {
      await supabaseClient.from('contact_companies').delete().eq('contact_id', id);
      const { data: ac } = await supabaseClient.from('agent_companies').select('company_id').eq('agent_id', assignedAgentId);
      if (ac && ac.length > 0) await supabaseClient.from('contact_companies').insert(ac.map(r => ({ contact_id: id, company_id: r.company_id })));
    }

    Object.assign(c, updates); showToast('Contact updated!'); renderContacts(); closeContactPanel();
  });
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

async function verifyAllEmails() {
  const targets = contacts.filter(c => c.email && c.email_status !== 'valid' && c.email_status !== 'opted_out' && c.email_status !== 'pending');
  if (!targets.length) { showToast('No unverified emails to check'); return; }
  const msg = 'Verify ' + targets.length + ' email(s)?\n\nSends batches of 10 at a time — results update as each batch finishes.\n\nTip: use the type filter tabs to verify a smaller group first.';
  if (!confirm(msg)) return;

  const BATCH = 10;
  let totalValid = 0, totalBad = 0, done = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    chunk.forEach(ct => { ct.email_status = 'pending'; });
    renderContacts();
    showToast('Verifying ' + (i + 1) + '-' + Math.min(i + BATCH, targets.length) + ' of ' + targets.length + '...');
    try {
      const res = await fetch(SUPABASE_URL + '/functions/v1/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
        body: JSON.stringify({ emails: chunk.map(ct => ct.email), contact_ids: chunk.map(ct => ct.id) })
      });
      const data = await res.json();
      if (data.results) {
        data.results.forEach(r => {
          const ct = contacts.find(x => x.id === r.contact_id);
          if (ct) { ct.email_status = r.status; ct.email_verify_reason = r.reason || ''; ct.email_verified_at = new Date().toISOString(); }
          if (r.status === 'valid') totalValid++;
          else if (['invalid','bad-domain','bad-syntax','bounced'].includes(r.status)) totalBad++;
        });
        done += chunk.length;
      } else {
        showToast('Batch error: ' + (data.error || 'unknown'));
      }
    } catch (e) {
      showToast('Batch ' + Math.floor(i/BATCH + 1) + ' failed: ' + e.message);
    }
    renderContacts();
  }
  showToast('Done: ' + totalValid + ' valid, ' + totalBad + ' bad of ' + done + ' checked');
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
  if (isOptedOut) { showToast('This contact has opted out â€” cannot re-enroll.'); return; }
  if (c.email_status === 'bounced') { showToast('This contact has a bounced email â€” fix it first.'); return; }

  showModal('Start Sequence: ' + (c.name || 'Contact'), `
    <p style="margin:0 0 14px;color:#64748b;font-size:14px;">
      Choose a track below. <strong>${c.name || 'This contact'}</strong> will receive Email 1 on the next automation run (within 24 hours).
    </p>
    <label style="display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#374151;margin-bottom:6px;">Sequence Track</label>
    <select id="seq-track-select" style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:12px;">
      <option value="Individual/Family" ${cur === 'Individual/Family' ? 'selected' : ''}>B2C â€” Individual / Family</option>
      <option value="Group/Employer" ${cur === 'Group/Employer' ? 'selected' : ''}>B2B â€” Group / Employer</option>
      <option value="Recruit" ${cur === 'Recruit' ? 'selected' : ''}>Recruit â€” State Farm Agent</option>
    </select>
    <p style="font-size:11px;color:#94a3b8;margin:0;">Changing the track also updates the contact type. Any previous sequence progress is reset.</p>
  `, async () => {
    const track = document.getElementById('seq-track-select')?.value || cur;
    const updates = { type: track, sequence_status: null, sequence_step: 0, last_email_sent_at: null };
    const { error } = await supabaseClient.from('contacts').update(updates).eq('id', contactId);
    if (error) { showToast('Error: ' + error.message); return false; }
    Object.assign(c, updates);
    showToast('âœ“ Sequence queued! ' + (c.name || 'Contact') + ' gets Email 1 on the next run.');
    viewContact(contactId);
    return true;
  }, { confirmLabel: 'Start Sequence' });
}

function showModal(title, bodyHtml, onSave, opts = {}) {
  const confirmLabel = opts.confirmLabel || 'Save';
  const footer = opts.hideConfirm
    ? `<div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">Close</button></div>`
    : `<div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="handleModalSave()">${confirmLabel}</button></div>`;
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header"><h2>${title}</h2><button class="modal-close" onclick="closeModal()">&times;</button></div>
        <div class="modal-body">${bodyHtml}</div>
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
function setSyncUrl() {
  const saved = localStorage.getItem('crm_sync_url') || '';
  showModal('&#128257; Google Contacts Sync URL', `
    <p style="font-size:14px;color:var(--muted);margin-bottom:16px;">Paste the Apps Script Web App URL here. Deploy &rarr; Manage deployments &rarr; copy the URL.</p>
    <label>Web App URL</label>
    <input type="url" id="sync-url-input" value="${saved}" placeholder="https://script.google.com/macros/s/..." />
  `, () => {
    const url = document.getElementById('sync-url-input').value.trim();
    if (url) { localStorage.setItem('crm_sync_url', url); showToast('Sync URL saved!'); }
  });
}

async function syncGoogleContacts() {
  const url = localStorage.getItem('crm_sync_url');
  if (!url) { setSyncUrl(); return; }
  showToast('&#128257; Syncing Google Contacts...');
  try {
    await fetch(url, { mode: 'no-cors' });
    showToast('&#128257; Sync triggered! Google Contacts will update in ~30 seconds.');
  } catch(e) {
    showToast('Sync sent — check Apps Script logs if issues arise.');
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
        <div class="dash-card-title"><i class="ti ti-mail"></i>Gmail Connection</div>
        <div class="action-item">
          <div class="action-item-info">
            <div class="action-item-name">Gmail Account</div>
            <div class="action-item-sub">${currentAgent.gmail_connected ? (currentAgent.gmail_email || 'Connected') : 'Not connected — email sequences will not send'}</div>
          </div>
          ${currentAgent.gmail_connected
            ? `<span class="badge badge-active"><i class="ti ti-check"></i> Connected</span>`
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
      const name = a.booker_name || a.contact_name || 'Appointment';
      const time = a.scheduled_at ? new Date(a.scheduled_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
      return `<div onclick="event.stopPropagation();apptDetail('${a.id}')" style="font-size:10px;padding:2px 5px;border-radius:3px;background:${st.bg};border-left:2px solid ${st.border};color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;margin-bottom:2px;">${time ? time+' ' : ''}${name}</div>`;
    }).join('');
    const more = dayAppts.length > 3 ? `<div style="font-size:10px;color:var(--text-muted);padding-left:4px;">+${dayAppts.length-3} more</div>` : '';

    cells += `<div onclick="calDayClick('${dateKey}')" style="min-height:90px;padding:6px;border-right:0.5px solid var(--border);border-bottom:0.5px solid var(--border);cursor:pointer;background:${isToday ? 'rgba(200,168,75,0.08)' : 'transparent'};transition:background .1s;" onmouseover="this.style.background='${isToday ? 'rgba(200,168,75,0.12)' : 'var(--surface-1)'}'" onmouseout="this.style.background='${isToday ? 'rgba(200,168,75,0.08)' : 'transparent'}'">
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

    // Position events by hour
    const eventBlocks = dayAppts.map(a => {
      const dt = new Date(a.scheduled_at);
      const hr = dt.getHours(), mn = dt.getMinutes();
      const top = Math.max(0,(hr-7)*56 + Math.round(mn/60*56));
      const st = _calStatus(a.status);
      const name = a.booker_name || a.contact_name || 'Appt';
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      return `<div onclick="apptDetail('${a.id}')" style="position:absolute;left:2px;right:2px;top:${top}px;height:50px;background:${st.bg};border-left:3px solid ${st.border};border-radius:4px;padding:3px 5px;cursor:pointer;overflow:hidden;z-index:1;">
        <div style="font-size:10px;font-weight:600;color:var(--text-primary);line-height:1.2;">${name}</div>
        <div style="font-size:9px;color:var(--text-muted);">${timeStr}</div>
      </div>`;
    }).join('');

    const dow = wd.toLocaleDateString('en-US',{weekday:'short'});
    const dom = wd.getDate();
    return `<div style="flex:1;min-width:0;border-right:0.5px solid var(--border);">
      <div style="padding:8px 4px;text-align:center;background:${isToday?'rgba(200,168,75,0.1)':'var(--surface-1)'};border-bottom:0.5px solid var(--border);position:sticky;top:0;z-index:2;">
        <div style="font-size:10px;font-weight:600;color:${isToday?'var(--text-accent)':'var(--text-muted)'};text-transform:uppercase;letter-spacing:0.4px;">${dow}</div>
        <div style="font-size:${isToday?'18px':'14px'};font-weight:700;color:${isToday?'var(--text-accent)':'var(--text-primary)'};">${dom}</div>
      </div>
      <div style="position:relative;height:${14*56}px;">${eventBlocks}</div>
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

  const eventBlocks = dayAppts.map(a => {
    const dt = new Date(a.scheduled_at);
    const hr = dt.getHours(), mn = dt.getMinutes();
    const top = Math.max(0,(hr-7)*64 + Math.round(mn/60*64));
    const st = _calStatus(a.status);
    const name = a.booker_name || a.contact_name || 'Appointment';
    const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    const agentRow = allAgents.find(x=>x.id===a.agent_id);
    return `<div onclick="apptDetail('${a.id}')" style="position:absolute;left:4px;right:4px;top:${top}px;height:58px;background:${st.bg};border-left:4px solid ${st.border};border-radius:6px;padding:5px 10px;cursor:pointer;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${name}</div>
      <div style="font-size:11px;color:var(--text-muted);">${timeStr} ┬╖ ${a.appointment_label||a.appointment_type||'Appointment'}</div>
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
        <div style="font-size:12px;color:var(--text-muted);">${dayAppts.length} appointment${dayAppts.length!==1?'s':''}</div>
      </div>
      <div style="display:flex;">
        <div style="width:52px;flex-shrink:0;border-right:0.5px solid var(--border);">${timeCol}</div>
        <div style="flex:1;position:relative;min-height:${14*64}px;">${noAppts}${eventBlocks}</div>
      </div>
    </div>`;
}

function _calPending() {
  const el = document.getElementById('cal-pending');
  if (!el) return;
  // Include both unscheduled (pending) and proposals awaiting prospect reply (rescheduled)
  const unscheduled = calAppointments.filter(a =>
    !a.status || a.status === 'pending' || a.status === 'rescheduled'
  );
  if (unscheduled.length === 0) { el.innerHTML = ''; el.style.marginBottom = '0'; return; }
  el.style.marginBottom = '14px';
  el.innerHTML = `
    <div style="background:rgba(251,191,36,0.05);border:0.5px solid rgba(217,119,6,0.3);border-radius:10px;padding:10px 14px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#d97706;">⚠ Needs Attention</span>
        <span style="background:rgba(217,119,6,0.18);color:#b45309;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;">${unscheduled.length}</span>
      </div>
      <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin;">
        ${unscheduled.map(a => {
          const name = a.booker_name||a.contact_name||'—';
          const received = new Date(a.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'});
          // Status badge
          let badge = '', borderColor = '#d97706', btnLabel = '📋 Schedule';
          if (a.status === 'rescheduled' && a.rescheduled_by === 'agent') {
            badge = `<div style="font-size:10px;background:rgba(234,179,8,0.15);color:#b45309;border-radius:4px;padding:2px 6px;margin-bottom:5px;font-weight:600;">⚠ Awaiting prospect confirm</div>`;
            borderColor = '#d97706'; btnLabel = '📋 Update';
          } else if (a.status === 'rescheduled' && a.rescheduled_by === 'prospect') {
            badge = `<div style="font-size:10px;background:rgba(139,92,246,0.15);color:#7c3aed;border-radius:4px;padding:2px 6px;margin-bottom:5px;font-weight:600;">🔄 Prospect requested reschedule</div>`;
            borderColor = '#8b5cf6'; btnLabel = '📋 New Time';
          }
          // Show proposed time if rescheduled
          const proposedTime = a.scheduled_at && a.status === 'rescheduled'
            ? `<div style="font-size:11px;color:var(--text-primary);font-weight:500;margin-bottom:5px;">📅 ${new Date(a.scheduled_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</div>`
            : '';
          return `<div style="flex-shrink:0;width:230px;background:var(--surface-1);border:0.5px solid var(--border);border-left:3px solid ${borderColor};border-radius:8px;padding:9px 11px;">
            ${badge}
            <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:1px;">${name}</div>
            ${a.company ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.company}</div>` : ''}
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${a.appointment_label||a.appointment_type||'Appointment'} ┬╖ ${received}</div>
            ${proposedTime}
            <div style="display:flex;gap:4px;">
              <button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;flex:1;" onclick="apptSchedule('${a.id}')">${btnLabel}</button>
              <button class="btn btn-danger btn-sm" style="font-size:11px;padding:3px 8px;" onclick="apptCancel('${a.id}')">✕</button>
            </div>
          </div>`;
        }).join('')}
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
function apptDetail(id) {
  const a = calAppointments.find(x=>x.id===id);
  if (!a) return;
  const st = _calStatus(a.status);
  const agentRow = allAgents.find(x=>x.id===a.agent_id);
  const name = a.booker_name||a.contact_name||'—';
  const dtStr = a.scheduled_at ? new Date(a.scheduled_at).toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : 'Not scheduled';
  showModal(name, `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
      <span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${st.bg};border:1px solid ${st.border};color:var(--text-primary);">${st.label}</span>
      <span style="font-size:12px;color:var(--text-muted);">${a.appointment_label||a.appointment_type||'Appointment'}</span>
    </div>
    <div style="display:grid;gap:8px;font-size:13px;">
      ${a.company?`<div><span style="color:var(--text-muted);">Company:</span> ${a.company}</div>`:''}
      ${a.booker_email?`<div><span style="color:var(--text-muted);">Email:</span> ${a.booker_email}</div>`:''}
      <div><span style="color:var(--text-muted);">Date/Time:</span> ${dtStr}</div>
      ${agentRow?`<div><span style="color:var(--text-muted);">Agent:</span> ${agentRow.name}</div>`:''}
      ${a.note?`<div><span style="color:var(--text-muted);">Note:</span> <em>${a.note}</em></div>`:''}
      ${a.agent_notes?`<div><span style="color:var(--text-muted);">Internal notes:</span> ${a.agent_notes}</div>`:''}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:16px;">
      ${a.status!=='scheduled'?`<button class="btn btn-outline btn-sm" onclick="closeModal();apptSchedule('${id}')">📋 Schedule</button>`:''}
      ${a.status!=='completed'?`<button class="btn btn-outline btn-sm" onclick="closeModal();apptComplete('${id}')">✓ Complete</button>`:''}
      <button class="btn btn-outline btn-sm" onclick="closeModal();apptReschedule('${id}')">↺ Reschedule</button>
      ${a.status!=='cancelled'?`<button class="btn btn-danger btn-sm" onclick="closeModal();apptCancel('${id}')">✕ Cancel</button>`:''}
    </div>
  `, null);
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
    const updates = {
      status:         isPropose ? 'rescheduled' : 'scheduled',
      scheduled_at:   parsed.toISOString(),
      rescheduled_by: isPropose ? 'agent' : null,
      booker_email:   toEmail,
      ...(notes ? { agent_notes: notes } : {})
    };
    const { error } = await supabaseClient.from('booking_intents').update(updates).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return false; }
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
  const contactOptions = contacts.map(c=>`<option value="${c.id}">${c.name} — ${c.company||c.email||''}</option>`).join('');
  showModal('Log Appointment', `
    <label>Contact</label>
    <select id="appt-contact"><option value="">— No contact —</option>${contactOptions}</select>
    <label>Appointment Type</label>
    <input type="text" id="appt-type" placeholder="e.g. Discovery Call, Benefits Review..." />
    <label>Date &amp; Time</label>
    <input type="datetime-local" id="appt-dt" />
    <label>Notes</label>
    <textarea id="appt-notes" placeholder="Any context or details..."></textarea>
  `, async () => {
    const contactId = document.getElementById('appt-contact').value;
    const apptType  = document.getElementById('appt-type').value.trim();
    const dt        = document.getElementById('appt-dt').value;
    const notes     = document.getElementById('appt-notes').value.trim();
    if (!apptType) { showToast('Appointment type required'); return false; }
    const contact = contactId ? contacts.find(c=>c.id===contactId) : null;
    const newAppt = {
      agent_id: currentAgent.id, contact_id: contactId||null,
      contact_name: contact?.name||null, booker_name: contact?.name||null,
      booker_email: contact?.email||null, company: contact?.company||null,
      appointment_type: apptType, appointment_label: apptType,
      scheduled_at: dt?new Date(dt).toISOString():null,
      agent_notes: notes||null, status: dt?'scheduled':'pending',
    };
    const { data, error } = await supabaseClient.from('booking_intents').insert(newAppt).select().single();
    if (error) { showToast('Error: '+error.message); return false; }
    calAppointments.push(data);
    // Jump calendar to the appointment date if scheduled
    if (dt) { calDate = new Date(dt); calView = calDate.toDateString()===new Date().toDateString()?calView:'month'; }
    showToast('✓ Appointment added!');
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
