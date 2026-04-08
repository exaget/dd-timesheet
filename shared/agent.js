// shared/agent.js — Claude AI helpers + email HTML builders for timesheet app

const Anthropic = require("@anthropic-ai/sdk");

let anthropic;
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// ── Core Claude helper ────────────────────────────────────────────────────────

async function askClaude(messages, systemPrompt) {
  const r = await getAnthropic().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: systemPrompt,
    messages,
  });
  return r.content[0]?.text || "";
}

// ── Magic link email ──────────────────────────────────────────────────────────

function magicLinkHtml(name, magicLink) {
  return `<html><body style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px;color:#1e293b">
<div style="background:#0f2447;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:17px">DC TimeGenius — Login</h2>
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px">
  <p>Hi ${name || "there"},</p>
  <p>Click the button below to sign in to your timesheet. This link expires in <strong>30 minutes</strong> and can only be used once.</p>
  <p style="text-align:center;margin:32px 0">
    <a href="${magicLink}" style="background:#0f2447;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">Sign In to DC TimeGenius</a>
  </p>
  <p style="font-size:13px;color:#64748b">If you did not request this link, you can safely ignore this email. No action is needed.</p>
  <p style="font-size:13px;color:#94a3b8">If the button above doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all">${magicLink}</span></p>
</div>
</body></html>`;
}

// ── AI: parse a natural language time entry ───────────────────────────────────
//
// Returns structured JSON or null if parsing fails.
// staffProfile includes: name, employmentType, isSalaried, weeklyHours, dayOff
// context includes: today (YYYY-MM-DD), recentEntries (array of last 5 entries)

async function parseTimeEntry(text, staffProfile, context) {
  const today = context?.today || new Date().toISOString().slice(0, 10);
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(today + "T12:00:00Z").getUTCDay()];

  const recentStr = (context?.recentEntries || []).length > 0
    ? "Recent entries for context:\n" + context.recentEntries.map(e =>
        `  ${e.date}: ${e.type}${e.type==="work"?" "+e.startTime+"-"+e.endTime+" ("+e.totalHours+"hrs)":e.type==="leave"?" "+e.leaveType+" "+e.hours+"hrs":e.type==="volunteer"?" "+e.hours+"hrs":""}${e.taskDescription?" — "+e.taskDescription:""}`
      ).join("\n")
    : "";

  const dayOffHours = (() => {
    // Get the actual day-off hours from the active contract
    const history = staffProfile.contractHistory || [];
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(today + "T12:00:00Z").getUTCDay()];
    const active = [...history].filter(c => c.startDate <= today).sort((a,b) => b.startDate.localeCompare(a.startDate))[0];
    return active?.dayOffHrs || (staffProfile.weeklyHours ? staffProfile.weeklyHours / 5 : 8);
  })();

const todayDate = new Date(today + "T12:00:00Z");
const yesterday = new Date(todayDate); yesterday.setUTCDate(todayDate.getUTCDate()-1);
const yesterdayStr = yesterday.toISOString().slice(0,10);

const dayOfWeek = todayDate.getUTCDay(); // 0=Sun, 1=Mon...

// Find this week's Monday, then last week's Monday as anchor
const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
const thisMonday = new Date(todayDate);
thisMonday.setUTCDate(todayDate.getUTCDate() - daysToMonday);
const lastWeekMonday = new Date(thisMonday);
lastWeekMonday.setUTCDate(thisMonday.getUTCDate() - 7);

const lastWeekDates = {};
const dayNames2 = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
for (let i = 0; i < 7; i++) {
  const d = new Date(lastWeekMonday);
  d.setUTCDate(lastWeekMonday.getUTCDate() + i);
  lastWeekDates[dayNames2[i]] = d.toISOString().slice(0, 10);
}

