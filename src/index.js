// src/index.js — Azure Functions v4 HTTP endpoints for Doddridge Timesheet app

const { app } = require("@azure/functions");
const cosmos  = require("./shared/cosmos");
const graph   = require("./shared/graph");
const agent   = require("./shared/agent");

// Self-registering modules — each calls app.http() on load
require("./kioskwebhook");  // POST /api/kiosk/timesheet-entry

const BASE_URL    = process.env.APP_BASE_URL || "https://timesheets.doddridgecentre.org.uk";
const FUNC_URL    = process.env.FUNC_URL || "https://doddridge-timesheet-we.azurewebsites.net";
const VISITOR_URL = process.env.VISITOR_API_URL || "https://doddridge-visitor-we.azurewebsites.net";
const CD_EMAIL  = "cd@doddridgecentre.org.uk";
const CD_NAME   = "Rachel Bott";
const MONTHS    = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Response helpers ──────────────────────────────────────────────────────────

function json(data, status = 200) {
  return { status, jsonBody: data };
}

function err(msg, status = 400) {
  return { status, jsonBody: { error: msg } };
}

function errFromException(e, context) {
  const msg = e?.message || String(e);
  return { status: 500, jsonBody: { error: `Internal error: ${msg}` } };
}


// ── Warmup trigger — pre-warms Cosmos connection when function app starts ─────
app.http("warmup", {
  methods: ["GET"],
  route: "warmup",
  handler: async (req, context) => {
    try {
      await cosmos.queryItems("authTokens", "SELECT TOP 1 c.id FROM c");
    } catch {}
    return { status: 200, body: "ok" };
  },
});

// ── POST /api/kiosk/qr-scan — proxy to visitor API ───────────────────────────
// Keeps VISITOR_PROXY_KEY off the browser. The authenticated TimeGenius user
// calls this, and the backend forwards to the visitor API with the key attached.

app.http("kioskQrScan", {
  methods: ["POST"],
  route: "kiosk/qr-scan",
  handler: async (req, context) => {
    try {
      const staff = await requireAuth(req);
      if (!staff) return err("Unauthorised", 401);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      const { token } = body;
      if (!token) return err("token is required");

      const visitorKey = process.env.VISITOR_PROXY_KEY;
      if (!visitorKey) return err("Visitor API not configured", 503);

      const res = await fetch(`${VISITOR_URL}/api/kiosk/qr-scanned`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-visitor-key": visitorKey,
        },
        body: JSON.stringify({
          token,
          staffId:   staff.id,
          staffName: staff.name,
          method:    "qr",
        }),
      });

      const data = await res.json().catch(() => ({}));
      return json(data, res.status);
    } catch (e) {
      return errFromException(e, "kioskQrScan");
    }
  },
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getSessionToken(req) {
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url);
  return url.searchParams.get("session") || null;
}

async function requireAuth(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = await cosmos.validateSession(token);
  if (!session) return null;
  // Webmaster fallback — no Cosmos document exists for this account
  if (session.staffId === "staff_webmaster") {
    return {
      id:   "staff_webmaster",
      name: "Webmaster",
      email: "webmaster@doddridgecentre.org.uk",
      access: { timesheets: "admin" },
      timesheetProfile: { employmentType: "employee", weeklyHours: 37.5 },
    };
  }
  return cosmos.getStaffById(session.staffId);
}

async function requireAdmin(req) {
  const staff = await requireAuth(req);
  if (!staff) return null;
  if (staff.access?.timesheets !== "admin") return null;
  return staff;
}

async function requireAdminOrManager(req) {
  const staff = await requireAuth(req);
  if (!staff) return null;
  const role = staff.access?.timesheets;
  if (role !== "admin" && role !== "manager") return null;
  return staff;
}

// ── POST /api/auth/request-link ───────────────────────────────────────────────

app.http("authRequestLink", {
  methods: ["POST"],
  route: "auth/request-link",
  handler: async (req, context) => {
    try {
      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      const email = (body.email || "").toLowerCase().trim();
      if (!email) return err("email is required");

      let staff = await cosmos.getStaffByEmail(email);

      // Hardcoded fallback: webmaster@ always works, even if staff container is empty.
      if (!staff && email === "webmaster@doddridgecentre.org.uk") {
        staff = {
          id:   "staff_webmaster",
          name: "Webmaster",
          email,
          access: { timesheets: "admin" },
          timesheetProfile: { employmentType: "employee", weeklyHours: 37.5 },
        };
      }

      if (!staff) {
        return json({ ok: true, message: "If that email is registered, a login link has been sent." });
      }

      const token = await cosmos.createAuthToken(email, staff.id);
      const magicLink = `${BASE_URL}/verify?token=${token}`;
      const html = agent.magicLinkHtml(staff.name, magicLink);

      await graph.sendMail(email, "Your DC TimeGenius Login Link", html);
      await cosmos.writeAudit("auth.link_requested", staff, {
        detail: `Magic link requested for ${email}`,
      });
      return json({ ok: true, message: "Login link sent. Check your email." });
    } catch (e) {
      return errFromException(e, "authRequestLink");
    }
  },
});

// ── GET /api/auth/verify?token=... ────────────────────────────────────────────

app.http("authVerify", {
  methods: ["GET"],
  route: "auth/verify",
  handler: async (req, context) => {
    try {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (!token) return err("Missing token", 400);

      const corsHeaders = {
        "Access-Control-Allow-Origin":  BASE_URL,
        "Access-Control-Allow-Methods": "GET",
        "Vary": "Origin",
      };

      const authDoc = await cosmos.validateAuthToken(token);
      if (!authDoc) {
        await cosmos.writeAudit("auth.login_failed", null, {
          detail: "Invalid or expired magic link token used",
          targetId: token?.slice(0, 8) + "...",
        });
        return {
          status: 302,
          headers: { ...corsHeaders, Location: `${BASE_URL}/verify?error=invalid_token` },
          body: "",
        };
      }

      const sessionToken = await cosmos.createSession(authDoc.staffId, authDoc.email);

      // Audit: log successful login
      const loginStaff = await cosmos.getStaffById(authDoc.staffId).catch(() => null);
      await cosmos.writeAudit("auth.login_success", loginStaff || { id: authDoc.staffId, name: authDoc.email, access: {} }, {
        detail: "Login via magic link",
      });

      return {
        status: 302,
        headers: {
          ...corsHeaders,
          Location: `${BASE_URL}/verify?session=${sessionToken}`,
          "Set-Cookie": `ts_session=${sessionToken}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${7 * 24 * 60 * 60}`,
        },
        body: "",
      };
    } catch (e) {
      return errFromException(e, "authVerify");
    }
  },
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

app.http("authMe", {
  methods: ["GET"],
  route: "auth/me",
  handler: async (req, context) => {
    try {
      const staff = await requireAuth(req);
      if (!staff) return err("Unauthorised", 401);
      return json({ staff });
    } catch (e) {
      return errFromException(e, "authMe");
    }
  },
});

// ── GET /api/staff ────────────────────────────────────────────────────────────

app.http("staffList", {
  methods: ["GET"],
  route: "staff",
  handler: async (req, context) => {
    try {
      const caller = await requireAdminOrManager(req);
      if (!caller) return err("Forbidden", 403);
      const allStaff = await cosmos.getAllStaff();
      // Managers only see their direct reports
      const isManager = caller.access?.timesheets === "manager";
      const staff = isManager
        ? allStaff.filter(s => s.managerId === caller.id)
        : allStaff;
      return json({ staff });
    } catch (e) {
      return errFromException(e, "staffList");
    }
  },
});

// ── GET /api/staff/me ─────────────────────────────────────────────────────────

app.http("staffMe", {
  methods: ["GET"],
  route: "staff/me",
  handler: async (req, context) => {
    try {
      const staff = await requireAuth(req);
      if (!staff) return err("Unauthorised", 401);
      return json({ staff });
    } catch (e) {
      return errFromException(e, "staffMe");
    }
  },
});

// ── GET /api/staff/:id ────────────────────────────────────────────────────────

app.http("staffGet", {
  methods: ["GET"],
  route: "staff/{id}",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);
      const id = req.params.id;
      if (caller.id !== id && caller.access?.timesheets !== "admin") return err("Forbidden", 403);
      const staff = await cosmos.getStaffById(id);
      if (!staff) return err("Not found", 404);
      return json({ staff });
    } catch (e) {
      return errFromException(e, "staffGet");
    }
  },
});

// ── PUT /api/staff/:id ────────────────────────────────────────────────────────

app.http("staffUpdate", {
  methods: ["PUT"],
  route: "staff/{id}",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const id = req.params.id;
      const isAdmin = caller.access?.timesheets === "admin";
      if (caller.id !== id && !isAdmin) return err("Forbidden", 403);

      const existing = await cosmos.getStaffById(id);
      if (!existing) return err("Not found", 404);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      let updated;
      if (isAdmin) {
        const { id: _id, ...rest } = body;
        updated = { ...existing, ...rest, id };
      } else {
        const allowed = ["phone", "emergencyContact"];
        const patch = {};
        for (const k of allowed) { if (k in body) patch[k] = body[k]; }
        updated = { ...existing, ...patch };
      }

      const saved = await cosmos.upsertStaff(updated);
      await cosmos.writeAudit("staff.updated", caller, {
        targetId: saved.id, targetName: saved.name, targetType: "staff",
        detail: `Updated staff member: ${saved.name} (access: ${saved.access?.timesheets||"user"})`,
      });
      return json({ staff: saved });
    } catch (e) {
      return errFromException(e, "staffUpdate");
    }
  },
});

// ── POST /api/staff ───────────────────────────────────────────────────────────

app.http("staffCreate", {
  methods: ["POST"],
  route: "staff",
  handler: async (req, context) => {
    try {
      const admin = await requireAdmin(req);
      if (!admin) return err("Forbidden", 403);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      if (!body.name || !body.email) return err("name and email are required");

      const existing = await cosmos.getStaffByEmail(body.email);
      if (existing) return err("A staff member with that email already exists");

      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const id = `staff_${slug}_${Date.now().toString(36)}`;

      const staff = {
        id,
        name: body.name,
        email: body.email.toLowerCase().trim(),
        access: body.access || { timesheets: "user" },
        timesheetProfile: body.timesheetProfile || {
          employmentType: "employee",
          isSalaried: false,
          isVolunteer: false,
          weeklyHours: 37.5,
          leaveEntitlements: { annual: 25, sick: 10 },
          overtimeBanking: { enabled: false, balance: 0 },
          history: [],
        },
        createdAt: nowLondon(),
      };

      const saved = await cosmos.upsertStaff(staff);
      await cosmos.writeAudit("staff.created", admin, {
        targetId: saved.id, targetName: saved.name, targetType: "staff",
        detail: `Created staff member: ${saved.name} (${saved.access?.timesheets || "user"})`,
      });
      return json({ staff: saved }, 201);
    } catch (e) {
      return errFromException(e, "staffCreate");
    }
  },
});

