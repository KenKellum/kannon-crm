# Kannon CRM Upgrade Plan
**Created:** 2026-07-17  
**Status:** IN PROGRESS  
**Reference this file to stay on track.**

---

## What We Are Building

A professional-grade email activity system that:
- Handles every type of incoming email intelligently
- Replaces the notes text blob with a structured activities table
- Drives the dialer queue by lead score automatically
- Makes the UI effortless — agent sees exactly what happened and what to do next

---

## Phase 1 — Database (Supabase) ✅ IN PROGRESS

### 1A. Create `activities` table

Every system-generated event goes here as a structured row. One row per event, forever.

```sql
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL,
  subject TEXT,
  body_snippet TEXT,       -- capped at 400 chars
  metadata JSONB DEFAULT '{}',  -- type-specific: bounce_reason, meeting_time, ooo_return_date, etc.
  source TEXT DEFAULT 'system', -- 'email' | 'calendar' | 'manual' | 'system'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ      -- NULL = unread (drives notification badge)
);

CREATE INDEX idx_activities_contact_id ON activities(contact_id);
CREATE INDEX idx_activities_agent_id ON activities(agent_id);
CREATE INDEX idx_activities_type ON activities(activity_type);
CREATE INDEX idx_activities_created_at ON activities(created_at DESC);
```

### Activity Type Enum (activity_type values)
| Value | Description |
|---|---|
| `email_sent` | Outbound email sent by sequence or drip |
| `email_opened` | Contact opened the email (pixel tracked) |
| `email_clicked` | Contact clicked a link |
| `email_replied` | Contact sent a real reply |
| `email_bounced_hard` | Permanent delivery failure (bad address) |
| `email_bounced_soft` | Temporary failure (inbox full, server down) — retry |
| `email_blocked` | Rejected by spam/content filter |
| `email_opted_out` | Contact requested removal |
| `email_complained` | Contact hit "Report Spam" — URGENT |
| `email_auto_reply` | OOO / auto-responder — not a real reply |
| `meeting_booked` | Contact booked via Google Calendar scheduling page |
| `meeting_attended` | Meeting happened (future: calendar confirmation) |
| `meeting_no_show` | Contact booked but did not attend |
| `meeting_canceled` | Contact canceled their booking |
| `meeting_rescheduled` | Contact rescheduled to new time |
| `calendar_accepted` | Contact accepted a calendar invite |
| `calendar_declined` | Contact declined a calendar invite |
| `call_made` | Agent made a call (from dialer) |
| `call_connected` | Call was answered |
| `call_voicemail` | Left a voicemail |
| `note_added` | Manual note added by agent |
| `status_changed` | Contact status changed (audit trail) |

### metadata JSON by type (examples)
```json
// email_bounced_hard
{ "bounce_reason": "550 User unknown", "bounce_code": "550" }

// email_bounced_soft
{ "bounce_reason": "452 Inbox full", "soft_bounce_count": 2 }

// email_auto_reply / ooo
{ "ooo_return_date": "2026-07-25", "return_date_raw": "July 25" }

// meeting_booked / canceled / rescheduled
{ "meeting_time": "2026-07-17T21:30:00Z", "meeting_title": "Financial Services Consultation", "meeting_link": "meet.google.com/xxx" }

// email_replied / email_opted_out
{ "gmail_message_id": "FMfcgz..." }
```

### 1B. Add structured fields to `contacts` table

```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_replied_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS soft_bounce_count INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_bounce_reason TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS next_meeting_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ooo_return_date DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_score INT DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_complained_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sequence_paused_until TIMESTAMPTZ;
```

### Lead Score Formula
Activities automatically update lead_score on the contact:
| Activity | Score Delta |
|---|---|
| email_opened | +2 |
| email_clicked | +5 |
| email_replied | +15 |
| meeting_booked | +25 |
| meeting_attended | +30 |
| meeting_no_show | -5 |
| meeting_canceled | -2 |
| email_bounced_soft | -3 |
| email_bounced_hard | -50 (and stops all sends) |
| email_opted_out | -100 (and hard blocks all sends) |
| email_complained | -200 (and hard blocks all sends — reputation risk) |