const system = `You are an expert timesheet assistant for DC TimeGenius (Doddridge Centre staff timesheet system).
Today is ${today} (${dayName}). Yesterday was ${yesterdayStr}.
Last week's dates: Monday=${lastWeekDates.monday}, Tuesday=${lastWeekDates.tuesday}, Wednesday=${lastWeekDates.wednesday}, Thursday=${lastWeekDates.thursday}, Friday=${lastWeekDates.friday}, Saturday=${lastWeekDates.saturday}, Sunday=${lastWeekDates.sunday}.
When the user says "last [day]", use the exact date from the list above. No calculation needed.
Current pay period: ${context?.periodStart || today} to ${context?.periodEnd || today}.
Staff member: ${staffProfile.name}, ${staffProfile.employmentType || "employee"}, ${staffProfile.weeklyHours || 37.5} hours/week.
Standard day off: ${dayOffHours} hours.
${recentStr}

Parse the user's natural language input into one or more structured timesheet entries. Return a JSON object with an "entries" array.

Output ONLY valid JSON (no preamble, no markdown fences):
{
  "entries": [
    {
      "type": "work" | "leave" | "volunteer",
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM",       // work only
      "endTime": "HH:MM",         // work only
      "totalHours": 0.0,          // work: calculated from start/end
      "leaveType": "annual" | "sick" | "lieu" | "unpaid",  // leave only
      "hours": 0.0,               // leave and volunteer
      "taskDescription": "...",   // volunteer (optional for work)
      "isAmbiguous": false,       // true if AM/PM was assumed
      "anomaly": null | "string"
    }
  ]
}

MULTIPLE ENTRIES: If the user provides multiple time ranges or entries (separated by "and", commas, or new lines), create a separate entry for each one.

DATE RANGES FOR LEAVE: If the user specifies a leave date range (e.g. "annual leave from 2/8 to 4/8"), create a separate entry for every single day in the range, each with ${dayOffHours} hours.

DATE PARSING RULES:
- Input may be in DD/MM/YYYY format — convert to YYYY-MM-DD output
- "today", "this morning" → ${today}
- "yesterday" → day before today
- "Monday", "last Tuesday" → resolve relative to today
- YEAR DISAMBIGUATION: When year is omitted, choose the year placing the date closest to the current pay period end (${context?.periodEnd || today}). Prefer past over future. Example: if period end is 2026-01-16 and user says "Dec 20", use 2025-12-20.

TIME PARSING RULES:
- Output times in 24-hour HH:MM format
- "9 to 5" = 09:00 to 17:00 (standard work day)
- "1 to 3" = 13:00 to 15:00 (afternoon default for ambiguous short times)
- If AM/PM is genuinely ambiguous, set isAmbiguous: true and use most logical interpretation
- NEVER ask for clarification — always make a best-effort parse

WORK ENTRIES:
- Must have explicit start AND end time — "4 hours" alone is not valid for work, return empty entries array
- Calculate totalHours from startTime and endTime
- Flag as anomaly if: total > 12hrs, crosses midnight, or falls on a weekend

LEAVE ENTRIES:
- If only a date is given (no hours/times), assume full day = ${dayOffHours} hours
- If a time range is given (e.g. "sick leave 1pm to 4pm"), calculate hours from the range
- Default leave type to "annual" if not specified
- Recognised types: "sick leave"/"sick" → sick, "annual leave"/"holiday" → annual, "time in lieu"/"lieu" → lieu, "unpaid" → unpaid

VOLUNTEER ENTRIES:
- Extract hours and task description
- Date rules same as above`;

  try {
    const raw = await askClaude([{ role: "user", content: text }], system);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    // Handle both new {entries:[]} format and legacy single-entry format
    if (parsed.entries) return parsed;
    return { entries: [parsed] };
  } catch (e) {
    return null;
  }
}

// ── AI: detect anomalies in a set of entries ──────────────────────────────────
//
// Returns an array of { entryId, date, description } anomaly objects.