// ── GET /api/entries ──────────────────────────────────────────────────────────

app.http("entriesList", {
  methods: ["GET"],
  route: "entries",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const url     = new URL(req.url);
      const staffIdParam = url.searchParams.get("staffId");
      const start   = url.searchParams.get("start");
      const end     = url.searchParams.get("end");

      if (!start || !end) return err("start and end query params are required");

      const isAdmin   = caller.access?.timesheets === "admin";
      const isManager = caller.access?.timesheets === "manager";

      // staffId=all — admin gets everyone, manager gets direct reports only
      if (staffIdParam === "all") {
        if (!isAdmin && !isManager) return err("Forbidden", 403);
        const entries = await cosmos.getEntriesByPeriod(start, end);
        if (isManager) {
          // Filter to direct reports only
          const allStaff = await cosmos.getAllStaff();
          const directReportIds = new Set(allStaff.filter(s => s.managerId === caller.id).map(s => s.id));
          return json({ entries: entries.filter(e => directReportIds.has(e.staffId)) });
        }
        return json({ entries });
      }

      const staffId = staffIdParam || caller.id;
      if (staffId !== caller.id && !isAdmin) return err("Forbidden", 403);

      const entries = await cosmos.getEntriesByStaffAndPeriod(staffId, start, end);
      return json({ entries });
    } catch (e) {
      return errFromException(e, "entriesList");
    }
  },
});

// ── POST /api/entries ─────────────────────────────────────────────────────────

app.http("entriesCreate", {
  methods: ["POST"],
  route: "entries",
  handler: async (req, context) => {
    let caller;
    try {
      caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      if (!body.type || !body.date) {
        await cosmos.writeAudit("entry.create_failed", caller, { detail: "type and date are required", reason: "validation" });
        return err("type and date are required");
      }
      if (!["work", "leave", "volunteer"].includes(body.type)) {
        await cosmos.writeAudit("entry.create_failed", caller, { detail: `Invalid type: ${body.type}`, reason: "validation" });
        return err("type must be work, leave, or volunteer");
      }
      if (body.type === "work" && (!body.startTime || !body.endTime)) {
        await cosmos.writeAudit("entry.create_failed", caller, { detail: "startTime and endTime required for work entries", reason: "validation" });
        return err("startTime and endTime required for work entries");
      }
      if (body.type === "leave" && !body.leaveType) {
        await cosmos.writeAudit("entry.create_failed", caller, { detail: "leaveType required for leave entries", reason: "validation" });
        return err("leaveType required for leave entries");
      }

      const isAdmin = caller.access?.timesheets === "admin";
      const staffId = body.staffId || caller.id;
      if (staffId !== caller.id && !isAdmin) {
        await cosmos.writeAudit("entry.create_failed", caller, { targetName: staffId, detail: `Forbidden: cannot create entry for ${staffId}`, reason: "forbidden" });
        return err("Forbidden", 403);
      }

      // Determine source: admin submitting on behalf of someone else = "admin", otherwise "user"
      const source      = (isAdmin && staffId !== caller.id) ? "admin" : (body.source || "user");
      const createdBy   = caller.id;
      const createdByName = caller.name;

      if (body.type === "work" && body.startTime && body.endTime) {
        const [sh, sm] = body.startTime.split(":").map(Number);
        const [eh, em] = body.endTime.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        body.totalHours = Math.round((mins / 60) * 100) / 100;
      }

      // Admin work/volunteer entries submitted on behalf of someone else are auto-approved.
      // Leave entries always follow the normal approval workflow regardless of who submits them.
      const autoStatus = source === "admin" && body.type !== "leave" ? "approved" : undefined;

      // Future leave (from tomorrow onwards) needs manager approval — applies to all roles including admin
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);
      const isFutureLeave = body.type === "leave" && body.date >= tomorrowStr;
      const leaveRequestId = isFutureLeave
        ? (body.leaveRequestId || `lr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`)
        : undefined;
      const entryStatus = autoStatus || (isFutureLeave ? "leave_pending" : undefined);

      const entry = { ...body, staffId, source, createdBy, createdByName, createdAt: nowLondon(),
        ...(entryStatus   ? { status: entryStatus }     : {}),
        ...(leaveRequestId ? { leaveRequestId }         : {}),
      };
      const saved = await cosmos.upsertEntry(entry);
      await cosmos.writeAudit("entry.created", caller, {
        targetId: saved.id, targetType: "entry",
        targetName: saved.staffId,
        detail: `${saved.type} entry for ${saved.staffId} on ${saved.date}${saved.type==='work'?` (${saved.totalHours}h)`:saved.type==='leave'?` (${saved.leaveType} ${saved.hours}h)`:''}`,
      });

      // ── Future leave: trigger approval workflow ───────────────────────────
      if (saved.type === 'leave' && saved.status === 'leave_pending') {
        // Fire-and-forget — don't block the response
        triggerLeaveApprovalEmails(saved, caller).catch(e =>
          console.error('Leave approval email failed:', e.message)
        );
      }

      return json({ entry: saved }, 201);
    } catch (e) {
      cosmos.writeAudit("entry.create_failed", caller || null, { detail: e?.message || String(e), reason: "exception" }).catch(() => {});
      return errFromException(e, "entriesCreate");
    }
  },
});

// ── PUT /api/entries/:id ──────────────────────────────────────────────────────

app.http("entriesUpdate", {
  methods: ["PUT"],
  route: "entries/{id}",
  handler: async (req, context) => {
    let caller;
    try {
      caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const id = req.params.id;
      const existing = await cosmos.getItem("timesheetEntries", id, id);
      if (!existing) {
        await cosmos.writeAudit("entry.update_failed", caller, { targetId: id, detail: "Entry not found", reason: "not_found" });
        return err("Entry not found", 404);
      }

      const isAdmin   = caller.access?.timesheets === "admin";
      const isManager = caller.access?.timesheets === "manager";
      // Managers can update entries for their direct reports
      if (existing.staffId !== caller.id && !isAdmin && !isManager) {
        await cosmos.writeAudit("entry.update_failed", caller, { targetId: id, targetName: existing.staffId, detail: `Forbidden: cannot update entry for ${existing.staffId}`, reason: "forbidden" });
        return err("Forbidden", 403);
      }
      if (isManager && existing.staffId !== caller.id) {
        const allStaff = await cosmos.getAllStaff();
        const isDirectReport = allStaff.some(s => s.id === existing.staffId && s.managerId === caller.id);
        if (!isDirectReport) {
          await cosmos.writeAudit("entry.update_failed", caller, { targetId: id, targetName: existing.staffId, detail: `Forbidden: ${existing.staffId} is not a direct report`, reason: "forbidden" });
          return err("Forbidden", 403);
        }
      }

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      const startTime = body.startTime || existing.startTime;
      const endTime   = body.endTime   || existing.endTime;
      const type      = body.type      || existing.type;
      if (type === "work" && startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        body.totalHours = Math.round((mins / 60) * 100) / 100;
      }

      // When an admin approves a warning entry, record who approved and when
      // so the AI can learn from this pattern in future anomaly detection
      const updated = { ...existing, ...body, id };
      if (isAdmin && body.status === 'approved' && existing.status === 'warning') {
        updated.approvedAt  = nowLondon();
        updated.approvedBy  = caller.id;
        // Carry forward the anomaly description as context for future AI learning
        if (existing.anomaly && !updated.approvalNote) {
          updated.approvalNote = `Previously flagged: ${existing.anomaly}`;
        }
      }
      const saved = await cosmos.upsertEntry(updated);
      const statusChanged = body.status && body.status !== existing.status;
      const eventType = statusChanged ? `entry.status_${body.status}` : "entry.updated";
      await cosmos.writeAudit(eventType, caller, {
        targetId: saved.id, targetType: "entry", targetName: saved.staffId,
        detail: statusChanged
          ? `Status changed ${existing.status||"pending"} → ${body.status} for ${saved.staffId} on ${saved.date}`
          : `Entry updated for ${saved.staffId} on ${saved.date}`,
        previousStatus: existing.status || "pending",
        newStatus: body.status || existing.status,
      });
      return json({ entry: saved });
    } catch (e) {
      cosmos.writeAudit("entry.update_failed", caller || null, { detail: e?.message || String(e), reason: "exception" }).catch(() => {});
      return errFromException(e, "entriesUpdate");
    }
  },
});

// ── DELETE /api/entries/:id ───────────────────────────────────────────────────

app.http("entriesDelete", {
  methods: ["DELETE"],
  route: "entries/{id}",
  handler: async (req, context) => {
    let caller;
    try {
      caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const id = req.params.id;
      const existing = await cosmos.getItem("timesheetEntries", id, id);
      if (!existing) {
        await cosmos.writeAudit("entry.delete_failed", caller, { targetId: id, detail: "Entry not found", reason: "not_found" });
        return err("Entry not found", 404);
      }

      const isAdmin   = caller.access?.timesheets === "admin";
      const isManager = caller.access?.timesheets === "manager";
      // Managers can update entries for their direct reports
      if (existing.staffId !== caller.id && !isAdmin && !isManager) {
        await cosmos.writeAudit("entry.delete_failed", caller, { targetId: id, targetName: existing.staffId, detail: `Forbidden: cannot delete entry for ${existing.staffId}`, reason: "forbidden" });
        return err("Forbidden", 403);
      }
      if (isManager && existing.staffId !== caller.id) {
        const allStaff = await cosmos.getAllStaff();
        const isDirectReport = allStaff.some(s => s.id === existing.staffId && s.managerId === caller.id);
        if (!isDirectReport) {
          await cosmos.writeAudit("entry.delete_failed", caller, { targetId: id, targetName: existing.staffId, detail: `Forbidden: ${existing.staffId} is not a direct report`, reason: "forbidden" });
          return err("Forbidden", 403);
        }
      }

      await cosmos.writeAudit("entry.deleted", caller, {
        targetId: id, targetType: "entry", targetName: existing.staffId,
        detail: `Deleted ${existing.type} entry for ${existing.staffId} on ${existing.date}`,
      });
      await cosmos.deleteEntry(id);
      return json({ ok: true });
    } catch (e) {
      cosmos.writeAudit("entry.delete_failed", caller || null, { detail: e?.message || String(e), reason: "exception" }).catch(() => {});
      return errFromException(e, "entriesDelete");
    }
  },
});