### 1C. Supabase RPC functions needed
- `log_activity(contact_id, agent_id, activity_type, subject, body_snippet, metadata)` — inserts activity row + updates contact lead_score and relevant timestamp fields atomically
- `get_contact_timeline(contact_id)` — returns activities for a contact, newest first
- `get_unread_notifications(agent_id)` — returns unread activities for the notification bell
- `mark_notifications_read(agent_id)` — sets read_at on all unread activities

---

## Phase 2 — Apps Script / Code.gs

### What changes
- Replace `inboxUpdateContact_()` with `inboxLogActivity_()` — writes to activities table instead of appending text to notes
- Keep notes field for MANUAL notes only
- Add soft bounce tracking (count before treating as hard bounce — threshold: 3)
- Add sequence pause when meeting_booked fires

### New sequence_status value
Add `'Scheduled'` — used when a meeting is booked. Sequence pauses. No outreach emails go out. Agent manually resumes after the meeting (sets back to `'Active'` or `'Drip'` or advances to pipeline).

### Email handling rules (CODE.GS)

| Email Type | CRM Action | Gmail Disposition |
|---|---|---|
| Gmail quota notification | Trash only, no CRM action | TRASH |
| Appointment booked (CRM contact) | log meeting_booked, set Scheduled status, set Needs Attention, pause sequence | Archive |
| Appointment booked (unknown contact) | No CRM action | Keep in inbox unread — new lead |
| Appointment canceled | log meeting_canceled, resume sequence | Archive |
| Appointment rescheduled | log meeting_rescheduled, update next_meeting_at | Archive |
| Hard bounce | log email_bounced_hard, stop sequence, set email_status=bounced | Prospect→TRASH, Pipeline→Archive, Client→Archive |
| Soft bounce | log email_bounced_soft, increment soft_bounce_count (→ hard bounce at 3) | Prospect→TRASH, Pipeline→Archive, Client→Archive |
| Blocked | log email_blocked, stop sequence, set email_status=blocked | Prospect→TRASH, Pipeline→Archive, Client→Archive |
| OOO/Auto-reply | log email_auto_reply, extract return date | Prospect→TRASH, Pipeline→Archive, Client→Archive |
| Opt-out | log email_opted_out, set Opted Out, send ACK | TRASH |
| Real reply (prospect) | log email_replied, set Replied, set Needs Attention | Archive (work from CRM dialer) |
| Real reply (pipeline) | log email_replied, set Replied | KEEP IN INBOX |
| Real reply (client) | log email_replied | KEEP IN INBOX |