async function detectAnomalies(entries, staffProfile) {
  if (!entries || entries.length === 0) return [];

  const entriesStr = entries.map(e =>
    `${e.date} [${e.id}]: ${e.type}` +
    (e.type === "work" ? ` ${e.startTime}-${e.endTime} (${e.totalHours}hrs)` : "") +
    (e.type === "leave" ? ` ${e.leaveType} ${e.hours}hrs` : "") +
    (e.type === "volunteer" ? ` ${e.hours}hrs${e.taskDescription ? " — " + e.taskDescription : ""}` : "")
  ).join("\n");

  // Get active contract details for richer anomaly context
  const contractHistory = staffProfile.contractHistory || [];
  const todayStr = new Date().toISOString().slice(0, 10);
  const activeContract = [...contractHistory]
    .filter(c => c.startDate <= todayStr)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const contractedHrsPerMonth = activeContract?.contractedHrsPerMonth || 0;
  const dayOffHrs = activeContract?.dayOffHrs || 0;
  const hourlyRate = activeContract?.hourlyRate || 0;
  const expectedDailyHrs = staffProfile.weeklyHours
    ? staffProfile.weeklyHours / 5
    : contractedHrsPerMonth / 21;

  // Build approved patterns context from recent history
  const approvedEntries = (staffProfile.recentApprovedEntries || []);
  const patternContext = approvedEntries.length > 0
    ? `\n\nPreviously approved patterns for this staff member (do NOT flag similar entries):\n` +
      approvedEntries.map(e =>
        `- ${e.type}${e.type==='work' ? ` ${e.startTime}-${e.endTime} (${e.totalHours}hrs)` : e.type==='leave' ? ` ${e.leaveType} ${e.hours}hrs` : ` ${e.hours}hrs`}` +
        (e.approvalNote ? ` [${e.approvalNote}]` : '')
      ).join('\n')
    : '';

  const system = `You are a payroll analyst reviewing timesheet entries for ${staffProfile.name}.
Employment: ${staffProfile.employmentType || "employee"}, ${staffProfile.weeklyHours || (contractedHrsPerMonth / 4.33).toFixed(1)} hrs/week${staffProfile.isSalaried ? ", salaried" : ", hourly @ £" + hourlyRate + "/hr"}.
Contracted: ${contractedHrsPerMonth} hrs/month. Day off allowance: ${dayOffHrs} hrs. Expected daily hours: ${expectedDailyHrs.toFixed(1)}.${patternContext}

Review these entries and identify any genuine anomalies. Output ONLY a JSON array (no preamble):
[{ "entryId": "...", "date": "YYYY-MM-DD", "description": "brief plain-English description of the anomaly" }]

Look for:
- Unusually long shifts (>${Math.max(10, expectedDailyHrs * 2).toFixed(0)} hours)
- Overnight shifts (end time before start time)
- Duplicate entries for the same date
- Very short work entries (<1 hour, unless clearly intentional)
- Missing entries for working days in the period (flag gaps of 3+ consecutive weekdays with no entry of any type)
- Leave hours exceeding the expected daily hours (${expectedDailyHrs.toFixed(1)} hrs)
- Weekend work entries (Saturday/Sunday) — flag unless they look intentional (e.g. events)

Only flag genuine concerns. Do not flag entries that match the staff member's normal working pattern.
If no anomalies are found, return an empty array: []`;

  try {
    const raw = await askClaude([{ role: "user", content: entriesStr }], system);
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    return [];
  }
}

// ── AI: generate a plain-English payroll summary ──────────────────────────────

async function generateReportSummary(entries, staffProfile, period) {
  if (!entries || entries.length === 0) return "No entries found for this period.";

  // Pre-calculate totals to guide the summary
  const workHours = entries.filter(e => e.type === "work").reduce((s, e) => s + (e.totalHours || 0), 0);
  const leaveByType = {};
  entries.filter(e => e.type === "leave").forEach(e => {
    leaveByType[e.leaveType] = (leaveByType[e.leaveType] || 0) + (e.hours || 0);
  });
  const volunteerHours = entries.filter(e => e.type === "volunteer").reduce((s, e) => s + (e.hours || 0), 0);

  const summaryData = `Period: ${period.start} to ${period.end}
Staff: ${staffProfile.name} (${staffProfile.employmentType}, ${staffProfile.weeklyHours}hrs/week)
Work hours logged: ${workHours.toFixed(1)}
Leave: ${Object.entries(leaveByType).map(([k,v]) => k + " " + v + "hrs").join(", ") || "none"}
Volunteer hours: ${volunteerHours.toFixed(1)}
Total entries: ${entries.length}`;

  const system = `You are a payroll assistant. Write a concise 2-3 sentence plain-English summary of the timesheet period. Be factual and neutral. Mention total hours worked, any leave taken, and flag if hours look significantly under or over the expected amount. Expected hours for the period: ${(staffProfile.weeklyHours || 37.5) / 5 * countWorkingDays(period.start, period.end)} hours.`;

  try {
    return await askClaude([{ role: "user", content: summaryData }], system);
  } catch (e) {
    return `${period.start} to ${period.end}: ${workHours.toFixed(1)} work hours, ${Object.entries(leaveByType).map(([k,v]) => v + "hrs " + k + " leave").join(", ") || "no leave"}.`;
  }
}

function countWorkingDays(startDate, endDate) {
  let count = 0;
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

// ── Leave request email templates ────────────────────────────────────────────

function leaveReceiptHtml(staffName, entries, leaveType) {
  const dates = entries.map(e => new Date(e.date+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'long',year:'numeric'}));
  const dateStr = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length-1]} (${dates.length} days)`;
  const typeLabel = { annual:'Annual Leave', sick:'Sick Leave', lieu:'Time off in Lieu', unpaid:'Unpaid Leave' }[leaveType] || leaveType;
  return `<html><body style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px;color:#1e293b">
<div style="background:#0f2447;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:17px">DC TimeGenius — Leave Request Received</h2>
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px">
  <p>Hi ${staffName},</p>
  <p>Your leave request has been received and is <strong>pending approval</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0">
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;width:40%">Leave Type</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${typeLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600">Date(s)</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${dateStr}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600">Total Hours</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${entries.reduce((s,e)=>s+(e.hours||0),0).toFixed(1)} hrs</td></tr>
  </table>
  <p>You will receive a confirmation email once your request has been approved or if there are any questions.</p>
  <p style="font-size:13px;color:#94a3b8">If you submitted this in error, please contact your manager or <a href="mailto:cd@doddridgecentre.org.uk">Rachel Bott</a>.</p>