// ── POST /api/ai/parse ────────────────────────────────────────────────────────

app.http("aiParse", {
  methods: ["POST"],
  route: "ai/parse",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      if (!body.text) return err("text is required");

      const today = body.date || new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const recentEntries = await cosmos.getEntriesByStaffAndPeriod(caller.id, weekAgo, today);

      const parsed = await agent.parseTimeEntry(
        body.text,
        { ...caller.timesheetProfile, name: caller.name },
        { today, recentEntries: recentEntries.slice(-5), periodStart: body.periodStart, periodEnd: body.periodEnd }
      );

      if (!parsed || !parsed.entries?.length) return err("Could not parse entry. Please try rephrasing.", 422);
      // Return both legacy 'parsed' (first entry) and new 'entries' array
      return json({ parsed: parsed.entries[0], entries: parsed.entries });
    } catch (e) {
      return errFromException(e, "aiParse");
    }
  },
});

// ── POST /api/ai/anomalies ────────────────────────────────────────────────────

app.http("aiAnomalies", {
  methods: ["POST"],
  route: "ai/anomalies",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      const isAdmin = caller.access?.timesheets === "admin";
      const staffId = body.staffId || caller.id;
      if (staffId !== caller.id && !isAdmin) return err("Forbidden", 403);
      if (!body.start || !body.end) return err("start and end are required");

      const staff = staffId === caller.id ? caller : await cosmos.getStaffById(staffId);
      if (!staff) return err("Staff not found", 404);

      const entries = await cosmos.getEntriesByStaffAndPeriod(staffId, body.start, body.end);
      const anomalies = await agent.detectAnomalies(entries, { ...staff.timesheetProfile, name: staff.name });
      return json({ anomalies });
    } catch (e) {
      return errFromException(e, "aiAnomalies");
    }
  },
});

// ── GET /api/reports/payroll ──────────────────────────────────────────────────

app.http("reportsPayroll", {
  methods: ["GET"],
  route: "reports/payroll",
  handler: async (req, context) => {
    try {
      const caller = await requireAdminOrManager(req);
      if (!caller) return err("Forbidden", 403);
      const isManager = caller.access?.timesheets === "manager";

      const url   = new URL(req.url);
      const start = url.searchParams.get("start");
      const end   = url.searchParams.get("end");
      if (!start || !end) return err("start and end query params are required");

      const [allStaffRaw, allEntries] = await Promise.all([
        cosmos.getAllStaff(),
        cosmos.getEntriesByPeriod(start, end),
      ]);

      // Managers only see their direct reports
      // Exclude staff whose employment ended before the period start
      const allStaff = (isManager
        ? allStaffRaw.filter(s => s.managerId === caller.id)
        : allStaffRaw
      ).filter(s => !s.timesheetProfile?.employmentEndDate || s.timesheetProfile.employmentEndDate >= start);

      const byStaff = {};
      for (const entry of allEntries) {
        if (!byStaff[entry.staffId]) byStaff[entry.staffId] = [];
        byStaff[entry.staffId].push(entry);
      }

      // ── Pay calculation helpers ────────────────────────────────────────────
      const r2 = (n) => Math.round((n||0) * 100) / 100;

      const daysInMonthForDate = (dateStr) => {
        const d = new Date(dateStr + "T12:00:00Z");
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      };

      const getActiveContract = (staff, dateStr) => {
        const history = staff.timesheetProfile?.contractHistory || [];
        if (!history.length) return null;
        const active = [...history]
          .filter(c => c.startDate <= dateStr)
          .sort((a, b) => b.startDate.localeCompare(a.startDate));
        return active[0] || null;
      };

      // Day-by-day pro-rating — iterates every day in the period, finds the
      // active contract for that day, divides contractedHrsPerMonth by days in
      // that specific calendar month, sums up. Handles month boundaries and
      // mid-period contract changes correctly.
      const calcProRatedHours = (staff, periodStart, periodEnd, method) => {
        const history = staff.timesheetProfile?.contractHistory || [];
        if (!history.length) return 0;

        let total = 0;
        const cursor = new Date(periodStart + "T12:00:00Z");
        const endDate = new Date(periodEnd + "T12:00:00Z");

        while (cursor <= endDate) {
          const dateStr = cursor.toISOString().slice(0, 10);
          const contract = [...history]
            .filter(c => c.startDate <= dateStr)
            .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];

          if (contract) {
            if (method === "annual") {
              // Annual method: contractedHrsPerMonth × 12 / 365 per day
              total += (contract.contractedHrsPerMonth * 12) / 365;
            } else {
              // Monthly method: divide by days in that specific calendar month
              const daysInThatMonth = daysInMonthForDate(dateStr);
              total += contract.contractedHrsPerMonth / daysInThatMonth;
            }
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        return r2(total);
      };

      // Also compute prorated pay using same day-by-day method
      const calcProRatedPay = (staff, periodStart, periodEnd, method) => {
        const history = staff.timesheetProfile?.contractHistory || [];
        if (!history.length) return 0;

        let total = 0;
        const cursor = new Date(periodStart + "T12:00:00Z");
        const endDate = new Date(periodEnd + "T12:00:00Z");

        while (cursor <= endDate) {
          const dateStr = cursor.toISOString().slice(0, 10);
          const contract = [...history]
            .filter(c => c.startDate <= dateStr)
            .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];

          if (contract) {
            const rate = contract.hourlyRate || 0;
            if (method === "annual") {
              total += (contract.contractedHrsPerMonth * 12 / 365) * rate;
            } else {
              const daysInThatMonth = daysInMonthForDate(dateStr);
              total += (contract.contractedHrsPerMonth / daysInThatMonth) * rate;
            }
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        return r2(total);
      };

      const url2   = new URL(req.url);
      const method = url2.searchParams.get("method") || "monthly";

      const report = await Promise.all(allStaff.map(async staff => {
        const entries = byStaff[staff.id] || [];

        const workHours = entries.filter(e => e.type === "work")
          .reduce((s, e) => s + (e.totalHours || 0), 0);

        const leaveBreakdown = {};
        entries.filter(e => e.type === "leave").forEach(e => {
          leaveBreakdown[e.leaveType] = (leaveBreakdown[e.leaveType] || 0) + (e.hours || 0);
        });

        const volunteerHours = entries.filter(e => e.type === "volunteer")
          .reduce((s, e) => s + (e.hours || 0), 0);

        const profile      = staff.timesheetProfile || {};
        const contract     = getActiveContract(staff, start);
        const hourlyRate   = contract?.hourlyRate || 0;
        const contractHrs  = contract?.contractedHrsPerMonth || 0;
        const isVolunteer  = profile.isVolunteer || false;
        const isSalaried   = profile.isSalaried || false;
        const canBankOT    = profile.overtimeBanking?.enabled || false;

        // Day-by-day pro-rated values (handles month boundaries + contract changes)
        const proRatedHrs  = calcProRatedHours(staff, start, end, method);
        const proRatedPay  = calcProRatedPay(staff, start, end, method);

        // Paid hours = work + paid leave (annual, sick, lieu)
        const paidLeave    = r2((leaveBreakdown.annual || 0) + (leaveBreakdown.sick || 0) + (leaveBreakdown.lieu || 0));
        const unpaidHours  = r2(leaveBreakdown.unpaid || 0);
        const totalPaidHrs = r2(workHours + paidLeave);

        // Overtime = paid hours beyond pro-rated contract
        const overtimeHrs  = r2(Math.max(0, totalPaidHrs - proRatedHrs));
        const overtimePay  = (!isVolunteer && !isSalaried && !canBankOT && overtimeHrs > 0)
          ? r2(overtimeHrs * hourlyRate) : 0;

        const unpaidDeduction = r2(unpaidHours * hourlyRate);
        const totalPay     = r2(proRatedPay + overtimePay - unpaidDeduction);

        const underContracted = !isVolunteer && totalPaidHrs < proRatedHrs;

        return {
          staffId:          staff.id,
          name:             staff.name,
          email:            staff.email,
          employment:       profile.employmentType || "employee",
          isVolunteer,
          isSalaried,
          canBankOvertime:  canBankOT,
          weeklyHours:      profile.weeklyHours || 37.5,
          period:           { start, end },
          contract: {
            hourlyRate,
            contractedHrsPerMonth: contractHrs,
            proRatedHrs,
            proRatedPay,
            method,
          },
          totals: {
            workHours:       r2(workHours),
            leaveBreakdown,
            volunteerHours:  r2(volunteerHours),
            paidLeaveHours:  paidLeave,
            unpaidHours,
            overtimeHrs,
            overtimePay,
            unpaidDeduction,
            totalPay,
            entryCount:      entries.length,
          },
          underContracted,
          timesheetProfile: profile,
        };
      }));

      return json({ period: { start, end }, report });
    } catch (e) {
      return errFromException(e, "reportsPayroll");
    }
  },
});

// ── TEMP DEBUG: test raw Cosmos query ─────────────────────────────────────────
app.http("debugEntries", {
  methods: ["GET"],
  route: "debug/entries",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller || caller.access?.timesheets !== "admin") return err("Forbidden", 403);

      // Count all entries in container
      const all = await cosmos.queryItems("timesheetEntries", "SELECT c.id, c.staffId, c.date FROM c");
      const sample = all.slice(0, 5);

      return json({
        totalCount: all.length,
        sample,
        staffIds: [...new Set(all.map(e => e.staffId))].slice(0, 10),
      });
    } catch (e) {
      return errFromException(e, "debugEntries");
    }
  },
});

// ── Leave approval helpers ───────────────────────────────────────────────────