### Sequence pause logic
When `meeting_booked` fires:
- Set `sequence_status = 'Scheduled'`
- Set `sequence_paused_until = next_meeting_at + 1 day` (don't send day-of or day-after)
- Outreach sequence checks this field before sending — skips if `NOW() < sequence_paused_until`
- After meeting: agent manually sets status to next appropriate stage

---

## Phase 3 — UI (crm.js)

### 3A. Activity Timeline (replaces notes text blob on contact detail)

Replace the textarea notes field on the contact detail panel with a vertical activity timeline feed. Newest entry at top.

Each entry shows:
- Type icon (emoji or SVG icon)
- Activity type label
- Timestamp (relative: "2 hours ago", "Jul 15")
- Subject or content snippet
- Expandable to full detail on click

Manual notes can still be added — they show in the same timeline as `note_added` type, with a 📝 icon. The old notes text field gets hidden (data preserved, just not the primary UI).

**Icon system:**
| Type | Icon | Color |
|---|---|---|
| email_sent | 📧 | gray |
| email_opened | 👁 | blue |
| email_replied | 💬 | green |
| email_bounced_hard | ❌ | red |
| email_bounced_soft | ⚠️ | orange |
| email_blocked | 🚫 | red |
| email_opted_out | 🔕 | gray |
| email_complained | 🔥 | red — URGENT badge |
| email_auto_reply | 🤖 | gray |
| meeting_booked | 📅 | green |
| meeting_attended | ✅ | green |
| meeting_no_show | 👻 | orange |
| meeting_canceled | ❌ | orange |
| call_made | 📞 | gray |
| call_connected | 📞 | green |
| note_added | 📝 | yellow |
| status_changed | 🔄 | gray |

### 3B. Needs Attention section (expanded)

Ken confirmed: keep the current Needs Attention approach for appointments — agent confirms, not auto-processed.

Expand Needs Attention to include:
1. 📅 **Appointment Booked** — "[Contact] booked [Meeting] for [Date]" → [Confirm] button
2. 💬 **Reply Received** — "[Contact] replied to your email" → [Open in Dialer] button  
3. 👻 **No-Show** — "[Contact] missed their appointment on [Date]" → [Re-engage] button
4. ❌ **Meeting Canceled** — "[Contact] canceled [Meeting]" → [Re-engage] button
5. 🔥 **Spam Complaint** — "[Contact] marked your email as spam" → [Review] button (URGENT — show in red)

Each card: contact name, company, what happened, one clear action button.

### 3C. Dialer queue — auto-sort by lead score

Current queue is manually ordered. Replace with lead_score DESC sort.
- Contacts with replies and appointments float to top automatically
- Cold contacts with no engagement sink to bottom
- Agent always calls the hottest lead first without thinking about it

Show lead score as a small badge on each dialer card (e.g., "Score: 42").

### 3D. Notification bell in header

Small bell icon in the top nav with a red badge count of unread activity notifications.

Click opens a dropdown showing the last 10 high-priority unread activities:
- Reply received
- Meeting booked
- No-show
- Spam complaint

Each item links directly to that contact's record. Click = marks as read.

Only high-priority types trigger the bell (not every email_opened event — that would be noise).

### 3E. Contact card micro-indicators

On each contact card in the list view, show small status indicators:
- Last activity type + how long ago ("Replied 2d ago", "Opened 5h ago", "Booked Jul 17")
- Lead score badge
- Sequence status pill (Active / Replied / Scheduled / Drip / Stopped)

---

## Key Decisions (ALL CONFIRMED)

- [x] Keep Needs Attention approach for appointments — agent confirms
- [x] Start fresh — no notes migration. Old notes stay in notes field. Timeline fills from today.
- [x] Auto-resume to Drip 1 day after meeting date passes (system-driven)
- [x] Lead score auto-sort only — no manual override
- [x] No-show detection ON — system flags in Needs Attention, agent can correct (Mark Attended / Dismiss)

---

## Implementation Order

1. ✅ Phase 1A — Create activities table (Supabase migration)
2. ✅ Phase 1B — Add structured fields to contacts
3. ✅ Phase 1C — Create RPC functions
4. ✅ Phase 2 — Update Code.gs (inbox processor writes to activities)
5. ✅ Phase 3A — Activity timeline UI in contact detail
6. ⬜ Phase 3B — Expand Needs Attention section
7. ⬜ Phase 3C — Dialer queue lead score sort
8. ⬜ Phase 3D — Notification bell
9. ⬜ Phase 3E — Contact card micro-indicators

---

## Files

| File | Purpose |
|---|---|
| `C:\kannon-crm\crm.js` | Main CRM SPA — all UI changes go here |
| `C:\Users\kenke\OneDrive\Pictures\Code.gs` | Apps Script — inbox processor, Ken pastes into editor |
| `C:\kannon-crm\CRM_UPGRADE_PLAN.md` | THIS FILE — the plan |

## Supabase Project
- Project ID: `ilrylhseqnllmejebozq`
- Agent ID (Ken): `6cf9eeeb-694f-4db1-acfa-d9582bad6a00`
- Auth UID: `8f1c827b-e5f5-4f00-bd85-55d741111dd1`