</div>
</body></html>`;
}

function leaveApprovalRequestHtml(staffName, approverName, entries, leaveType, approveUrl, rejectUrl) {
  const dates = entries.map(e => new Date(e.date+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'long',year:'numeric'}));
  const dateStr = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length-1]} (${dates.length} days)`;
  const typeLabel = { annual:'Annual Leave', sick:'Sick Leave', lieu:'Time off in Lieu', unpaid:'Unpaid Leave' }[leaveType] || leaveType;
  return `<html><body style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px;color:#1e293b">
<div style="background:#0f2447;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:17px">DC TimeGenius — Leave Request Pending Approval</h2>
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px">
  <p>Hi ${approverName},</p>
  <p><strong>${staffName}</strong> has requested leave that requires your approval.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0">
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;width:40%">Staff Member</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${staffName}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600">Leave Type</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${typeLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600">Date(s)</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${dateStr}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600">Total Hours</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${entries.reduce((s,e)=>s+(e.hours||0),0).toFixed(1)} hrs</td></tr>
  </table>
  <p style="text-align:center;margin:32px 0">
    <a href="${approveUrl}" style="background:#166534;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin-right:12px">✓ Approve</a>
    <a href="${rejectUrl}" style="background:#991b1b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">✗ Reject</a>
  </p>
  <p style="font-size:13px;color:#94a3b8">These links expire in 7 days. You can also manage leave requests by logging in to <a href="https://timesheets.doddridgecentre.org.uk">DC TimeGenius</a>.</p>
</div>
</body></html>`;
}

function leaveApprovedHtml(staffName, entries, leaveType) {
  const dates = entries.map(e => new Date(e.date+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'long',year:'numeric'}));
  const dateStr = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length-1]} (${dates.length} days)`;
  const typeLabel = { annual:'Annual Leave', sick:'Sick Leave', lieu:'Time off in Lieu', unpaid:'Unpaid Leave' }[leaveType] || leaveType;
  return `<html><body style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px;color:#1e293b">
<div style="background:#166534;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:17px">DC TimeGenius — Leave Request Approved ✓</h2>
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px">
  <p>Hi ${staffName},</p>
  <p>Your leave request has been <strong style="color:#166534">approved</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0">
    <tr><td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-weight:600;width:40%">Leave Type</td><td style="padding:8px 12px;border:1px solid #bbf7d0">${typeLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-weight:600">Date(s)</td><td style="padding:8px 12px;border:1px solid #bbf7d0">${dateStr}</td></tr>
    <tr><td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-weight:600">Total Hours</td><td style="padding:8px 12px;border:1px solid #bbf7d0">${entries.reduce((s,e)=>s+(e.hours||0),0).toFixed(1)} hrs</td></tr>
  </table>
  <p>Your leave has been recorded in DC TimeGenius.</p>
</div>
</body></html>`;
}

function leaveRejectedHtml(staffName, entries, leaveType) {
  const dates = entries.map(e => new Date(e.date+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'long',year:'numeric'}));
  const dateStr = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length-1]} (${dates.length} days)`;
  const typeLabel = { annual:'Annual Leave', sick:'Sick Leave', lieu:'Time off in Lieu', unpaid:'Unpaid Leave' }[leaveType] || leaveType;
  return `<html><body style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px;color:#1e293b">
<div style="background:#991b1b;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:17px">DC TimeGenius — Leave Request Not Approved</h2>
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px">
  <p>Hi ${staffName},</p>
  <p>Unfortunately your leave request has <strong style="color:#991b1b">not been approved</strong> at this time.</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0">
    <tr><td style="padding:8px 12px;background:#fff1f2;border:1px solid #fecdd3;font-weight:600;width:40%">Leave Type</td><td style="padding:8px 12px;border:1px solid #fecdd3">${typeLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#fff1f2;border:1px solid #fecdd3;font-weight:600">Date(s)</td><td style="padding:8px 12px;border:1px solid #fecdd3">${dateStr}</td></tr>
  </table>
  <p>Your leave entry remains in the system as pending. Please speak with your manager or contact <a href="mailto:cd@doddridgecentre.org.uk">Rachel Bott</a> if you have any questions.</p>
</div>
</body></html>`;
}

module.exports = {
  askClaude,
  magicLinkHtml,
  leaveReceiptHtml,
  leaveApprovalRequestHtml,
  leaveApprovedHtml,
  leaveRejectedHtml,
  parseTimeEntry,
  detectAnomalies,
  generateReportSummary,
};