async function triggerLeaveApprovalEmails(entry, submitter) {
  // Get all entries in this leave request (may be multi-day range)
  const allEntries = entry.leaveRequestId
    ? (await cosmos.queryItems("timesheetEntries",
        "SELECT * FROM c WHERE c.leaveRequestId = @id",
        [{ name: "@id", value: entry.leaveRequestId }]
      )).filter(e => e.status === "leave_pending")
    : [entry];

  // Find the staff member's details
  const staff = await cosmos.getStaffById(entry.staffId);
  if (!staff) return;

  // Find approver — manager or CD
  let approverEmail = CD_EMAIL;
  let approverName  = CD_NAME;
  if (staff.managerId) {
    const mgr = await cosmos.getStaffById(staff.managerId);
    if (mgr?.email) { approverEmail = mgr.email; approverName = mgr.name; }
  }

  // Create a one-time approval token (reuse auth token mechanism)
  const requestId = entry.leaveRequestId || entry.id;
  const approveToken = await cosmos.createLeaveActionToken(requestId, "approve", approverEmail);
  const rejectToken  = await cosmos.createLeaveActionToken(requestId, "reject",  approverEmail);

  const approveUrl = `${BASE_URL}/verify?leaveAction=approve&token=${approveToken}`;
  const rejectUrl  = `${BASE_URL}/verify?leaveAction=reject&token=${rejectToken}`;

  // If submitted by an admin on behalf of the employee, include their name in emails
  const submittedByName = entry.source === 'admin' ? entry.createdByName : null;

  // Email to staff — receipt
  if (staff.email) {
    await graph.sendMail(
      staff.email,
      "Leave Request Received — DC TimeGenius",
      agent.leaveReceiptHtml(staff.name, allEntries, entry.leaveType, submittedByName)
    );
  }

  // Email to approver — action required
  await graph.sendMail(
    approverEmail,
    `Leave Request from ${staff.name} — Action Required`,
    agent.leaveApprovalRequestHtml(staff.name, approverName, allEntries, entry.leaveType, approveUrl, rejectUrl, submittedByName)
  );
}

// ── GET /api/leave/action?token=...&action=approve|reject ─────────────────────
// Tokenised approve/reject endpoint — works without login (for email links)

app.http("leaveAction", {
  methods: ["GET"],
  route: "leave/action",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      const url    = new URL(req.url);
      const token  = url.searchParams.get("token");
      const action = url.searchParams.get("action"); // approve | reject

      if (!token || !["approve","reject"].includes(action))
        return { status: 302, headers: { Location: `${BASE_URL}/?leaveError=invalid` }, body: "" };

      // Validate token
      const tokenDoc = await cosmos.validateLeaveActionToken(token);
      if (!tokenDoc)
        return { status: 302, headers: { Location: `${BASE_URL}/?leaveError=expired` }, body: "" };

      const { requestId } = tokenDoc;

      // Find all entries in this leave request
      const entries = await cosmos.queryItems("timesheetEntries",
        "SELECT * FROM c WHERE (c.leaveRequestId = @id OR c.id = @id) AND c.status = 'leave_pending'",
        [{ name: "@id", value: requestId }]
      );

      if (!entries.length)
        return { status: 302, headers: { Location: `${BASE_URL}/?leaveError=already_actioned` }, body: "" };

      const newStatus = action === "approve" ? "leave_approved" : "leave_rejected";
      const staff = await cosmos.getStaffById(entries[0].staffId);

      // Update all entries
      await Promise.all(entries.map(e => cosmos.upsertEntry({ ...e, status: newStatus,
        [`${action}dAt`]: nowLondon(),
        [`${action}dBy`]: tokenDoc.approverEmail,
      })));

      await cosmos.writeAudit(`leave.${action}d`, { id: tokenDoc.approverEmail, name: tokenDoc.approverEmail, access: {} }, {
        targetId: requestId, targetType: "leave_request", targetName: entries[0].staffId,
        detail: `Leave request ${action}d for ${entries[0].staffId}: ${entries.length} entries`,
      });

      // Email staff the outcome
      if (staff?.email) {
        const emailHtml = action === "approve"
          ? agent.leaveApprovedHtml(staff.name, entries, entries[0].leaveType)
          : agent.leaveRejectedHtml(staff.name, entries, entries[0].leaveType);
        await graph.sendMail(
          staff.email,
          action === "approve" ? "Leave Request Approved — DC TimeGenius" : "Leave Request Update — DC TimeGenius",
          emailHtml
        );
      }

      // Redirect to a friendly confirmation page
      return {
        status: 302,
        headers: { Location: `${BASE_URL}/?leaveActioned=${action}` },
        body: "",
      };
    } catch (e) {
      return errFromException(e, "leaveAction");
    }
  },
});

// ── POST /api/reports/auto-approve ────────────────────────────────────────────
// Runs anomaly detection per staff member and auto-approves entries that
// look consistent. Returns counts of approved vs flagged entries.
app.http("reportsAutoApprove", {
  methods: ["POST"],
  route: "reports/auto-approve",
  handler: async (req, context) => {
    try {
      const caller2 = await requireAdminOrManager(req);
      if (!caller2) return err("Forbidden", 403);
      const isMgr = caller2.access?.timesheets === "manager";

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      const { start, end } = body;
      if (!start || !end) return err("start and end are required");

      const [allStaffRaw2, allEntries] = await Promise.all([
        cosmos.getAllStaff(),
        cosmos.getEntriesByPeriod(start, end),
      ]);

      const allStaff = isMgr
        ? allStaffRaw2.filter(s => s.managerId === caller2.id)
        : allStaffRaw2;

      const byStaff = {};
      for (const entry of allEntries) {
        if (!byStaff[entry.staffId]) byStaff[entry.staffId] = [];
        byStaff[entry.staffId].push(entry);
      }

      let approved = 0, flagged = 0, skipped = 0;

      await Promise.all(allStaff.map(async staff => {
        const entries = (byStaff[staff.id] || []).filter(e => !e.status || e.status === "pending");
        if (!entries.length) return;

        const profile = staff.timesheetProfile || {};
        let anomalyIds = new Set();

        try {
          // Fetch up to 50 recently approved entries as pattern context for AI
          const recentApproved = await cosmos.getRecentApprovedEntries(staff.id, 50);

          const profileWithContext = {
            ...profile,
            name: staff.name,
            recentApprovedEntries: recentApproved || [],
          };
          const anomalies = await agent.detectAnomalies(entries, profileWithContext);
          anomalyIds = new Set((anomalies || []).map(a => a.entryId));
        } catch { /* leave all as pending if AI fails */ skipped += entries.length; return; }

        await Promise.all(entries.map(async entry => {
          const newStatus = anomalyIds.has(entry.id) ? "warning" : "approved";
          await cosmos.upsertEntry({ ...entry, status: newStatus });
          if (newStatus === "approved") approved++;
          else flagged++;
        }));
      }));

      await cosmos.writeAudit("entry.bulk_approved", caller2, {
        targetType: "entries",
        detail: `Auto-Approve run: ${approved} approved, ${flagged} flagged, ${skipped} skipped. Period: ${start} to ${end}`,
        approved, flagged, skipped,
      });
      return json({ approved, flagged, skipped });
    } catch (e) {
      return errFromException(e, "reportsAutoApprove");
    }
  },
});

// ── POST /api/ai/payroll-summary ──────────────────────────────────────────────
app.http("aiPayrollSummary", {
  methods: ["POST"],
  route: "ai/payroll-summary",
  handler: async (req, context) => {
    try {
      const admin = await requireAdmin(req);
      if (!admin) return err("Forbidden", 403);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }

      const { period, totals, staff, previousPeriod } = body;
      const lb  = totals.leaveBreakdown || {};
      const r2  = n => Math.round((n||0) * 100) / 100;

      // Fetch previous period data server-side if caller provided previous period dates
      let prevTotals = previousPeriod || null;
      if (previousPeriod?.start && previousPeriod?.end && !previousPeriod.totalWork) {
        try {
          const prevEntries = await cosmos.getEntriesByPeriod(previousPeriod.start, previousPeriod.end);
          const prevWork    = prevEntries.filter(e => e.type === "work").reduce((s,e) => s + (e.totalHours||0), 0);
          const prevLeave   = prevEntries.filter(e => e.type === "leave").reduce((s,e) => s + (e.hours||0), 0);
          const prevAnomaly = prevEntries.filter(e => e.anomaly).length;
          const prevStaffIds = new Set(prevEntries.map(e => e.staffId));
          prevTotals = {
            period:       `${previousPeriod.start} to ${previousPeriod.end}`,
            totalWork:    r2(prevWork),
            totalLeave:   r2(prevLeave),
            anomalyCount: prevAnomaly,
            employeeCount: prevStaffIds.size,
          };
        } catch { prevTotals = null; }
      }

      // Build leave balance summary from staff profiles
      const leaveBalances = staff
        .filter(s => !s.isVolunteer)
        .map(s => {
          const profile = s.timesheetProfile || {};
          const ent = profile.leaveEntitlements || {};
          return {
            name:         s.name,
            annualBalance: r2((ent.annual||0) + (ent.annualCarryOver||0) - (s.totals?.leaveBreakdown?.annual||0)),
            sickBalance:   r2((ent.sick||0)   + (ent.sickCarryOver||0)   - (s.totals?.leaveBreakdown?.sick||0)),
          };
        })
        .filter(s => s.annualBalance !== 0 || s.sickBalance !== 0);

      const prevSection = prevTotals ? `

Previous Period (${prevTotals.period}):
- Work Hours: ${prevTotals.totalWork} (change: ${r2(totals.totalWork - prevTotals.totalWork) >= 0 ? '+' : ''}${r2(totals.totalWork - prevTotals.totalWork)}h, ${prevTotals.totalWork > 0 ? (((totals.totalWork - prevTotals.totalWork) / prevTotals.totalWork) * 100).toFixed(1) + '%' : 'N/A'})
- Paid Leave: ${prevTotals.totalLeave} (change: ${r2(totals.totalLeave - prevTotals.totalLeave) >= 0 ? '+' : ''}${r2(totals.totalLeave - prevTotals.totalLeave)}h)
- Anomalous Entries: ${prevTotals.anomalyCount}
- Employees: ${prevTotals.employeeCount}` : '';

      const lowLeave = leaveBalances.filter(s => s.annualBalance < 10 && s.annualBalance >= 0);
      const negLeave = leaveBalances.filter(s => s.annualBalance < 0);

      const prompt = `Write a professional executive summary (3-4 paragraphs) for this payroll period report. Use the data below. Compare to the previous period where provided. Identify trends, concerns, and highlight employees with low or negative leave balances.

Current Period: ${period.start} to ${period.end}
Employees: ${totals.employeeCount}
Total Work Hours: ${totals.totalWork} (Normal: ${r2(totals.totalWork - (totals.totalOvertime||0))}, Overtime: ${totals.totalOvertime||0})
Total Paid Leave: ${totals.totalLeave}h (Annual: ${lb.annual||0}, Sick: ${lb.sick||0}, Lieu: ${lb.lieu||0}, Unpaid: ${lb.unpaid||0})
Total Payroll: £${r2(totals.totalPay).toFixed(2)}
Anomalous entries: ${totals.anomalyCount || 0}
Under-contracted staff: ${staff.filter(s=>s.underContracted).map(s=>s.name).join(', ')||'None'}${prevSection}

Employee leave balances (remaining for year):
${leaveBalances.map(s => `- ${s.name}: Annual ${s.annualBalance}h${s.sickBalance ? ', Sick ' + s.sickBalance + 'h' : ''}`).join('\n') || 'No balance data available'}

${negLeave.length ? `CRITICAL — Negative leave balances: ${negLeave.map(s=>`${s.name} (${s.annualBalance}h)`).join(', ')}` : ''}
${lowLeave.length ? `WARNING — Low leave balances (<10h): ${lowLeave.map(s=>`${s.name} (${s.annualBalance}h)`).join(', ')}` : ''}

Staff pay summary:
${staff.filter(s=>!s.isVolunteer).map(s=>`- ${s.name}: ${s.workHours||0}h work, £${r2(s.totalPay).toFixed(2)} pay${s.underContracted?' ⚠ UNDER CONTRACT':''}`).join('\n')}`;

      const summary = await agent.askClaude(
        [{ role: "user", content: prompt }],
        "You are an expert HR and payroll analyst. Write professional, insightful executive summaries in Markdown format. Use headings and bullet points. Compare periods with percentage changes where relevant. Always flag employees with negative or very low leave balances by name."
      );

      return json({ summary });
    } catch (e) {
      return errFromException(e, "aiPayrollSummary");
    }
  },
});

// ── POST /api/leave/approve-direct ───────────────────────────────────────────
// In-app approval by a logged-in manager/admin

app.http("leaveApproveDirect", {
  methods: ["POST"],
  route: "leave/approve-direct",
  handler: async (req, context) => {
    try {
      const caller = await requireAdminOrManager(req);
      if (!caller) return err("Forbidden", 403);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      const { leaveRequestId, action = "approve" } = body;
      if (!leaveRequestId) return err("leaveRequestId required");
      if (!["approve","reject"].includes(action)) return err("action must be approve or reject");

      const entries = await cosmos.queryItems("timesheetEntries",
        "SELECT * FROM c WHERE (c.leaveRequestId = @id OR c.id = @id) AND c.status = 'leave_pending'",
        [{ name: "@id", value: leaveRequestId }]
      );
      if (!entries.length) return err("No pending entries found for this request", 404);

      const newStatus = action === "approve" ? "leave_approved" : "leave_rejected";
      const staff = await cosmos.getStaffById(entries[0].staffId);

      await Promise.all(entries.map(e => cosmos.upsertEntry({
        ...e, status: newStatus,
        [`${action}dAt`]: nowLondon(),
        [`${action}dBy`]: caller.id,
      })));

      await cosmos.writeAudit(`leave.${action}d`, caller, {
        targetId: leaveRequestId, targetType: "leave_request", targetName: entries[0].staffId,
        detail: `Leave ${action}d by ${caller.name} for ${entries[0].staffId}: ${entries.length} entries`,
      });

      // Email staff
      if (staff?.email) {
        const emailHtml = action === "approve"
          ? agent.leaveApprovedHtml(staff.name, entries, entries[0].leaveType)
          : agent.leaveRejectedHtml(staff.name, entries, entries[0].leaveType);
        await graph.sendMail(
          staff.email,
          action === "approve" ? "Leave Request Approved — DC TimeGenius" : "Leave Request Update — DC TimeGenius",
          emailHtml
        ).catch(e => console.error("Leave email failed:", e.message));
      }

      return json({ ok: true, count: entries.length, status: newStatus });
    } catch (e) {
      return errFromException(e, "leaveApproveDirect");
    }
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// ── PAYROLL ENGINE ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month is 1-based here
}

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// Returns current time as ISO string in Europe/London timezone (handles BST/GMT automatically)
function nowLondon() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');
}

function getActiveContract(history, dateStr) {
  if (!history?.length) return null;
  return [...history]
    .filter(c => c.startDate <= dateStr)
    .sort((a,b) => b.startDate.localeCompare(a.startDate))[0] || null;
}

function calcPayrollForStaff(staff, year, month, allEntries, priorRun, addlLeaveEnabled = true, includePending = false) {
  const profile  = staff.timesheetProfile || {};
  const history  = profile.contractHistory || [];
  const bankOT   = profile.overtimeBanking?.enabled || false;

  // Status filter — for recalculation of prior months, include pending leave
  // so late-added entries are reflected in the prior month adjustment
  const approvedStatuses = ['approved', 'leave_approved'];
  const leaveStatuses = includePending
    ? ['approved', 'leave_approved', 'leave_pending', 'pending']
    : approvedStatuses;

  // ── Bounds ──────────────────────────────────────────────────────────────────
  const calStart  = isoDate(year, month, 1);
  const calEnd    = isoDate(year, month, daysInMonth(year, month));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const periodStart = isoDate(prevYear, prevMonth, 17);
  const periodEnd   = isoDate(year, month, 16);

  // ── 1. Contractual pay — calendar month, day-by-day ─────────────────────────
  let contractualPay = 0;
  for (let d = new Date(calStart + 'T12:00:00Z'); d <= new Date(calEnd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
    const ds = d.toISOString().slice(0,10);
    const c  = getActiveContract(history, ds);
    if (c) contractualPay += (c.contractedHrsPerMonth / daysInMonth(d.getUTCFullYear(), d.getUTCMonth()+1)) * c.hourlyRate;
  }
  contractualPay = Math.round(contractualPay * 100) / 100;

  // ── 2. Contractual hours — 17th-16th, day-by-day ────────────────────────────
  let contractualHrs = 0;
  for (let d = new Date(periodStart + 'T12:00:00Z'); d <= new Date(periodEnd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
    const ds = d.toISOString().slice(0,10);
    const c  = getActiveContract(history, ds);
    if (c) contractualHrs += c.contractedHrsPerMonth / daysInMonth(d.getUTCFullYear(), d.getUTCMonth()+1);
  }
  contractualHrs = Math.round(contractualHrs * 100) / 100;

  // ── 3. Work hours — 17th-16th ───────────────────────────────────────────────
  const workEntries = allEntries.filter(e =>
    e.staffId === staff.id && e.type === 'work' &&
    e.date >= periodStart && e.date <= periodEnd &&
    approvedStatuses.includes(e.status)
  );
  const workHrs = Math.round(workEntries.reduce((s,e) => s+(e.totalHours||0), 0) * 100) / 100;

  // ── 4. Paid leave — calendar month ──────────────────────────────────────────
  const leaveEntries = allEntries.filter(e =>
    e.staffId === staff.id && e.type === 'leave' &&
    e.date >= calStart && e.date <= calEnd &&
    leaveStatuses.includes(e.status)
  );
  const annualHrs = Math.round(leaveEntries.filter(e=>e.leaveType==='annual').reduce((s,e)=>s+(e.hours||0),0)*100)/100;
  const sickHrs   = Math.round(leaveEntries.filter(e=>e.leaveType==='sick').reduce((s,e)=>s+(e.hours||0),0)*100)/100;
  const lieuHrs   = Math.round(leaveEntries.filter(e=>e.leaveType==='lieu').reduce((s,e)=>s+(e.hours||0),0)*100)/100;
  const unpaidHrs = Math.round(leaveEntries.filter(e=>e.leaveType==='unpaid').reduce((s,e)=>s+(e.hours||0),0)*100)/100;
  const totalPaidHrs = Math.round((workHrs + annualHrs + sickHrs + lieuHrs) * 100) / 100;

  // ── 5. Overtime / lieu banked ────────────────────────────────────────────────
  const contractOn16 = getActiveContract(history, periodEnd);
  const rateOn16     = contractOn16?.hourlyRate || 0;
  const overtimeHrs  = Math.max(0, Math.round((totalPaidHrs - contractualHrs) * 100) / 100);
  const lieuBanked   = bankOT ? overtimeHrs : 0;
  const overtimePay  = bankOT ? 0 : Math.round(overtimeHrs * rateOn16 * 100) / 100;

  // ── 6. Unpaid deduction ──────────────────────────────────────────────────────
  const unpaidDeduction = Math.round(unpaidHrs * rateOn16 * 100) / 100;

  // ── 7. Prior month adjustment ────────────────────────────────────────────────
  let priorAdjHrs = 0, priorAdjPay = 0, priorLieuAdj = 0, priorUnpaidAdj = 0;
  if (priorRun) {
    const pr        = priorRun.employees?.[staff.id];
    const newTotal  = pr?.recalcTotalPaidHrs ?? pr?.totalPaidHrs ?? 0;
    const prevTotal = pr?.totalPaidHrs || 0;
    const prevContr = pr?.contractualHrsPeriod || 0;
    const prevOTHrs = pr?.overtimeHrs || 0;
    const priorRate = pr?.rateOn16    || 0;
    // Late unpaid leave: entered after the prior run was finalised
    const newUnpaid  = pr?.recalcUnpaidHrs  ?? pr?.unpaidLeaveHrs ?? 0;
    const prevUnpaid = pr?.unpaidLeaveHrs   || 0;
    const lateUnpaid = Math.max(0, Math.round((newUnpaid - prevUnpaid) * 100) / 100);

    if (newTotal > prevTotal && newTotal > prevContr) {
      // Additional overtime: lesser of (new-old) or (new-contracted)
      priorAdjHrs = Math.min(
        Math.round((newTotal - prevTotal) * 100) / 100,
        Math.round((newTotal - prevContr) * 100) / 100
      );
      priorAdjPay  = bankOT ? 0 : Math.round(priorAdjHrs * priorRate * 100) / 100;
      priorLieuAdj = bankOT ? priorAdjHrs : 0;
    } else if (newTotal < prevTotal && prevOTHrs > 0) {
      // Clawback: capped at prior overtime paid
      const shortfall = Math.round((prevTotal - newTotal) * 100) / 100;
      const deductHrs = Math.min(shortfall, prevOTHrs);
      priorAdjHrs  = -deductHrs;
      priorAdjPay  = bankOT ? 0 : -Math.round(deductHrs * priorRate * 100) / 100;
      priorLieuAdj = bankOT ? -deductHrs : 0;
    }

    // Late unpaid leave deduction (entered after prior run finalised)
    if (lateUnpaid > 0) {
      priorUnpaidAdj = Math.round(lateUnpaid * priorRate * 100) / 100;
    }
  }

  // ── 8. Total pay ─────────────────────────────────────────────────────────────
  const totalPay = Math.round((contractualPay + overtimePay - unpaidDeduction + priorAdjPay - priorUnpaidAdj) * 100) / 100;

  // ── 9. Additional leave earned from additional hours ─────────────────────────
  // Formula: (annualEntitlement / (avgContractedHrsPerMonth × 12)) × additionalHrs
  // This gives the proportional leave entitlement for the extra hours worked.
  // Also adjusts for prior month changes (priorAdjHrs changes the additional hours base).
  // Stored in payroll run — not in staff profile (which keeps the base entitlement).
  // Gated by addlLeaveEnabled — set via payroll_settings config doc in Cosmos.
  let additionalLeaveEarned = 0, priorMonthLeaveAdj = 0;
  if (addlLeaveEnabled) {
  const annualEntitlement = profile.leaveEntitlements?.annual || 0;
  const totalAddlHrs = overtimeHrs; // same figure regardless of banking — lieuBanked = overtimeHrs for bankers
  if (annualEntitlement > 0) {
    // Calculate avg contracted hours per month over the calendar month
    let totalContracted = 0, calDays = 0;
    for (let d = new Date(calStart + 'T12:00:00Z'); d <= new Date(calEnd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
      const ds = d.toISOString().slice(0,10);
      const c  = getActiveContract(history, ds);
      if (c) totalContracted += c.contractedHrsPerMonth;
      calDays++;
    }
    const avgContractedPerMonth = calDays > 0 ? totalContracted / calDays : 0;
    const annualContractedHrs   = avgContractedPerMonth * 12;

    if (annualContractedHrs > 0) {
      // Current month additional leave (this month only)
      const currentMonthLeave = totalAddlHrs > 0
        ? Math.round((annualEntitlement / annualContractedHrs) * totalAddlHrs * 100) / 100
        : 0;

      // Prior month leave adjustment — stored separately for audit clarity
      // If priorAdjHrs changed the additional hours, leave adjusts proportionally
      let priorMonthLeaveAdj = 0;
      if (priorAdjHrs !== 0) {
        const pr = priorRun?.employees?.[staff.id];
        const priorAvgContracted = pr ? (() => {
          const priorCalStart = pr.calendarStart;
          const priorCalEnd   = pr.calendarEnd;
          if (!priorCalStart || !priorCalEnd) return avgContractedPerMonth;
          let pt = 0, pd = 0;
          for (let d = new Date(priorCalStart+'T12:00:00Z'); d <= new Date(priorCalEnd+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
            const c = getActiveContract(history, d.toISOString().slice(0,10));
            if (c) pt += c.contractedHrsPerMonth;
            pd++;
          }
          return pd > 0 ? pt / pd : avgContractedPerMonth;
        })() : avgContractedPerMonth;
        const priorAnnualContracted = priorAvgContracted * 12;
        if (priorAnnualContracted > 0) {
          priorMonthLeaveAdj = Math.round((annualEntitlement / priorAnnualContracted) * priorAdjHrs * 100) / 100;
        }
      }

      additionalLeaveEarned = currentMonthLeave;  // current month only
      // priorMonthLeaveAdj stored separately in return object below
    }
  }
  } // end if (addlLeaveEnabled)

  // Build prior month detail for the diff table — only populated when there is an adjustment
  let priorMonthDetail = null;
  if (priorRun) {
    const pr = priorRun.employees?.[staff.id];
    if (pr && (priorAdjHrs !== 0 || priorUnpaidAdj !== 0)) {
      priorMonthDetail = {
        periodLabel:  `${pr.periodStart || ''} to ${pr.periodEnd || ''}`,
        // Locked (original) figures
        locked: {
          workHrs:       pr.workHrs           || 0,
          annualLeaveHrs:pr.annualLeaveHrs     || 0,
          sickLeaveHrs:  pr.sickLeaveHrs       || 0,
          lieuLeaveHrs:  pr.lieuLeaveHrs       || 0,
          unpaidLeaveHrs:pr.unpaidLeaveHrs     || 0,
          totalPaidHrs:  pr.totalPaidHrs       || 0,
          contractualHrs:pr.contractualHrsPeriod || 0,
          overtimeHrs:   pr.overtimeHrs        || 0,
          overtimePay:   pr.overtimePay        || 0,
          lieuBanked:    pr.lieuBanked         || 0,
          unpaidDeduction:pr.unpaidDeduction   || 0,
          totalPay:      pr.totalPay           || 0,
        },
        // Recalculated figures
        recalc: {
          workHrs:       pr.workHrs           || 0, // work hrs don't change in prior recalc
          annualLeaveHrs:(pr.recalcAnnualLeaveHrs ?? pr.annualLeaveHrs) || 0,
          sickLeaveHrs:  (pr.recalcSickLeaveHrs   ?? pr.sickLeaveHrs)   || 0,
          lieuLeaveHrs:  (pr.recalcLieuLeaveHrs   ?? pr.lieuLeaveHrs)   || 0,
          unpaidLeaveHrs:(pr.recalcUnpaidHrs       ?? pr.unpaidLeaveHrs) || 0,
          totalPaidHrs:  (pr.recalcTotalPaidHrs    ?? pr.totalPaidHrs)   || 0,
          contractualHrs:pr.contractualHrsPeriod || 0,
          overtimeHrs:   Math.max(0, Math.round(((pr.recalcTotalPaidHrs ?? pr.totalPaidHrs) - pr.contractualHrsPeriod) * 100) / 100),
          overtimePay:   pr.overtimePay || 0, // shown for reference; adjustment is priorAdjPay
          lieuBanked:    pr.lieuBanked  || 0,
          unpaidDeduction: Math.round(((pr.recalcUnpaidHrs ?? pr.unpaidLeaveHrs) * (pr.rateOn16 || 0)) * 100) / 100,
          totalPay:      pr.totalPay || 0,  // shown for reference
        },
        adjustment: { priorAdjHrs, priorAdjPay, priorLieuAdj, priorUnpaidAdj },
      };
    }
  }

  return {
    staffId: staff.id, name: staff.name,
    calendarStart: calStart, calendarEnd: calEnd,
    periodStart, periodEnd,
    contractualPay, contractualHrsPeriod: contractualHrs,
    workHrs, annualLeaveHrs: annualHrs, sickLeaveHrs: sickHrs,
    lieuLeaveHrs: lieuHrs, unpaidLeaveHrs: unpaidHrs,
    totalPaidHrs, overtimeHrs, overtimePay,
    lieuBanked, unpaidDeduction,
    priorAdjHrs, priorAdjPay, priorLieuAdj, priorUnpaidAdj,
    priorMonthDetail,
    totalPay, rateOn16,
    additionalLeaveEarned,
    priorMonthLeaveAdj,
    netAdditionalLeave: Math.round((additionalLeaveEarned + priorMonthLeaveAdj) * 100) / 100,
    underContracted: totalPaidHrs < contractualHrs,
    isSalaried: profile.isSalaried || false,
    isVolunteer: profile.isVolunteer || false,
    bankOT,
    timesheetProfile: profile,
  };
}

// ── GET /api/payroll/calculate?year=&month= ────────────────────────────────────

app.http("payrollCalculate", {
  methods: ["GET"],
  route: "payroll/calculate",
  handler: async (req, context) => {
    try {
      const admin = await requireAdminOrManager(req);
      if (!admin) return err("Forbidden", 403);

      const url   = new URL(req.url);
      const year  = parseInt(url.searchParams.get("year"));
      const month = parseInt(url.searchParams.get("month"));
      if (!year || !month || month < 1 || month > 12) return err("year and month (1-12) required");

      // Fetch data
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear  = month === 1 ? year - 1 : year;
      const calStart  = isoDate(year, month, 1);
      const calEnd    = isoDate(year, month, daysInMonth(year, month));
      const periodStart = isoDate(prevYear, prevMonth, 17);

      // The prior month recalc needs entries going back to the START of the prior
      // pay period (17th of two months ago), not just the current period start.
      // e.g. for March payroll: current period = 17 Feb–16 Mar, but prior period
      // recalc needs entries from 17 Jan onwards.
      const prevPrevMonth = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevPrevYear  = prevMonth === 1 ? prevYear - 1 : prevYear;
      const fetchStart    = isoDate(prevPrevYear, prevPrevMonth, 17);

      const [allStaff, allEntries, priorRun, leaveConfig] = await Promise.all([
        cosmos.getAllStaff(),
        cosmos.queryItems("timesheetEntries",
          "SELECT * FROM c WHERE c.date >= @start AND c.date <= @end",
          [{ name: "@start", value: fetchStart }, { name: "@end", value: calEnd }]),
        cosmos.getPayrollRun(prevYear, prevMonth),
        cosmos.getConfig("payroll_settings"),
      ]);

      // Additional leave cutoff — only award additional leave from this year/month onwards.
      // Set in Cosmos config container: { id: "payroll_settings", additionalLeaveFromYear: 2026, additionalLeaveFromMonth: 4 }
      // Leave both fields absent (or 0) to enable for all periods (useful for testing).
      const addlLeaveFromYear  = leaveConfig?.additionalLeaveFromYear  || 0;
      const addlLeaveFromMonth = leaveConfig?.additionalLeaveFromMonth || 0;
      const addlLeaveEnabled = (addlLeaveFromYear === 0) ||
        (year > addlLeaveFromYear) ||
        (year === addlLeaveFromYear && month >= addlLeaveFromMonth);

      // If prior run exists, recalculate prior month totals with current entries
      if (priorRun) {
        const priorCalStart  = isoDate(prevYear, prevMonth, 1);
        const priorCalEnd    = isoDate(prevYear, prevMonth, daysInMonth(prevYear, prevMonth));
        const priorPeriodStart = prevMonth === 1 ? isoDate(prevYear-1, 12, 17) : isoDate(prevYear, prevMonth-1, 17);
        const priorPeriodEnd   = isoDate(prevYear, prevMonth, 16);
        const priorEntries = allEntries.filter(e => e.date >= priorPeriodStart && e.date <= priorCalEnd);

        for (const staff of allStaff) {
          if (!priorRun.employees?.[staff.id]) continue;
          const recalc = calcPayrollForStaff(staff, prevYear, prevMonth, priorEntries, null, false, true);
          priorRun.employees[staff.id].recalcTotalPaidHrs    = recalc.totalPaidHrs;
          priorRun.employees[staff.id].recalcUnpaidHrs       = recalc.unpaidLeaveHrs;
          priorRun.employees[staff.id].recalcAnnualLeaveHrs  = recalc.annualLeaveHrs;
          priorRun.employees[staff.id].recalcSickLeaveHrs    = recalc.sickLeaveHrs;
          priorRun.employees[staff.id].recalcLieuLeaveHrs    = recalc.lieuLeaveHrs;
        }
      }

      // Calculate current month — hourly employees only for payroll
      const report = allStaff
        .filter(s => !s.timesheetProfile?.isSalaried && !s.timesheetProfile?.isVolunteer)
        .filter(s => !s.timesheetProfile?.employmentEndDate || s.timesheetProfile.employmentEndDate >= calStart)
        .map(s => calcPayrollForStaff(s, year, month, allEntries, priorRun, addlLeaveEnabled));

      // Salaried staff — included for leave tracking and the app report view,
      // but excluded from payroll figures. No pay calculation.
      const salariedReport = allStaff
        .filter(s => s.timesheetProfile?.isSalaried && !s.timesheetProfile?.isVolunteer)
        .filter(s => !s.timesheetProfile?.employmentEndDate || s.timesheetProfile.employmentEndDate >= calStart)
        .map(s => {
          const leaveEntries = allEntries.filter(e =>
            e.staffId === s.id && e.type === 'leave' &&
            e.date >= calStart && e.date <= calEnd &&
            (e.status === 'approved' || e.status === 'leave_approved')
          );
          const workEntries = allEntries.filter(e =>
            e.staffId === s.id && e.type === 'work' &&
            e.date >= isoDate(prevYear, prevMonth, 17) && e.date <= isoDate(year, month, 16)
          );
          const leaveBreakdown = {};
          leaveEntries.forEach(e => {
            leaveBreakdown[e.leaveType] = (leaveBreakdown[e.leaveType] || 0) + (e.hours || 0);
          });
          return {
            staffId: s.id, name: s.name,
            isSalaried: true, isVolunteer: false,
            calendarStart: calStart, calendarEnd: calEnd,
            periodStart: isoDate(prevYear, prevMonth, 17),
            periodEnd: isoDate(year, month, 16),
            annualLeaveHrs: Math.round((leaveBreakdown.annual || 0) * 100) / 100,
            sickLeaveHrs:   Math.round((leaveBreakdown.sick   || 0) * 100) / 100,
            lieuLeaveHrs:   Math.round((leaveBreakdown.lieu   || 0) * 100) / 100,
            unpaidLeaveHrs: Math.round((leaveBreakdown.unpaid || 0) * 100) / 100,
            workHrs:        Math.round(workEntries.reduce((s,e) => s+(e.totalHours||0), 0) * 100) / 100,
            totalPay: 0,
            timesheetProfile: s.timesheetProfile,
          };
        });

      // Add volunteers separately — no payroll calculation, just hours for the volunteer report
      const volunteerReport = allStaff
        .filter(s => s.timesheetProfile?.isVolunteer)
        .map(s => {
          const volEntries = allEntries.filter(e =>
            e.staffId === s.id && e.type === 'volunteer' &&
            e.date >= calStart && e.date <= calEnd &&
            (e.status === 'approved' || !e.status)
          );
          const volHrs = Math.round(volEntries.reduce((sum, e) => sum + (e.hours || 0), 0) * 100) / 100;
          return {
            staffId: s.id, name: s.name,
            isVolunteer: true, isSalaried: false,
            calendarStart: calStart, calendarEnd: calEnd,
            volunteerHrs: volHrs,
            totalPay: 0,
          };
        });

      // Check if this month is already finalised
      const existingRun = await cosmos.getPayrollRun(year, month);

      return json({
        year, month, calendarStart: calStart, calendarEnd: calEnd,
        status: existingRun?.status || "draft",
        report: [...report, ...salariedReport, ...volunteerReport],
        lockedAt: existingRun?.lockedAt || null,
        lockedBy: existingRun?.lockedByName || null,
      });
    } catch (e) {
      return errFromException(e, "payrollCalculate");
    }
  },
});

// ── POST /api/payroll/finalise ────────────────────────────────────────────────

app.http("payrollFinalise", {
  methods: ["POST"],
  route: "payroll/finalise",
  handler: async (req, context) => {
    try {
      const admin = await requireAdmin(req);
      if (!admin) return err("Forbidden", 403);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      const { year, month, report } = body;
      if (!year || !month || !report) return err("year, month and report required");

      const existing = await cosmos.getPayrollRun(year, month);
      if (existing?.status === "finalised") return err("This payroll run is already finalised", 409);

      // ── Pre-flight: check prior month is locked ───────────────────────────────
      // Can't finalise current month without a locked prior month — the prior month
      // adjustment calculation depends on it.
      // Exception: month 1 (January) — allow finalising without a prior December run
      // if none exists, since it may be the first ever run.
      const prevMonth2   = month === 1 ? 12 : month - 1;
      const prevYear2    = month === 1 ? year - 1 : year;
      const priorRun = await cosmos.getPayrollRun(prevYear2, prevMonth2);
      if (!priorRun || priorRun.status !== "finalised") {
        return json({
          ok: false,
          priorMonthNotLocked: true,
          priorMonthLabel: `${MONTHS[prevMonth2 - 1]} ${prevYear2}`,
        }, 400);
      }

      // ── Pre-flight: check for unapproved entries ──────────────────────────────
      // Work entries are checked against the 17th–16th pay period.
      // Leave entries are checked against the calendar month.
      // leave_pending counts as unapproved — it must be approved or rejected first.
      const preflightPeriodStart = `${prevYear2}-${String(prevMonth2).padStart(2,'0')}-17`;
      const preflightPeriodEnd   = `${year}-${String(month).padStart(2,'0')}-16`;
      const preflightCalStart    = `${year}-${String(month).padStart(2,'0')}-01`;
      const preflightCalEnd      = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;

      const { unapprovedWork, unapprovedLeave } = await cosmos.getUnapprovedEntriesForPreflight(
        preflightPeriodStart, preflightPeriodEnd, preflightCalStart, preflightCalEnd
      );

      if (unapprovedWork.length > 0 || unapprovedLeave.length > 0) {
        // Build a name lookup from the report payload — already contains staffId + name
        const nameById = {};
        for (const r of report) { if (r.staffId && r.name) nameById[r.staffId] = r.name; }

        // Group by staff member for a readable response
        const byStaff = {};
        for (const e of unapprovedWork) {
          const name = nameById[e.staffId] || e.staffId;
          if (!byStaff[e.staffId]) byStaff[e.staffId] = { name, work: [], leave: [] };
          byStaff[e.staffId].work.push(e.date);
        }
        for (const e of unapprovedLeave) {
          const name = nameById[e.staffId] || e.staffId;
          if (!byStaff[e.staffId]) byStaff[e.staffId] = { name, work: [], leave: [] };
          byStaff[e.staffId].leave.push(e.date);
        }
        return json({
          ok: false,
          unapprovedEntries: Object.values(byStaff),
          periodLabel:   `${preflightPeriodStart} to ${preflightPeriodEnd}`,
          calMonthLabel: `${preflightCalStart} to ${preflightCalEnd}`,
        }, 400);
      }
      // ── End pre-flight ────────────────────────────────────────────────────────

      const id = `payroll_${year}_${String(month).padStart(2,'0')}`;

      // ── Additional leave cutoff — same config as payrollCalculate ────────────
      const finLeaveConfig     = await cosmos.getConfig("payroll_settings");
      const finAddlLeaveFromYear  = finLeaveConfig?.additionalLeaveFromYear  || 0;
      const finAddlLeaveFromMonth = finLeaveConfig?.additionalLeaveFromMonth || 0;
      const finAddlLeaveEnabled = (finAddlLeaveFromYear === 0) ||
        (year > finAddlLeaveFromYear) ||
        (year === finAddlLeaveFromYear && month >= finAddlLeaveFromMonth);

      // ── Calculate and award additional leave for each employee ───────────────
      // Formula: (annualEntitlement / contractedHrsOnThe16th) × additionalHrs
      const leaveAwards = [];
      if (finAddlLeaveEnabled) {
      for (const r of report) {
        const additionalHrs = r.bankOT ? r.lieuBanked : (r.overtimeHrs || 0);
        if (additionalHrs <= 0) continue;

        const staff = await cosmos.getStaffById(r.staffId);
        if (!staff?.timesheetProfile) continue;

        const profile   = staff.timesheetProfile;
        const ent       = profile.leaveEntitlements || {};
        const history   = profile.contractHistory || [];
        const periodEnd = `${year}-${String(month).padStart(2,'0')}-16`;
        const contractOn16 = [...history]
          .filter(c => c.startDate <= periodEnd)
          .sort((a,b) => b.startDate.localeCompare(a.startDate))[0];

        if (!contractOn16?.contractedHrsPerMonth) continue;

        const annualEntitlement    = (ent.annual || 0);
        if (!annualEntitlement) continue;

        const contractedHrsPerYear = contractOn16.contractedHrsPerMonth * 12;
        const additionalLeave = Math.round(
          (annualEntitlement / contractedHrsPerYear) * additionalHrs * 100
        ) / 100;

        if (additionalLeave <= 0) continue;

        // Store additionalLeave on the report entry for leave report display
        r.additionalLeave = additionalLeave;

        // Add to annual leave entitlement
        const newAnnual = Math.round(((ent.annual || 0) + additionalLeave) * 100) / 100;
        const updatedProfile = {
          ...profile,
          leaveEntitlements: { ...ent, annual: newAnnual },
        };
        await cosmos.upsertStaff({ ...staff, timesheetProfile: updatedProfile });
        await cosmos.writeAudit("leave.additional_awarded", admin, {
          targetId: r.staffId, targetName: r.name, targetType: "staff",
          detail: `Additional leave awarded: ${additionalLeave}h (annual now ${newAnnual}h) — ${additionalHrs}h additional hours in ${year}-${String(month).padStart(2,'0')}`,
        });
        leaveAwards.push({ staffId: r.staffId, name: r.name, additionalLeave, additionalHrs });
      }
      } // end if (finAddlLeaveEnabled)

      const run = {
        id, year, month,
        status: "finalised",
        lockedAt: nowLondon(),
        lockedById: admin.id,
        lockedByName: admin.name,
        employees: Object.fromEntries(report.map(r => [r.staffId, r])),
        leaveAwards,
      };

      await cosmos.upsertPayrollRun(run);
      await cosmos.writeAudit("payroll.finalised", admin, {
        targetId: id, targetType: "payroll",
        detail: `Payroll finalised for ${year}-${String(month).padStart(2,'0')} by ${admin.name} (${report.length} employees, total: £${report.reduce((s,r)=>s+r.totalPay,0).toFixed(2)}, ${leaveAwards.length} leave awards)`,
      });

      return json({ ok: true, id, leaveAwards });
    } catch (e) {
      return errFromException(e, "payrollFinalise");
    }
  },
});

// ── POST /api/payroll/unlock ──────────────────────────────────────────────────

app.http("payrollUnlock", {
  methods: ["POST"],
  route: "payroll/unlock",
  handler: async (req, context) => {
    try {
      const admin = await requireAdmin(req);
      if (!admin) return err("Forbidden", 403);

      let body;
      try { body = await req.json(); } catch { return err("Invalid JSON"); }
      const { year, month } = body;

      const existing = await cosmos.getPayrollRun(year, month);
      if (!existing) return err("No payroll run found for this period", 404);

      await cosmos.upsertPayrollRun({ ...existing, status: "draft",
        unlockedAt: nowLondon(), unlockedById: admin.id, unlockedByName: admin.name });

      await cosmos.writeAudit("payroll.unlocked", admin, {
        targetId: existing.id, targetType: "payroll",
        detail: `Payroll unlocked for ${year}-${String(month).padStart(2,'0')} by ${admin.name}`,
      });

      return json({ ok: true });
    } catch (e) {
      return errFromException(e, "payrollUnlock");
    }
  },
});

// ── GET /api/payroll/runs ─────────────────────────────────────────────────────

app.http("payrollRuns", {
  methods: ["GET"],
  route: "payroll/runs",
  handler: async (req, context) => {
    try {
      const admin = await requireAdmin(req);
      if (!admin) return err("Forbidden", 403);
      const url2   = new URL(req.url);
      const full   = url2.searchParams.get("full") === "1";
      const fyYear = parseInt(url2.searchParams.get("fyYear")) || null;
      const allRuns = await cosmos.getPayrollRuns(24);
      let filtered = fyYear ? allRuns.filter(r =>
        (r.year === fyYear && r.month >= 4) || (r.year === fyYear + 1 && r.month <= 3)
      ) : allRuns;
      const runs = full
        ? filtered  // full employee breakdown for leave report
        : filtered.map(r => ({ id: r.id, year: r.year, month: r.month, status: r.status, lockedAt: r.lockedAt, lockedByName: r.lockedByName, employees: r.employees || {} }));
      return json({ runs });
    } catch (e) {
      return errFromException(e, "payrollRuns");
    }
  },
});

// ── GET /api/payroll/leave-earned?staffId=&fyYear= ────────────────────────────
// Returns total additional leave earned from locked payroll runs in a financial year
// Used by dashboard to add to the dynamic leave balance calculation

app.http("payrollLeaveEarned", {
  methods: ["GET"],
  route: "payroll/leave-earned",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const url     = new URL(req.url);
      const staffId = url.searchParams.get("staffId") || caller.id;
      const fyYear  = parseInt(url.searchParams.get("fyYear")) || new Date().getFullYear();

      // Financial year: April fyYear to March fyYear+1
      // Payroll runs are identified by year/month
      const runs = await cosmos.getPayrollRuns(24);
      const fyRuns = runs.filter(r => {
        if (r.status !== "finalised") return false;
        // Apr fyYear (month 4) to Mar fyYear+1 (month 3)
        if (r.year === fyYear && r.month >= 4) return true;
        if (r.year === fyYear + 1 && r.month <= 3) return true;
        return false;
      });

      // Sum additionalLeaveEarned and lieuBanked for this staff member across FY runs
      // Need full run documents for employee detail
      const fullRuns = await cosmos.getFullPayrollRunsForFY(fyYear);

      let totalAdditionalLeave = 0;
      let totalLieuBanked = 0;
      const breakdown = [];
      for (const run of fullRuns) {
        const emp = run.employees?.[staffId];
        if (!emp) continue;
        totalLieuBanked += emp.lieuBanked || 0;
        const netLeave = emp?.netAdditionalLeave ?? emp?.additionalLeaveEarned ?? 0;
        if (netLeave !== 0) {
          totalAdditionalLeave += netLeave;
          breakdown.push({
            year: run.year, month: run.month,
            additionalLeaveEarned: emp.additionalLeaveEarned || 0,
            priorMonthLeaveAdj:    emp.priorMonthLeaveAdj    || 0,
            netAdditionalLeave:    netLeave,
            additionalHrs: emp.overtimeHrs + (emp.lieuBanked || 0),
          });
        }
      }

      return json({
        staffId, fyYear,
        totalAdditionalLeave: Math.round(totalAdditionalLeave * 100) / 100,
        totalLieuBanked:      Math.round(totalLieuBanked      * 100) / 100,
        breakdown,
      });
    } catch (e) {
      return errFromException(e, "payrollLeaveEarned");
    }
  },
});

// Estimate prior-month adjustment for the Employee Summary.
// Mirrors the logic in calcPayrollForStaff but accessible to any authenticated user for their own staffId.
app.http("payrollPriorAdjEstimate", {
  methods: ["GET"],
  route: "payroll/prior-adj-estimate",
  handler: async (req, context) => {
    try {
      const caller = await requireAuth(req);
      if (!caller) return err("Unauthorised", 401);

      const url     = new URL(req.url);
      const staffId = url.searchParams.get("staffId") || caller.id;
      const year    = parseInt(url.searchParams.get("year"));
      const month   = parseInt(url.searchParams.get("month"));

      if (!year || !month || month < 1 || month > 12) return err("year and month required", 400);
      if (staffId !== caller.id && caller.access?.timesheets !== "admin") return err("Forbidden", 403);

      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear  = month === 1 ? year - 1 : year;

      const priorRun = await cosmos.getPayrollRun(prevYear, prevMonth);
      if (!priorRun || priorRun.status !== "finalised") {
        return json({ priorAdjHrs: 0, priorAdjPay: 0, priorLieuAdj: 0, priorUnpaidAdj: 0, hasPriorRun: false });
      }

      const prEmp = priorRun.employees?.[staffId];
      if (!prEmp) {
        return json({ priorAdjHrs: 0, priorAdjPay: 0, priorLieuAdj: 0, priorUnpaidAdj: 0, hasPriorRun: true });
      }

      const staff = await cosmos.getStaffById(staffId);
      if (!staff) return err("Staff not found", 404);

      // Fetch entries for the previous period (same date range as payroll/calculate uses for recalc)
      const prevPrevMonth   = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevPrevYear    = prevMonth === 1 ? prevYear - 1 : prevYear;
      const prevPeriodStart = isoDate(prevPrevYear, prevPrevMonth, 17);
      const prevCalEnd      = isoDate(prevYear, prevMonth, daysInMonth(prevYear, prevMonth));

      const prevEntries = await cosmos.getEntriesByStaffAndPeriod(staffId, prevPeriodStart, prevCalEnd);

      // Recalculate previous period with current entries (includePending = true, same as payroll/calculate)
      const recalc = calcPayrollForStaff(staff, prevYear, prevMonth, prevEntries, null, false, true);

      const r2 = (n) => Math.round((n || 0) * 100) / 100;
      const bankOT = staff.timesheetProfile?.overtimeBanking?.enabled || false;

      const recalcTotal = recalc.totalPaidHrs;
      const prevTotal   = prEmp.totalPaidHrs            || 0;
      const prevContr   = prEmp.contractualHrsPeriod    || 0;
      const prevOTHrs   = prEmp.overtimeHrs             || 0;
      const priorRate   = prEmp.rateOn16                || 0;
      const prevUnpaid  = prEmp.unpaidLeaveHrs          || 0;
      const newUnpaid   = recalc.unpaidLeaveHrs         || 0;
      const lateUnpaid  = Math.max(0, r2(newUnpaid - prevUnpaid));

      let priorAdjHrs = 0, priorAdjPay = 0, priorLieuAdj = 0, priorUnpaidAdj = 0;

      if (recalcTotal > prevTotal && recalcTotal > prevContr) {
        priorAdjHrs  = Math.min(r2(recalcTotal - prevTotal), r2(recalcTotal - prevContr));
        priorAdjPay  = bankOT ? 0 : r2(priorAdjHrs * priorRate);
        priorLieuAdj = bankOT ? priorAdjHrs : 0;
      } else if (recalcTotal < prevTotal && prevOTHrs > 0) {
        const deductHrs = Math.min(r2(prevTotal - recalcTotal), prevOTHrs);
        priorAdjHrs  = -deductHrs;
        priorAdjPay  = bankOT ? 0 : -r2(deductHrs * priorRate);
        priorLieuAdj = bankOT ? -deductHrs : 0;
      }

      if (lateUnpaid > 0) {
        priorUnpaidAdj = r2(lateUnpaid * priorRate);
      }

      return json({ priorAdjHrs, priorAdjPay, priorLieuAdj, priorUnpaidAdj, hasPriorRun: true });
    } catch (e) {
      return errFromException(e, "payrollPriorAdjEstimate");
    }
  },
});
