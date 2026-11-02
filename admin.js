const C = LU_CONFIG, sb = supabase.createClient(C.url, C.key), app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const T = {
  announcements: { label: "Announcements", order: "date", title: "title", f: [["title", "Title"], ["date", "Date", "date"], ["text", "Text", "textarea"], ["pdf_path", "Flyer (PDF or image)", "file", "application/pdf,image/png,image/jpeg,image/webp"], ["publish_at", "Publish at (leave blank to post right away)", "datetime_opt"]] },
  videos: { label: "Videos", order: "date", title: "title", f: [["title", "Title"], ["date", "Date", "date"], ["description", "Description", "textarea"], ["youtube_id", "YouTube video link", "yt"], ["google_drive_id", "Google Drive video link", "drive"], ["publish_at", "Publish at (leave blank to post right away)", "datetime_opt"]] },
  faq: { label: "FAQ", order: "sort_order", asc: 1, title: "question", f: [["question", "Question"], ["answer", "Answer (links and line breaks OK)", "textarea"], ["sort_order", "Order (1 = first)", "number"]] },
  themes: { label: "Photo Challenge", order: "starts_at", title: "title", f: [["title", "Theme"], ["description", "Description", "textarea"], ["starts_at", "Starts", "datetime"], ["ends_at", "Ends (next theme starts then)", "datetime"], ["video_path", "Finished video (optional)", "file", "video/mp4,video/webm"]] },
};
const DEFAULT_ADMIN_TAB_ORDER = ["announcements", "videos", "themes", "_h", "home", "_s", "_a", "_n"];
let cur = "announcements", ROLE = "student";
let ADMIN_TAB_ORDER = DEFAULT_ADMIN_TAB_ORDER.slice(), ADMIN_TAB_ORDER_ERROR = "";
let leadershipAssignmentsOpen = false;
const ADMIN_TAB_CACHE_TTL = 5 * 60 * 1000;
const adminTabViews = new Map();
let activeViewGeneration = 0;
let activeViewLoadedAt = 0;
const isCurrentView = generation => generation === activeViewGeneration;
const hasGoogleIdentity = user => user?.app_metadata?.provider === "google"
  || (Array.isArray(user?.app_metadata?.providers) && user.app_metadata.providers.includes("google"))
  || user?.identities?.some(identity => identity.provider === "google");
const rotationWeekStart = weekday => {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceRotation = (new Date(todayUtc).getUTCDay() - weekday + 7) % 7;
  return new Date(todayUtc - daysSinceRotation * 86400000).toISOString().slice(0, 10);
};
const dateInEastern = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = name => parts.find(item => item.type === name).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const rotationWeekStartForDate = (weekday, dateString) => {
  const date = Date.parse(`${dateString}T00:00:00Z`);
  const daysSinceRotation = (new Date(date).getUTCDay() - weekday + 7) % 7;
  return new Date(date - daysSinceRotation * 86400000).toISOString().slice(0, 10);
};
const thursdayBeforeMeeting = dateString => {
  const date = Date.parse(`${dateString}T00:00:00Z`);
  const daysSinceThursday = ((new Date(date).getUTCDay() - 4 + 7) % 7) || 7;
  return new Date(date - daysSinceThursday * 86400000).toISOString().slice(0, 10);
};
const leadershipAssignmentWeekStart = settings => {
  const currentWeek = rotationWeekStart(settings.rotation_weekday);
  if (!settings.rotation_paused || !settings.next_meeting_date) return currentWeek;
  const today = dateInEastern(), resumeDate = thursdayBeforeMeeting(settings.next_meeting_date);
  const meetingWeek = rotationWeekStartForDate(settings.rotation_weekday, settings.next_meeting_date);
  return today >= resumeDate && today <= settings.next_meeting_date && meetingWeek > currentWeek
    ? meetingWeek
    : currentWeek;
};
const loc = v => { const d = new Date(v); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };
const isValidTimeZone = value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; }
  catch { return false; }
};
const ytId = v => {
  const value = v.trim();
  const id = (value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})(?:[?&#/]|$)/) || [, value])[1];
  return /^[\w-]{11}$/.test(id) ? id : null;
};
const driveId = value => {
  const input = value.trim();
  if (/^[\w-]{10,}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)drive\.google\.com$/i.test(url.hostname)) return null;
    const id = url.pathname.match(/^\/file\/d\/([\w-]{10,})(?:\/|$)/)?.[1] || url.searchParams.get("id");
    return /^[\w-]{10,}$/.test(id || "") ? id : null;
  } catch { return null; }
};

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!hasGoogleIdentity(session?.user)
      && String(session?.user?.app_metadata?.must_change_password).toLowerCase() === "true") {
    location.replace("change-password.html?next=" + encodeURIComponent("admin.html"));
    return;
  }
  if (!session) return app.innerHTML = '<p>Please sign in with your admin account.</p><button class="auth-btn" id="g">Sign in</button>',
    document.getElementById("g").onclick = () => (location.href = "login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() || "index.html"));
  let role = (await sb.rpc("my_role")).data;
  if (!role) role = (await sb.rpc("is_admin")).data ? "admin" : "student";
  ROLE = role;
  if (role !== "admin" && role !== "leader") return app.innerHTML = "<p>This account isn't an admin or part of Student Leadership. Ask an admin to add your email.</p>";
  if (role === "admin") {
    const { data: settings, error } = await sb.from("leadership_hub_settings").select("admin_tab_order").eq("id", 1).single();
    if (error) {
      ADMIN_TAB_ORDER_ERROR = `Tab order couldn't be loaded. Run update-10-student-leadership-hub.sql. (${error.message})`;
      console.error(ADMIN_TAB_ORDER_ERROR);
    } else if (Array.isArray(settings.admin_tab_order)) {
      ADMIN_TAB_ORDER = [...new Set(settings.admin_tab_order.filter(id => DEFAULT_ADMIN_TAB_ORDER.includes(id)))];
    }
  }
  show();
}
function tabs() {
  const keys = ROLE === "admin" ? Object.keys(T).filter(k => k !== "faq") : ["announcements", "videos", "themes"];
  const entries = keys.map(key => ({ id: key, label: T[key].label }));
  if (ROLE === "admin") entries.push(
    { id: "_h", label: "Student Leadership" }, { id: "home", label: "Home Page" },
    { id: "_s", label: "Students" }, { id: "_a", label: "Admins" }, { id: "_n", label: "Email alerts" }
  );
  const entryMap = new Map(entries.map(entry => [entry.id, entry]));
  const preferredOrder = ROLE === "admin" ? ADMIN_TAB_ORDER : entries.map(entry => entry.id);
  const ordered = [...preferredOrder.filter(id => entryMap.has(id)), ...entries.map(entry => entry.id).filter(id => !preferredOrder.includes(id))]
    .map(id => entryMap.get(id));
  const btn = ({ id, label }) => `<button class="auth-btn alt ${cur === id ? "on" : ""}" data-t="${id}" ${ROLE === "admin" ? 'draggable="true" title="Drag to reorder tabs"' : ""}>${label}</button>`;
  return "<nav aria-label=\"Admin tools\">" + ordered.map(btn).join("") + "</nav>" +
    (ADMIN_TAB_ORDER_ERROR ? `<small class="auth-error">${esc(ADMIN_TAB_ORDER_ERROR)}</small>` : "") +
    (ROLE === "leader" ? '<p class="role-note"><small>Student Leadership access: you can add announcements, videos and photo themes, and approve or reject photos.</small></p>' : "");
}
function wire() {
  app.querySelectorAll("[data-t]").forEach(b => b.onclick = () => navigateToTab(b.dataset.t));
  if (ROLE !== "admin") return;
  const nav = app.querySelector(".adm nav");
  if (!nav) return;
  let draggedTab = null;
  nav.querySelectorAll("[data-t]").forEach(button => {
    button.ondragstart = event => {
      draggedTab = button;
      button.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", button.dataset.t);
    };
    button.ondragend = () => { button.classList.remove("dragging"); draggedTab = null; };
  });
  nav.ondragover = event => {
    if (event.target.closest("[data-t]")) event.preventDefault();
  };
  nav.ondrop = async event => {
    event.preventDefault();
    const target = event.target.closest("[data-t]");
    if (!draggedTab || !target || target === draggedTab) return;
    const buttons = [...nav.querySelectorAll("[data-t]")];
    if (buttons.indexOf(draggedTab) < buttons.indexOf(target)) target.after(draggedTab);
    else target.before(draggedTab);
    const order = [...nav.querySelectorAll("[data-t]")].map(button => button.dataset.t);
    const { error } = await sb.from("leadership_hub_settings").update({ admin_tab_order: order }).eq("id", 1);
    if (error) {
      alert(`Could not save tab order: ${error.message}`);
      show();
      return;
    }
    ADMIN_TAB_ORDER = order;
    adminTabViews.clear();
  };
}

function renderCurrentTab(generation) {
  if (cur === "home") return homeTabUI(generation);
  if (cur === "_s") return studentsUI("", generation);
  if (cur === "_h") return studentLeadershipUI(generation);
  if (cur === "_a") return peopleUI("admins", "Admins", "Admins can do everything on the site. The person needs to sign in with Google once to create their student account first.", "Give admin access to", "Make admin", generation);
  if (cur === "_n") return alertsUI(generation);
  return listUI(cur, app, generation);
}
function showLoadingState() {
  const nav = tabs();
  const label = nav.match(new RegExp(`data-t="${cur}"[^>]*>([^<]+)`))?.[1] || "tab";
  app.innerHTML = nav + `<p class="admin-tab-loading" role="status">Loading ${esc(label)}…</p>`;
  wire();
}
async function show() {
  if (ROLE !== "admin" && !["announcements", "videos", "themes"].includes(cur)) cur = "announcements";
  const generation = ++activeViewGeneration;
  activeViewLoadedAt = 0;
  adminTabViews.delete(cur);
  showLoadingState();
  await renderCurrentTab(generation);
  if (generation === activeViewGeneration) activeViewLoadedAt = Date.now();
}
function saveCurrentTabView() {
  if (!app.childNodes.length) return;
  const fragment = document.createDocumentFragment();
  while (app.firstChild) fragment.appendChild(app.firstChild);
  adminTabViews.set(cur, { fragment, loadedAt: activeViewLoadedAt });
}
function navigateToTab(tab) {
  if (tab === cur) return;
  saveCurrentTabView();
  cur = tab;
  const generation = ++activeViewGeneration;
  const cached = adminTabViews.get(cur);
  if (cached) {
    adminTabViews.delete(cur);
    if (T[cur]) LT = cur;
    else if (cur === "home") LT = "faq";
    app.replaceChildren(cached.fragment);
    activeViewLoadedAt = cached.loadedAt;
    wire();
    if (Date.now() - cached.loadedAt < ADMIN_TAB_CACHE_TTL) return;
  } else {
    activeViewLoadedAt = 0;
    showLoadingState();
  }
  renderCurrentTab(generation).then(() => {
    if (generation === activeViewGeneration) activeViewLoadedAt = Date.now();
  });
}

let LT = "announcements";
async function listUI(table, host, generation = activeViewGeneration) {
  const parentTab = host === app ? table : cur;
  LT = table; const t = T[table];
  const { data, error: listError } = await sb.from(table).select("*").order(t.order, { ascending: !!t.asc });
  const rows = data ?? [];
  const { data: { session } } = await sb.auth.getSession();
  if (!isCurrentView(generation)) return;
  let scheduleBlock = "";
  if (table === "themes" && ROLE === "admin") {
    const { data: st, error: settingsError } = await sb.from("settings").select("*").eq("id", 1).single();
    if (!isCurrentView(generation)) return;
    if (settingsError) scheduleBlock = `<p class="auth-error">Could not load schedule settings: ${esc(settingsError.message)}</p>`;
    else if (st) scheduleBlock = `<form id="theme-schedule" class="admin-schedule"><h3>Photo Theme Schedule Settings</h3>
      <label>Days each theme runs <small>Used to suggest dates for new themes. You can still edit each theme's dates individually.</small><input name="theme_length_days" type="number" min="1" value="${st.theme_length_days}"></label>
      <label>Photos per student per theme<input name="max_photos_per_theme" type="number" min="1" value="${st.max_photos_per_theme}"></label>
      <label>Time zone <small>e.g. America/Denver, America/New_York</small><input name="timezone" value="${esc(st.timezone)}"></label>
      <label class="chk"><input type="checkbox" name="public_photo_page" ${st.public_photo_page ? "checked" : ""}> Turn on the public photo page (no sign-in)</label>
      <small>Share this link: <b id="pub-link"></b><br>Anyone with the link can submit photos (you approve each one first) and see approved photos from finished themes. That means photos of students can be seen by anyone who has the link, so only switch this on if families are comfortable with that. Switch it off any time.</small>
      <div><button class="auth-btn" type="submit">Save schedule settings</button></div><small id="schedule-msg"></small></form>`;
  }
  const listContent = `<button class="auth-btn" id="new">+ Add new</button><div id="list">` +
    rows.map(r => {
      const canManage = ROLE === "admin" || (table === "announcements" && ROLE === "leader" && r.created_by === session?.user?.id);
      return `<div class="admin-edit-item"><div class="row"><span>${esc(r[t.title])} <small>${esc(r.date || (r.starts_at ? new Date(r.starts_at).toLocaleString() : ""))}</small>${r.publish_at && new Date(r.publish_at) > new Date() ? ` <span class="sched-badge">Scheduled for ${esc(new Date(r.publish_at).toLocaleString())}</span>` : ""}</span><span>${table === "themes" ? `<button class="auth-btn alt" data-ph="${r.id}">Photos</button> ` : ""}${canManage ? `<button class="auth-btn alt" data-e="${r.id}">Edit</button> <button class="auth-btn alt" data-d="${r.id}">Delete</button>` : ""}</span></div><div id="item-form-${r.id}" class="admin-inline-edit"></div></div>`;
    }).join("") + "</div><div id=\"form\"></div>";
  host.innerHTML = (host === app ? tabs() : "") + (listError ? `<p class="auth-error">Could not load ${esc(t.label.toLowerCase())}: ${esc(listError.message)}</p>` : "") +
    (table === "themes"
      ? `<div class="photo-admin-layout">
          <section class="photo-approval-panel" aria-label="Photo approval"><div id="photos-section"></div></section>
          <section class="photo-theme-column"><div class="photo-theme-list">${listContent}</div>${scheduleBlock}</section>
          <section class="photo-manual-panel"><div id="photo-manual-upload"></div></section>
        </div>`
      : listContent + scheduleBlock);
  if (host === app) wire();
  const scheduleForm = document.getElementById("theme-schedule");
  const pl = document.getElementById("pub-link"); if (pl) pl.textContent = new URL("share-photos.html", location.href).href;
  if (scheduleForm) scheduleForm.onsubmit = async e => {
    e.preventDefault(); const f = e.target.elements, msg = document.getElementById("schedule-msg"); msg.textContent = "Saving…";
    if (!isValidTimeZone(f.timezone.value.trim())) { msg.textContent = "Enter a valid time zone, such as America/Denver."; return; }
    const { error } = await sb.from("settings").update({ theme_length_days: +f.theme_length_days.value, max_photos_per_theme: +f.max_photos_per_theme.value, timezone: f.timezone.value.trim(), public_photo_page: f.public_photo_page.checked }).eq("id", 1);
    msg.textContent = error ? "Error: " + error.message : "Saved";
  };
  if (table === "themes") photosSection();
  document.getElementById("new").onclick = () => form(null);
  host.querySelectorAll("[data-ph]").forEach(b => b.onclick = async () => { sel = b.dataset.ph; await photosSection(); document.getElementById("photos-section").scrollIntoView({ behavior: "smooth" }); });
  host.querySelectorAll("[data-e]").forEach(b => b.onclick = () => { const row = rows.find(r => r.id === b.dataset.e); form(row, document.getElementById(`item-form-${b.dataset.e}`)); });
  host.querySelectorAll("[data-d]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this permanently?")) return;
    const { data, error } = await sb.from(table).delete().eq("id", b.dataset.d).select("id").maybeSingle();
    if (error || !data) return alert(error?.message || "The item was not deleted.");
    const deletedRow = rows.find(row => row.id === b.dataset.d);
    if (table === "announcements" && deletedRow?.pdf_path) {
      const { error: fileError } = await sb.storage.from("media").remove([deletedRow.pdf_path]);
      if (fileError) return alert(`Announcement deleted, but its flyer could not be removed: ${fileError.message}`);
    }
    if (cur === parentTab) show();
  });
}

async function form(row, target = document.getElementById("form")) {
  const formTable = LT, formTab = formTable === "faq" ? "home" : formTable;
  const t = T[formTable]; let d = row || {};
  let suggestionError = "";
  if (!row && formTable === "themes") {
    const { data, error } = await sb.rpc("next_theme_window");
    if (error) suggestionError = "Could not suggest dates: " + error.message;
    else if (data?.[0]) d = { starts_at: data[0].starts_at, ends_at: data[0].ends_at };
  }
  const el = target || document.getElementById("form");
  el.innerHTML = `<form><h3>${row ? "Edit" : "New"} ${t.label}</h3>${suggestionError ? `<p class="auth-error">${esc(suggestionError)}</p>` : ""}` + t.f.map(([k, lab, type, acc]) => {
    const v = d[k] ?? "";
    if (type === "textarea") return `<label>${lab}<textarea name="${k}" rows="4">${esc(v)}</textarea></label>`;
    if (type === "file") return `<label>${lab}${v ? ` <small>Current file kept unless you choose a new one</small>` : ""}<input type="file" name="${k}" accept="${acc}"></label>`;
    if (type === "drive") return `<label>${lab}<input name="${k}" value="${esc(v)}" placeholder="Paste a Google Drive sharing link or file ID"><small class="drive-sharing-reminder"><strong>Before saving:</strong> In Google Drive, set the video's General access to “Anyone with the link” so students can watch it. Use either a YouTube link or a Google Drive link.</small></label>`;
    if (type === "datetime_opt") return `<label>${lab}<input type="datetime-local" name="${k}" value="${v ? loc(v) : ""}"><small>Students see it at this date and time. Blank = visible immediately.</small></label>`;
    if (type === "datetime") return `<label>${lab}<input type="datetime-local" name="${k}" value="${v ? loc(v) : ""}" required></label>`;
    return `<label>${lab}<input name="${k}" type="${type === "yt" ? "text" : type || "text"}" value="${esc(type === "date" && !v ? new Date().toISOString().slice(0, 10) : v)}" ${["title", "question", "answer"].includes(k) ? "required" : ""}></label>`;
  }).join("") + '<div><button class="auth-btn" type="submit">Save</button> <button class="auth-btn alt" type="button" id="x">Cancel</button></div><small id="msg"></small></form>';
  el.querySelector("#x").onclick = () => (el.innerHTML = "");
  el.querySelector("form").onsubmit = async e => {
    e.preventDefault(); const msg = el.querySelector("#msg"); msg.textContent = "Saving…";
    const out = {}, uploaded = [], replaced = [];
    for (const [k, , type] of t.f) {
      const inp = e.target.elements[k];
      if (type === "file") {
        const f = inp.files[0]; if (!f) continue;
        let path = crypto.randomUUID() + "." + (f.name.split(".").pop() || "bin").toLowerCase();
        if (formTable === "announcements" && ROLE === "leader") {
          const { data: { session }, error: sessionError } = await sb.auth.getSession();
          if (sessionError || !session) return (msg.textContent = `Could not verify the signed-in member: ${sessionError?.message || "no active session"}`);
          path = `${session.user.id}/${path}`;
        }
        const up = await sb.storage.from("media").upload(path, f);
        if (up.error) return (msg.textContent = "Upload failed: " + up.error.message);
        out[k] = path;
        uploaded.push(path);
        if (row?.[k]) replaced.push(row[k]);
      } else if (type === "datetime_opt") out[k] = inp.value ? new Date(inp.value).toISOString() : new Date().toISOString();
      else if (type === "datetime") out[k] = new Date(inp.value).toISOString();
      else if (type === "yt") {
        const value = inp.value.trim(), id = value ? ytId(value) : null;
        if (value && !id) { msg.textContent = "Enter a valid YouTube video URL or 11-character video ID."; return; }
        out[k] = id;
      }
      else if (type === "drive") {
        const value = inp.value.trim(), id = value ? driveId(value) : null;
        if (value && !id) { msg.textContent = "Enter a valid Google Drive video link or file ID."; return; }
        out[k] = id;
      }
      else if (type === "number") out[k] = Number(inp.value) || 0;
      else out[k] = inp.value.trim() || null;
    }
    if (formTable === "videos") {
      const youtubeInput = e.target.elements.youtube_id.value.trim();
      const driveInput = e.target.elements.google_drive_id.value.trim();
      if (youtubeInput && driveInput) { msg.textContent = "Use either a YouTube link or a Google Drive link, not both."; return; }
      if (!youtubeInput && !driveInput && !row?.video_path) {
        msg.textContent = "Add a YouTube link or a Google Drive link before saving.";
        return;
      }
      const sourceChanged = out.youtube_id !== (row?.youtube_id ?? null) ||
        out.google_drive_id !== (row?.google_drive_id ?? null);
      if (sourceChanged) {
        out.video_path = null;
        if (row?.video_path) replaced.push(row.video_path);
      }
    }
    const q = row ? sb.from(formTable).update(out).eq("id", row.id) : sb.from(formTable).insert(out);
    const { error } = await q;
    if (error) {
      const cleanup = uploaded.length ? await sb.storage.from("media").remove(uploaded) : { error: null };
      msg.textContent = "Error: " + error.message + (cleanup.error ? " Uploaded file cleanup failed: " + cleanup.error.message : "");
      return;
    }
    if (replaced.length) {
      const cleanup = await sb.storage.from("media").remove(replaced);
      if (cleanup.error) {
        msg.textContent = "Saved, but the replaced file could not be removed: " + cleanup.error.message;
        return;
      }
    }
    if (cur === formTab) show();
  };
}


const DEFAULT_PORTAL_TILES = [
  { title: "Calendar", description: "Co-op events, activities, and important dates.", url: "https://calendar.google.com", cta: "Open Google Calendar", icon: "calendar", secondary_text: "Open Family Sync", secondary_url: "https://familysync.latterup.org/" },
  { title: "Google Drive", description: "Your files, docs, slides, and sheets.", url: "https://drive.google.com", cta: "Open Google Drive", icon: "drive" },
  { title: "Google Chat", description: "Message teachers, classmates, and friends.", url: "https://mail.google.com/chat", cta: "Open Chat", icon: "chat" },
  { title: "Email", description: "Check your email and message teachers and friends.", url: "https://mail.google.com", cta: "Open Email", icon: "email" },
  { title: "Google Classroom", description: "View assignments, materials, and due dates.", url: "https://classroom.google.com", cta: "Open Classroom", icon: "classroom" },
  { title: "Trackers", description: "Your Success Circle and Homeroom to-do and focus lists.", url: "https://pathwaysandpossibilities.netlify.app/tracker", cta: "Open Tracker", icon: "compass" },
  { title: "Feedback", description: "Give feedback on anything LU.", url: "https://docs.google.com/forms/d/e/1FAIpQLSfwVwucRiMsnTMPcP-LV25BrLkVb_dBFtxDyX0xMIMqguZisQ/viewform", cta: "Open Form", icon: "document" }
];
const DEFAULT_PORTAL_BANNER = { enabled: false, text: "", link_text: "Learn more", link_url: "" };
async function portalLayoutUI(host = app, generation = activeViewGeneration) {
  const { data: st, error } = await sb.from("settings").select("portal_banner,portal_tiles").eq("id", 1).single();
  if (!isCurrentView(generation)) return;
  if (error) {
    host.innerHTML = (host === app ? tabs() : "") + `<p class="auth-error">Could not load portal settings: ${esc(error.message)}</p>`;
    return;
  }
  const banner = { ...DEFAULT_PORTAL_BANNER, ...(st?.portal_banner || {}) };
  let tiles = Array.isArray(st?.portal_tiles) && st.portal_tiles.length ? st.portal_tiles : DEFAULT_PORTAL_TILES;
  host.innerHTML = (host === app ? tabs() : "") + `<section class="portal-admin-section"><h3>Announcement banner</h3><p>Show a message directly below the navigation bar. Link to another page on this site (for example <code>photos.html</code>) or paste a full external URL. People can dismiss the banner until 6 AM the next morning; changing the message or link shows it again.</p>
    <form id="portal-banner-form"><label class="inline-check"><input name="enabled" type="checkbox" ${banner.enabled ? "checked" : ""}> Show banner on the main page</label>
    <label>Announcement text<input name="text" maxlength="240" value="${esc(banner.text)}" placeholder="e.g. Photo submissions close Friday!"></label>
    <label>Link text (optional)<input name="link_text" maxlength="60" value="${esc(banner.link_text)}" placeholder="Learn more"></label>
    <label>Link destination (optional)<input name="link_url" value="${esc(banner.link_url)}" placeholder="photos.html or https://example.com"></label>
    <div><button class="auth-btn" type="submit">Save banner</button></div><small id="banner-msg"></small></form></section>
    <details class="portal-admin-section portal-tiles-admin"><summary><h3>Main page tiles</h3><span>Show or hide tile settings</span></summary>
    <p>Add, remove, edit, and drag tiles to change the order of the home page quick links. Keep destinations to a page on this site or a full URL.</p>
    <div id="portal-tile-editor" aria-label="Drag tiles to reorder">${tiles.map((t,i)=>portalTileForm(t,i)).join("")}</div>
    <div class="portal-admin-actions"><button class="auth-btn alt" type="button" id="add-portal-tile">+ Add tile</button> <button class="auth-btn" type="button" id="save-portal-tiles">Save tiles</button></div><small id="tiles-msg"></small></details>`;
  if (host === app) wire();
  const bf = document.getElementById("portal-banner-form");
  bf.onsubmit = async e => { e.preventDefault(); const f=e.target.elements; const out={enabled:f.enabled.checked,text:f.text.value.trim(),link_text:f.link_text.value.trim(),link_url:f.link_url.value.trim(),updated_at:new Date().toISOString()}; const {error}=await sb.from("settings").update({portal_banner:out}).eq("id",1); document.getElementById("banner-msg").textContent=error?"Error: "+error.message:"Saved"; };
  const editor=document.getElementById("portal-tile-editor");
  const updateTileLabels=()=>editor.querySelectorAll(".portal-tile-edit").forEach((row,index)=>{row.dataset.tileIndex=index;row.querySelector("[data-tile-number]").textContent=`Tile ${index+1}`;});
  document.getElementById("add-portal-tile").onclick=()=>{ const i=editor.querySelectorAll(".portal-tile-edit").length; editor.insertAdjacentHTML("beforeend",portalTileForm({title:"New tile",description:"",url:"index.html",cta:"Open",icon:"link"},i)); updateTileLabels(); };
  editor.addEventListener("click",e=>{const b=e.target.closest("[data-remove-tile]");if(b){b.closest(".portal-tile-edit").remove();updateTileLabels();}});
  let draggedTile=null;
  editor.addEventListener("dragstart",event=>{
    const row=event.target.closest(".portal-tile-edit");
    if(!row)return;
    draggedTile=row;
    row.classList.add("is-dragging");
    event.dataTransfer.effectAllowed="move";
    event.dataTransfer.setData("text/plain",row.dataset.tileIndex||"tile");
  });
  editor.addEventListener("dragend",event=>{
    event.target.closest(".portal-tile-edit")?.classList.remove("is-dragging");
    editor.querySelectorAll(".portal-tile-edit").forEach(row=>row.classList.remove("drop-target"));
    draggedTile=null;
  });
  editor.addEventListener("dragover",event=>{
    const target=event.target.closest(".portal-tile-edit");
    if(!draggedTile||!target||target===draggedTile)return;
    event.preventDefault();
    target.classList.add("drop-target");
    event.dataTransfer.dropEffect="move";
  });
  editor.addEventListener("dragleave",event=>event.target.closest(".portal-tile-edit")?.classList.remove("drop-target"));
  editor.addEventListener("drop",event=>{
    const target=event.target.closest(".portal-tile-edit");
    if(!draggedTile||!target||target===draggedTile)return;
    event.preventDefault();
    target.classList.remove("drop-target");
    const rect=target.getBoundingClientRect();
    editor.insertBefore(draggedTile,event.clientY<rect.top+rect.height/2?target:target.nextSibling);
    updateTileLabels();
  });
  document.getElementById("save-portal-tiles").onclick=async()=>{const msg=document.getElementById("tiles-msg"); const rows=[...editor.querySelectorAll(".portal-tile-edit")]; const out=[]; for(const row of rows){const val=n=>row.querySelector(`[name="${n}"]`).value.trim();const title=val("title"),url=val("url");if(!title||!url){msg.textContent="Each tile needs a title and destination URL.";return;}out.push({title,description:val("description"),url,cta:val("cta")||"Open",icon:val("icon")||"link",secondary_text:val("secondary_text"),secondary_url:val("secondary_url")});} msg.textContent="Saving…";const {error}=await sb.from("settings").update({portal_tiles:out}).eq("id",1);msg.textContent=error?"Error: "+error.message:"Saved";};
}
function portalTileForm(t,i){return `<div class="portal-tile-edit" data-tile-index="${i}" draggable="true"><div class="portal-tile-edit-head"><span class="portal-tile-drag-handle" aria-hidden="true">Drag to reorder</span><strong data-tile-number>Tile ${i+1}</strong><button type="button" class="auth-btn alt" data-remove-tile>Remove</button></div><div class="portal-tile-fields">
<label>Title<input name="title" value="${esc(t.title||"")}" required></label><label>Icon<select name="icon">${["calendar","drive","chat","email","classroom","compass","document","link","photo","video"].map(v=>`<option value="${v}" ${t.icon===v?"selected":""}>${v}</option>`).join("")}</select></label>
<label class="wide">Description<input name="description" value="${esc(t.description||"")}"></label><label>Destination URL<input name="url" value="${esc(t.url||"")}" placeholder="photos.html or https://…" required></label><label>Link label<input name="cta" value="${esc(t.cta||"Open")}"></label>
<label>Secondary link text (optional)<input name="secondary_text" value="${esc(t.secondary_text||"")}"></label><label>Secondary link destination (optional)<input name="secondary_url" value="${esc(t.secondary_url||"")}"></label></div></div>`;}


const DEFAULT_HOME_SECTIONS = [
  {id:"hero", label:"Welcome header", enabled:true},
  {id:"links", label:"Quick-link tiles", enabled:true},
  {id:"announcements", label:"Latest announcements", enabled:true},
  {id:"videos", label:"Latest videos", enabled:true},
  {id:"faq", label:"Frequently asked questions", enabled:true},
  {id:"photo-challenge", label:"Photo Challenge shortcut", enabled:true}
];
async function homeLayoutUI(host = app, generation = activeViewGeneration) {
  const {data: st, error} = await sb.from("settings").select("portal_home_sections").eq("id",1).single();
  if (!isCurrentView(generation)) return;
  if (error) {
    host.innerHTML = (host === app ? tabs() : "") + `<p class="auth-error">Could not load home page settings: ${esc(error.message)}</p>`;
    return;
  }
  let sections = Array.isArray(st?.portal_home_sections) && st.portal_home_sections.length ? st.portal_home_sections.filter(s=>DEFAULT_HOME_SECTIONS.some(d=>d.id===s.id)) : [...DEFAULT_HOME_SECTIONS];
  DEFAULT_HOME_SECTIONS.filter(d=>!sections.some(s=>s.id===d.id)).forEach(missing=>{
    const defaultIndex=DEFAULT_HOME_SECTIONS.findIndex(s=>s.id===missing.id);
    const next=sections.findIndex(s=>DEFAULT_HOME_SECTIONS.findIndex(d=>d.id===s.id)>defaultIndex);
    sections.splice(next<0?sections.length:next,0,missing);
  });
  host.innerHTML = (host === app ? tabs() : "") + `<section class="portal-admin-section"><h3>Home page layout</h3><p>Choose which sections appear on the home page and change their order. The Photo Challenge shortcut gives students a clear path to share photos. Your tiles, announcement banner, and content remain intact.</p>${error ? `<p class="auth-error">Couldn't load settings: ${esc(error.message)}</p>` : ""}<div id="home-section-editor" aria-label="Drag sections to reorder">${sections.map((s)=>`<div class="home-section-edit" data-section="${s.id}" draggable="true"><span class="home-drag-handle" aria-hidden="true">Move</span><label class="inline-check"><input type="checkbox" name="enabled" ${s.enabled!==false?"checked":""}> ${esc(s.label)}</label><span class="home-drag-hint">Drag to reorder</span></div>`).join("")}</div><div class="portal-admin-actions"><button class="auth-btn" id="save-home-layout">Save home page</button></div><small id="home-layout-msg"></small></section>`;
  if (host === app) wire();
  const editor=document.getElementById("home-section-editor");
  let dragging=null;
  editor.querySelectorAll(".home-section-edit").forEach(row=>{
    row.addEventListener("dragstart",e=>{dragging=row;row.classList.add("is-dragging");e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",row.dataset.section);});
    row.addEventListener("dragend",()=>{row.classList.remove("is-dragging");editor.querySelectorAll(".home-section-edit").forEach(r=>r.classList.remove("drop-target"));dragging=null;});
    row.addEventListener("dragover",e=>{e.preventDefault();if(!dragging||dragging===row)return;row.classList.add("drop-target");e.dataTransfer.dropEffect="move";});
    row.addEventListener("dragleave",()=>row.classList.remove("drop-target"));
    row.addEventListener("drop",e=>{e.preventDefault();row.classList.remove("drop-target");if(!dragging||dragging===row)return;const rect=row.getBoundingClientRect();editor.insertBefore(dragging,e.clientY<rect.top+rect.height/2?row:row.nextSibling);});
  });
  document.getElementById("save-home-layout").onclick = async () => {
    const rows=[...document.querySelectorAll(".home-section-edit")];
    const out=rows.map(r=>({id:r.dataset.section,label:DEFAULT_HOME_SECTIONS.find(s=>s.id===r.dataset.section)?.label,enabled:r.querySelector('[name="enabled"]').checked}));
    const msg=document.getElementById("home-layout-msg"); msg.textContent="Saving…";
    const {error}=await sb.from("settings").update({portal_home_sections:out}).eq("id",1);
    msg.textContent=error?"Error: "+error.message:"Saved Refresh the home page to see your changes.";
  };
}

async function settings(generation = activeViewGeneration) {
  const { data: s, error } = await sb.from("settings").select("*").eq("id", 1).single();
  if (!isCurrentView(generation)) return;
  if (error || !s) {
    app.innerHTML = tabs() + `<p class="auth-error">Could not load schedule settings: ${esc(error?.message || "No settings were returned.")}</p>`;
    return;
  }
  app.innerHTML = tabs() + `<form><h3>Schedule settings</h3>
  <label>Days each theme runs <small>Used to suggest dates when you add the next theme. You can still edit any theme's dates by hand.</small><input name="theme_length_days" type="number" min="1" value="${s.theme_length_days}"></label>
  <label>Photos per student per theme<input name="max_photos_per_theme" type="number" min="1" value="${s.max_photos_per_theme}"></label>
  <label>Time zone <small>e.g. America/Denver, America/New_York</small><input name="timezone" value="${esc(s.timezone)}"></label>
  <div><button class="auth-btn" type="submit">Save</button></div><small id="msg"></small></form>`;
  wire();
  app.querySelector("form").onsubmit = async e => {
    e.preventDefault(); const f = e.target.elements;
    if (!isValidTimeZone(f.timezone.value.trim())) { app.querySelector("#msg").textContent = "Enter a valid time zone, such as America/Denver."; return; }
    const { error } = await sb.from("settings").update({ theme_length_days: +f.theme_length_days.value, max_photos_per_theme: +f.max_photos_per_theme.value, timezone: f.timezone.value.trim() }).eq("id", 1);
    app.querySelector("#msg").textContent = error ? "Error: " + error.message : "Saved";
  };
}

let sel = null;
const shrink = f => new Promise((ok, no) => { const i = new Image(); i.onload = () => { const s = Math.min(1, 1600 / Math.max(i.width, i.height)), c = document.createElement("canvas"); c.width = i.width * s; c.height = i.height * s; c.getContext("2d").drawImage(i, 0, 0, c.width, c.height); c.toBlob(ok, "image/jpeg", .85); }; i.onerror = no; i.src = URL.createObjectURL(f); });
async function photosSection() {
  const box = document.getElementById("photos-section"); if (!box) return;
  const manualBox = document.getElementById("photo-manual-upload");
  const { data: themes, error: themesError } = await sb.from("themes").select("*").order("starts_at", { ascending: false });
  const th = themes ?? [];
  if (themesError) {
    box.innerHTML = `<h3>Photo approval</h3><p class="auth-error">Could not load themes: ${esc(themesError.message)}</p>`;
    if (manualBox) manualBox.innerHTML = "";
    return;
  }
  if (!th.length) {
    box.innerHTML = "<h3>Photo approval</h3><p>Add a theme in the left column first. For past themes, use past dates.</p>";
    if (manualBox) manualBox.innerHTML = "<h3>Manual photo uploads</h3><p>Add a theme before importing photos.</p>";
    return;
  }
  sel = th.find(t => t.id === sel)?.id || th[0].id;
  const { data: submissions, error: subsError } = await sb.from("submissions").select("*").eq("theme_id", sel).order("created_at");
  const subs = submissions ?? [];
  if (subsError) { box.innerHTML = `<h3>Photo approval</h3><p class="auth-error">Could not load submissions: ${esc(subsError.message)}</p>`; return; }
  const urls = {};
  if (subs.length) {
    let signed;
    try {
      const { data, error } = await sb.storage.from("photos").createSignedUrls(subs.map(s => s.image_path), 3600);
      signed = data;
      if (error) console.error("Some moderation photo files could not be signed:", error);
    } catch (error) {
      console.error("Moderation photo links could not be requested:", error);
      signed = [];
    }
    (signed ?? []).forEach(file => {
      if (file.signedUrl) urls[file.path] = file.signedUrl;
      else console.error("Moderation photo file could not be signed:", file.path, file.error);
    });
    const signedPaths = new Set((signed ?? []).filter(file => file.signedUrl).map(file => file.path));
    subs.filter(submission => !signedPaths.has(submission.image_path))
      .forEach(submission => console.error("Moderation photo file has no signed URL:", submission.image_path));
  }
  const opts = id => th.map(t => `<option value="${t.id}" ${t.id === id ? "selected" : ""}>${esc(t.title)} (${new Date(t.starts_at).toLocaleDateString()})</option>`).join("");
  const grp = st => subs.filter(s => s.status === st), pend = grp("pending"), appr = grp("approved"), rej = grp("rejected");
  const via = s => s.image_path.startsWith("public/") ? ' <span class="via-badge">public page</span>' : "";
  const img = s => urls[s.image_path]
    ? `<img src="${urls[s.image_path]}" alt="">`
    : '<div class="photo-missing-file" role="img" aria-label="Photo unavailable">Photo unavailable</div>';
  box.innerHTML = `<h3>Photo approval</h3><div class="photo-approval-content">
  <label>Theme <select id="ph-ts">${opts(sel)}</select></label>
  <div class="needs-approval ${pend.length ? "has" : ""}"><div class="na-head"><h4>Needs approval</h4><span class="na-count">${pend.length}</span></div>
    ${pend.length ? `<div class="thumbs">${pend.map(s => `<figure>${img(s)}<figcaption><b>${esc(s.submitted_by)}</b>${via(s)}<span><button class="auth-btn" data-s="approved" data-id="${s.id}">Approve</button> <button class="auth-btn alt" data-s="rejected" data-id="${s.id}">Reject</button></span></figcaption></figure>`).join("")}</div>` : "<p><small>Nothing waiting, all caught up</small></p>"}</div>
  <div class="approved-block"><div class="na-head"><h4>Approved</h4><span class="na-count ok">${appr.length}</span></div>
    <div class="thumbs">${appr.map(s => `<figure data-fig="${s.id}">${img(s)}<figcaption><b>${esc(s.submitted_by)}</b>${via(s)}<span><button class="auth-btn alt" data-edit="${s.id}">Edit</button></span></figcaption></figure>`).join("") || "<p><small>No approved photos yet.</small></p>"}</div></div>
  ${rej.length ? `<details class="rej"><summary>Rejected (${rej.length})</summary><div class="thumbs">${rej.map(s => `<figure>${img(s)}<figcaption><b>${esc(s.submitted_by)}</b><span><button class="auth-btn alt" data-s="approved" data-id="${s.id}">Approve</button> <button class="auth-btn alt" data-x="${s.id}" data-p="${esc(s.image_path)}">Delete</button></span></figcaption></figure>`).join("")}</div></details>` : ""}
  </div>`;
  if (manualBox) manualBox.innerHTML = `<h3>Manual photo uploads</h3><form id="ph-man"><small>Adds photos straight into the theme you choose, already approved, good for past Google Form entries. They appear in the gallery with that theme's other photos.</small>
  <label>Theme these photos belong to<select name="th" required>${opts(sel)}</select></label>
  <label>Student name shown<input name="n" required></label>
  <label>Photos<input type="file" name="f" accept="image/*" multiple required></label>
  <div><button class="auth-btn" type="submit">Import as approved</button></div><small id="ph-msg"></small></form>`;
  box.querySelector("#ph-ts").onchange = e => { sel = e.target.value; photosSection(); };
  box.querySelectorAll("[data-s]").forEach(b => b.onclick = async () => {
    const { data, error } = await sb.from("submissions").update({ status: b.dataset.s }).eq("id", b.dataset.id).select("id").maybeSingle();
    if (error || !data) return alert("Could not update photo status: " + (error?.message || "no submission was updated"));
    photosSection();
  });
  box.querySelectorAll("[data-x]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this photo?")) return;
    const { data, error } = await sb.from("submissions").delete().eq("id", b.dataset.x).select("id").maybeSingle();
    if (error || !data) return alert("Could not delete photo record: " + (error?.message || "no submission was deleted"));
    const cleanup = await sb.storage.from("photos").remove([b.dataset.p]);
    if (cleanup.error) return alert("Photo record deleted, but its file could not be removed: " + cleanup.error.message);
    photosSection();
  });
  box.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const s = subs.find(x => x.id === b.dataset.edit), fig = box.querySelector(`[data-fig="${s.id}"]`);
    fig.querySelector("figcaption").innerHTML = `<input class="ed-name" value="${esc(s.submitted_by)}" maxlength="60" aria-label="Name shown with this photo"><span><button class="auth-btn" data-save>Save name</button> <button class="auth-btn alt" data-del>Delete photo</button> <button class="auth-btn alt" data-cancel>Cancel</button></span>`;
    fig.querySelector(".ed-name").focus();
    fig.querySelector("[data-save]").onclick = async () => {
      const nm = fig.querySelector(".ed-name").value.trim(); if (!nm) return;
      const { data, error } = await sb.from("submissions").update({ submitted_by: nm }).eq("id", s.id).select("id").maybeSingle();
      if (error || !data) return alert("Could not update the name: " + (error?.message || "no submission was updated"));
      photosSection();
    };
    fig.querySelector("[data-del]").onclick = async () => {
      if (!confirm("Delete this photo permanently?")) return;
      const { data, error } = await sb.from("submissions").delete().eq("id", s.id).select("id").maybeSingle();
      if (error || !data) return alert("Could not delete photo record: " + (error?.message || "no submission was deleted"));
      const cleanup = await sb.storage.from("photos").remove([s.image_path]);
      if (cleanup.error) return alert("Photo record deleted, but its file could not be removed: " + cleanup.error.message);
      photosSection();
    };
    fig.querySelector("[data-cancel]").onclick = () => photosSection();
  });
  const manualForm = manualBox?.querySelector("#ph-man");
  if (manualForm) manualForm.onsubmit = async e => {
    e.preventDefault(); const f = e.target.elements, msg = manualBox.querySelector("#ph-msg"), target = f.th.value, files = [...f.f.files];
    for (const [k, file] of files.entries()) {
      msg.textContent = `Uploading ${k + 1} of ${files.length}…`;
      try {
        const path = `admin/${crypto.randomUUID()}.jpg`, up = await sb.storage.from("photos").upload(path, await shrink(file), { contentType: "image/jpeg" }); if (up.error) throw up.error;
        const ins = await sb.from("submissions").insert({ theme_id: target, user_id: null, submitted_by: f.n.value.trim(), image_path: path, status: "approved" });
        if (ins.error) {
          const cleanup = await sb.storage.from("photos").remove([path]);
          throw new Error(ins.error.message + (cleanup.error ? "; uploaded-file cleanup failed: " + cleanup.error.message : ""));
        }
      } catch (err) { return (msg.textContent = "Failed on " + file.name + ": " + (err.message || err)); }
    }
    sel = target; await photosSection();
    manualBox.querySelector("#ph-msg").textContent = `Imported ${files.length} photo${files.length === 1 ? "" : "s"}`;
  };
  if (ROLE !== "admin") manualBox?.querySelector("#ph-man")?.remove();
}

async function peopleUI(table, heading, blurb, addLabel, btnText, generation = activeViewGeneration) {
  const { data, error } = await sb.from(table).select("email").order("email");
  const rows = data ?? [];
  const me = (await sb.auth.getSession()).data.session.user.email.toLowerCase();
  if (!isCurrentView(generation)) return;
  app.innerHTML = tabs() + `<h3>${heading}</h3><p><small>${blurb}</small></p>${error ? `<p class="auth-error">${esc(error.message)}, run the latest SQL update first.</p>` : ""}` +
    rows.map(a => `<div class="row"><span>${esc(a.email)}</span>${table === "leadership" ? "<small>Manage chart participation below; membership is retained.</small>" : table === "admins" && a.email === me ? "<small>(you)</small>" : `<button class="auth-btn alt" data-rm="${esc(a.email)}">Remove</button>`}</div>`).join("") +
    `<form id="aa"><label>${addLabel}<input type="email" name="e" placeholder="name@latterup.org" required></label><div><button class="auth-btn" type="submit">${btnText}</button></div><small id="msg"></small></form>`;
  wire();
  app.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { if (confirm("Remove " + b.dataset.rm + " from " + heading.toLowerCase() + "?")) { const { data, error } = await sb.from(table).delete().eq("email", b.dataset.rm).select("email").maybeSingle(); if (error || !data) return alert("Could not remove " + b.dataset.rm + ": " + (error?.message || "no record was deleted")); if (cur === "_a") await show(); } });
  document.getElementById("aa").onsubmit = async e => {
    e.preventDefault(); const msg = document.getElementById("msg");
    if (error) { msg.textContent = "Could not load this list; fix the listed database error before adding entries."; return; }
    const em = e.target.elements.e.value.trim().toLowerCase();
    if (!em.endsWith("@latterup.org")) return (msg.textContent = "Use an @latterup.org address.");
    const form=e.target, button=form.querySelector('button[type="submit"]');
    button.disabled=true; msg.textContent="Adding…";
    try {
      const { error: insertError } = await sb.from(table).insert({ email: em });
      if (insertError) {
        const update=table==="admins"?"supabase/update-8-security-and-data-fixes.sql":"supabase/update-5a-leadership-team.sql";
        msg.textContent=`Could not add ${em}: ${insertError.message}. If this is a permission or missing-table error, run ${update} in Supabase SQL Editor.`;
        console.error(`Could not add ${em} to ${table}:`,insertError);
        return;
      }
      msg.textContent=`Added ${em}.`;
      if (cur === "_a") await show();
    } catch (insertError) {
      console.error(`Could not add ${em} to ${table}:`,insertError);
      msg.textContent=`Could not add ${em}: ${insertError.message || "Unexpected error."}`;
    } finally {
      if(button.isConnected) button.disabled=false;
    }
  };
}
async function studentLeadershipUI(generation = activeViewGeneration) {
  const [settingsResult, membersResult, rolesResult, assignmentResult, reportsResult, prizesResult, claimsResult] = await Promise.all([
    sb.from("leadership_hub_settings").select("*").eq("id", 1).single(),
    sb.from("leadership_chart_members").select("*").order("sort_order").order("display_name"),
    sb.from("leadership_chart_roles").select("*").order("sort_order").order("name"),
    sb.from("leadership_member_roles").select("*"),
    sb.from("leadership_chat_reports").select("*").eq("status", "pending").order("created_at"),
    sb.from("leadership_prizes").select("*").order("created_at"),
    sb.from("leadership_prize_claims").select("*").eq("status", "pending").order("created_at"),
  ]);
  if (!isCurrentView(generation)) return;
  const failure = [settingsResult, membersResult, rolesResult, assignmentResult, reportsResult, prizesResult, claimsResult].find(result => result.error);
  if (failure) {
    app.innerHTML = tabs() + `<p class="auth-error">Student Leadership settings could not load: ${esc(failure.error.message)}. Run update-10-student-leadership-hub.sql and update-19-leadership-rotation-pause.sql in Supabase SQL Editor.</p>`;
    wire();
    return;
  }
  const settings = settingsResult.data, members = membersResult.data, roles = rolesResult.data;
  const weekStart = leadershipAssignmentWeekStart(settings);
  const assignmentWeekLabel = weekStart === rotationWeekStart(settings.rotation_weekday)
    ? "this week"
    : "the next meeting";
  const [exclusionsResult, skipRequestsResult, overridesResult] = await Promise.all([
    sb.from("leadership_rotation_exclusions").select("member_email").eq("week_start", weekStart),
    sb.from("leadership_rotation_skip_requests").select("id,week_start,member_email,reason,created_at").eq("status", "pending").order("week_start").order("created_at"),
    sb.from("leadership_role_overrides").select("role_id,member_email").eq("week_start", weekStart),
  ]);
  if (!isCurrentView(generation)) return;
  const rotationFailure = [exclusionsResult, skipRequestsResult, overridesResult].find(result => result.error);
  if (rotationFailure) {
    app.innerHTML = tabs() + `<p class="auth-error">Weekly rotation settings could not load: ${esc(rotationFailure.error.message)}. Run update-12-leadership-role-overrides-and-photo-alerts.sql in Supabase SQL Editor.</p>`;
    wire();
    return;
  }
  const excludedEmails = new Set(exclusionsResult.data.map(item => item.member_email.toLowerCase()));
  const overridesByRole = new Map(overridesResult.data.map(item => [item.role_id, item.member_email]));
  const roleIdsByMember = new Map();
  assignmentResult.data.forEach(row => {
    if (!roleIdsByMember.has(row.member_email)) roleIdsByMember.set(row.member_email, []);
    roleIdsByMember.get(row.member_email).push(row.role_id);
  });
  app.innerHTML = tabs() + `<h2>Hub settings</h2>
    <form id="lh-settings" class="admin-schedule">
      <h3>Hub visibility and weekly roles</h3>
      <label>Student Leadership tab access
        <select name="visibility">
          <option value="off" ${settings.visibility === "off" ? "selected" : ""}>Off</option>
          <option value="admins" ${settings.visibility === "admins" ? "selected" : ""}>Admins only</option>
          <option value="leaders_admins" ${settings.visibility === "leaders_admins" ? "selected" : ""}>Student Leadership and admins</option>
        </select>
      </label>
      <label>Change role assignments on (UTC)
        <select name="rotation_weekday">${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, index) => `<option value="${index}" ${settings.rotation_weekday === index ? "selected" : ""}>${day}</option>`).join("")}</select>
      </label>
      <label class="chk"><input name="rotation_paused" type="checkbox" ${settings.rotation_paused ? "checked" : ""}> Pause role rotation</label>
      <label>Reason for the pause
        <textarea name="rotation_pause_reason" rows="3" maxlength="500" placeholder="For example: Student Leadership is on winter break.">${esc(settings.rotation_pause_reason || "")}</textarea>
      </label>
      <label>Next meeting date
        <input name="next_meeting_date" type="date" value="${esc(settings.next_meeting_date || "")}">
        <small>When rotation is paused, roles will appear on the Thursday before this meeting. The pause reason appears on the SL page until then.</small>
      </label>
      <div><button class="auth-btn" type="submit">Save settings</button></div><small id="lh-settings-message"></small>
    </form>
    <details class="leadership-admin-section leadership-admin-collapsible" ${leadershipAssignmentsOpen ? "open" : ""}>
      <summary>Weekly role chart assignments</summary>
      <p>Choose the roles each member can rotate through and who is included in the chart. These controls do not remove anyone from Student Leadership.</p>
      <section class="leadership-role-management">
        <h4>Chart roles</h4>
        <p>Manage role names and chart order.</p>
        <div id="lh-role-list">${roles.map((role, index) => `<div class="leadership-role-admin-row" data-role="${role.id}">
          <label>Role name<input data-role-name maxlength="80" value="${esc(role.name)}"></label>
          <label>Chart order<input data-role-order type="number" min="1" step="1" value="${index + 1}"></label>
          <button class="auth-btn alt" type="button" data-save-role>Save name</button><small data-role-message></small>
        </div>`).join("")}</div>
        <form id="lh-add-role"><label>New role name<input name="name" maxlength="80" required></label>
          <button class="auth-btn" type="submit">Add role</button><small id="lh-add-role-message"></small></form>
        <button class="auth-btn" type="button" id="lh-save-role-order">Save chart role order</button>
        <small id="lh-role-order-message"></small>
      </section>
      <button class="auth-btn alt" type="button" id="lh-shuffle-roles">Shuffle member rotation order</button>
      ${ROLE === "admin" ? `<section class="leadership-role-management">
        <h4>Assign a role for ${assignmentWeekLabel}</h4>
        <p>These assignments override the chart for ${assignmentWeekLabel} only. They do not change anyone's rotation order; clear an assignment to return that role to the rotation.</p>
        <div id="lh-weekly-role-overrides">${roles.map(role => `<div class="leadership-role-admin-row" data-week-role="${role.id}">
          <label>${esc(role.name)}<select data-week-member><option value="">Use rotating assignment</option>
            ${members.map(member => `<option value="${esc(member.email)}" ${overridesByRole.get(role.id) === member.email ? "selected" : ""}>${esc(member.display_name)} (${esc(member.email)})</option>`).join("")}
          </select></label>
          <button class="auth-btn alt" type="button" data-save-week-role>Save assignment</button><small data-week-role-message></small>
        </div>`).join("") || "<p>Add a chart role first.</p>"}</div>
      </section>
      <section class="leadership-role-management">
        <h4>Add a Student Leadership member</h4>
        <p>Add their @latterup.org email before their first sign-in. Student Leadership access is assigned by email, so no profile is needed; you can set their chart roles below and they can sign in later with the same address.</p>
        <form id="lh-add-member-email"><label>Email address<input name="email" type="email" placeholder="name@latterup.org" required></label>
          <button class="auth-btn" type="submit">Add to Student Leadership</button><small id="lh-add-member-message"></small>
        </form>
      </section>` : ""}
      <div id="lh-member-list">${members.map(member => `<article class="leadership-member-admin" data-member="${esc(member.email)}">
        <label>Display name<input data-display-name maxlength="120" value="${esc(member.display_name)}"></label>
        <label>Rotation order<input data-sort-order type="number" step="1" value="${member.sort_order}"></label>
        <label class="chk"><input data-in-cycle type="checkbox" ${member.in_cycle ? "checked" : ""}> Include in weekly rotation</label>
        <fieldset><legend>Eligible roles</legend>${roles.map(role => `<label class="chk"><input data-member-role type="checkbox" value="${role.id}" ${(roleIdsByMember.get(member.email) || []).includes(role.id) ? "checked" : ""}> ${esc(role.name)}</label>`).join("") || "<small>Run update-10-student-leadership-hub.sql to add the chart roles.</small>"}</fieldset>
        <button class="auth-btn alt" type="button" data-toggle-week-exclusion="${esc(member.email)}" data-excluded="${excludedEmails.has(member.email.toLowerCase())}">
          ${excludedEmails.has(member.email.toLowerCase()) ? `Restore from ${assignmentWeekLabel}'s rotation` : `Remove from ${assignmentWeekLabel}'s rotation`}
        </button>
        <button class="auth-btn" type="button" data-save-member>Save member</button><small data-member-message></small>
      </article>`).join("") || "<p>No Student Leadership members have been added yet.</p>"}</div>
    </details>
    <div class="leadership-admin-review-grid">
      ${ROLE === "admin" ? `<section class="leadership-admin-section"><h3>Requests to skip ${assignmentWeekLabel}'s rotation</h3><div id="lh-rotation-skip-queue"></div></section>` : ""}
      <section class="leadership-admin-section"><h3>Chat reports awaiting approval</h3><p>These reports help Student Leadership members engage with the student body and help everyone feel included. Review a screenshot of a conversation and approve it to award points.</p><div id="lh-report-queue"></div></section>
    </div>
    <section class="leadership-admin-section"><h3>Prize catalog</h3>
      <form id="lh-add-prize"><label>Prize name<input name="name" maxlength="120" required></label><label>Description<textarea name="description" rows="2"></textarea></label><label>Points required<input name="points_cost" type="number" min="1" max="100000" required></label><button class="auth-btn" type="submit">Add prize</button><small id="lh-prize-message"></small></form>
      <div id="lh-prize-list"></div>
    </section>
    <section class="leadership-admin-section"><h3>Prize requests awaiting approval</h3><div id="lh-claim-queue"></div></section>
    <form id="lh-points-settings" class="leadership-admin-section">
      <h3>Chat report points</h3>
      <label>Points for each approved chat report<input name="approval_points" type="number" min="0" max="10000" value="${settings.approval_points}" required></label>
      <button class="auth-btn" type="submit">Save points</button><small id="lh-points-message"></small>
    </form>
    ${ROLE === "admin" ? `<form id="lh-bonus-points" class="leadership-admin-section">
      <h3>Give bonus prize points</h3>
      <p>Add extra points to a Student Leadership member's prize balance. Include a reason so the award is documented.</p>
      <label>Student Leadership member<select name="member_email" required>
        <option value="">Choose a member</option>${members.map(member => `<option value="${esc(member.email)}">${esc(member.display_name)} (${esc(member.email)})</option>`).join("")}
      </select></label>
      <label>Bonus points<input name="points" type="number" min="1" max="10000" step="1" required></label>
      <label>Reason<input name="reason" maxlength="300" required></label>
      <button class="auth-btn" type="submit">Award bonus points</button><small id="lh-bonus-points-message"></small>
    </form>` : ""}`;
  wire();
  const assignmentsDetails = document.querySelector(".leadership-admin-collapsible");
  assignmentsDetails.addEventListener("toggle", () => { leadershipAssignmentsOpen = assignmentsDetails.open; });
  document.querySelectorAll("[data-save-week-role]").forEach(button => button.onclick = async () => {
    const row = button.closest("[data-week-role]");
    const message = row.querySelector("[data-week-role-message]");
    button.disabled = true;
    const { error } = await sb.rpc("set_leadership_role_override", {
      p_week_start: weekStart,
      p_role_id: row.dataset.weekRole,
      p_member_email: row.querySelector("[data-week-member]").value || null,
    });
    if (error) {
      message.textContent = `Could not save the assignment for ${assignmentWeekLabel}: ${error.message}`;
      button.disabled = false;
      return;
    }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  });
  const addMemberEmailForm = document.getElementById("lh-add-member-email");
  if (addMemberEmailForm) addMemberEmailForm.onsubmit = async event => {
    event.preventDefault();
    const email = event.target.elements.email.value.trim().toLowerCase();
    const message = document.getElementById("lh-add-member-message");
    const button = event.target.querySelector('[type="submit"]');
    if (!email.endsWith("@latterup.org")) {
      message.textContent = "Use an @latterup.org email address.";
      return;
    }
    button.disabled = true;
    const { error } = await sb.from("leadership").insert({ email });
    if (error) {
      message.textContent = `Could not add ${email}: ${error.message}`;
      button.disabled = false;
      return;
    }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  };
  document.querySelectorAll("[data-toggle-week-exclusion]").forEach(button => button.onclick = async () => {
    const email = button.dataset.toggleWeekExclusion;
    const exclude = button.dataset.excluded !== "true";
    button.disabled = true;
    const { error } = await sb.rpc("set_leadership_rotation_exclusion", {
      p_week_start: weekStart,
      p_member_email: email,
      p_excluded: exclude,
    });
    if (error) {
      alert(`Could not ${exclude ? "remove" : "restore"} ${email} ${exclude ? "from" : "to"} ${assignmentWeekLabel}'s rotation: ${error.message}`);
      button.disabled = false;
      return;
    }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  });
  if (ROLE === "admin") await paintRotationSkipQueue(skipRequestsResult.data);
  document.querySelectorAll("[data-save-role]").forEach(button => button.onclick = async () => {
    const row = button.closest("[data-role]"), message = row.querySelector("[data-role-message]");
    const name = row.querySelector("[data-role-name]").value.trim();
    if (!name) { message.textContent = "Enter a role name."; return; }
    button.disabled = true;
    const { error } = await sb.from("leadership_chart_roles").update({ name }).eq("id", row.dataset.role);
    if (error) { message.textContent = `Could not save role: ${error.message}`; button.disabled = false; return; }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  });
  document.getElementById("lh-add-role").onsubmit = async event => {
    event.preventDefault();
    const form = event.target, input = form.elements.name, message = document.getElementById("lh-add-role-message");
    const name = input.value.trim();
    if (!name) { message.textContent = "Enter a role name."; return; }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    const { error } = await sb.rpc("add_leadership_chart_role", { p_name: name });
    if (error) { message.textContent = `Could not add role: ${error.message}`; button.disabled = false; return; }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  };
  document.getElementById("lh-save-role-order").onclick = async event => {
    const button = event.currentTarget, message = document.getElementById("lh-role-order-message");
    const roleRows = [...document.querySelectorAll("[data-role]")];
    const requestedOrder = roleRows.map(row => ({
      id: row.dataset.role,
      order: Number(row.querySelector("[data-role-order]").value),
    }));
    const orderNumbers = requestedOrder.map(role => role.order);
    if (orderNumbers.some(order => !Number.isInteger(order) || order < 1)
        || new Set(orderNumbers).size !== requestedOrder.length) {
      message.textContent = "Use a different whole-number order for each role.";
      return;
    }
    requestedOrder.sort((left, right) => left.order - right.order);
    button.disabled = true;
    const { error } = await sb.rpc("set_leadership_chart_role_order", { p_role_ids: requestedOrder.map(role => role.id) });
    if (error) { message.textContent = `Could not save role order: ${error.message}`; button.disabled = false; return; }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  };

  const settingsForm = document.getElementById("lh-settings"), settingsMessage = document.getElementById("lh-settings-message");
  settingsForm.onsubmit = async event => {
    event.preventDefault();
    const form = event.target.elements, paused = form.rotation_paused.checked;
    const reason = form.rotation_pause_reason.value.trim(), nextMeetingDate = form.next_meeting_date.value;
    if (paused && (!reason || !nextMeetingDate)) {
      settingsMessage.textContent = "When pausing rotation, enter a reason and the next meeting date.";
      return;
    }
    if (paused && nextMeetingDate < dateInEastern()) {
      settingsMessage.textContent = "The next meeting date must be today or a future date.";
      return;
    }
    const { error } = await sb.from("leadership_hub_settings").update({
      visibility: form.visibility.value,
      rotation_weekday: Number(form.rotation_weekday.value),
      rotation_paused: paused,
      rotation_pause_reason: reason || null,
      next_meeting_date: nextMeetingDate || null,
    }).eq("id", 1);
    settingsMessage.textContent = error
      ? `Could not save settings: ${error.message}${/rotation_paused|rotation_pause_reason|next_meeting_date/i.test(error.message) ? " Run update-19-leadership-rotation-pause.sql in Supabase SQL Editor." : ""}`
      : "Settings saved.";
  };
  document.getElementById("lh-points-settings").onsubmit = async event => {
    event.preventDefault();
    const form = event.target.elements, message = document.getElementById("lh-points-message");
    const { error } = await sb.from("leadership_hub_settings").update({
      approval_points: Number(form.approval_points.value),
    }).eq("id", 1);
    message.textContent = error ? `Could not save points: ${error.message}` : "Points setting saved.";
  };
  const bonusPointsForm = document.getElementById("lh-bonus-points");
  if (bonusPointsForm) bonusPointsForm.onsubmit = async event => {
    event.preventDefault();
    const form = event.target.elements, message = document.getElementById("lh-bonus-points-message");
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    const { error } = await sb.rpc("grant_leadership_bonus_points", {
      p_member_email: form.member_email.value,
      p_points: Number(form.points.value),
      p_reason: form.reason.value.trim(),
    });
    if (error) {
      message.textContent = `Could not award points: ${error.message}`;
      button.disabled = false;
      return;
    }
    message.textContent = "Bonus points awarded.";
    event.target.reset();
    button.disabled = false;
  };
  document.getElementById("lh-shuffle-roles").onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    button.disabled = true;
    const { error } = await sb.rpc("shuffle_leadership_member_order");
    if (error) { alert(`Could not shuffle member rotation order: ${error.message}`); button.disabled = false; return; }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  };
  document.querySelectorAll("[data-save-member]").forEach(button => button.onclick = async () => {
    const card = button.closest("[data-member]"), email = card.dataset.member, message = card.querySelector("[data-member-message]");
    button.disabled = true;
    const { error: memberError } = await sb.from("leadership_chart_members").update({
      display_name: card.querySelector("[data-display-name]").value.trim(),
      sort_order: Number(card.querySelector("[data-sort-order]").value),
      in_cycle: card.querySelector("[data-in-cycle]").checked,
    }).eq("email", email);
    if (memberError) { message.textContent = `Could not save member: ${memberError.message}`; button.disabled = false; return; }
    const roleIds = [...card.querySelectorAll("[data-member-role]:checked")].map(input => input.value);
    const { error: rolesError } = await sb.rpc("set_leadership_member_roles", { p_email: email, p_role_ids: roleIds });
    message.textContent = rolesError ? `Member saved, but roles could not be updated: ${rolesError.message}` : "Saved.";
    button.disabled = false;
  });
  document.getElementById("lh-add-prize").onsubmit = async event => {
    event.preventDefault();
    const form = event.target.elements, message = document.getElementById("lh-prize-message");
    const { error } = await sb.from("leadership_prizes").insert({
      name: form.name.value.trim(),
      description: form.description.value.trim(),
      points_cost: Number(form.points_cost.value),
    });
    if (error) { message.textContent = `Could not add prize: ${error.message}`; return; }
    if (cur === "_h") await show();
  };
  const prizeHost = document.getElementById("lh-prize-list");
  prizeHost.innerHTML = prizesResult.data.map(prize => `<div class="leadership-list-row"><span>${esc(prize.name)} · ${prize.points_cost} points${prize.active ? "" : " · unavailable"}</span><button class="auth-btn alt" type="button" data-toggle-prize="${prize.id}">${prize.active ? "Hide prize" : "Restore prize"}</button></div>`).join("")
    || "<p>No prizes have been added.</p>";
  prizeHost.querySelectorAll("[data-toggle-prize]").forEach(button => button.onclick = async () => {
    const prize = prizesResult.data.find(item => item.id === button.dataset.togglePrize);
    const { error } = await sb.from("leadership_prizes").update({ active: !prize.active }).eq("id", prize.id);
    if (error) { alert(`Could not update prize: ${error.message}`); return; }
    if (cur === "_h") await show();
  });
  await paintChatReportQueue(reportsResult.data);
  await paintPrizeClaimQueue(claimsResult.data);
}

async function paintChatReportQueue(reports) {
  const host = document.getElementById("lh-report-queue");
  if (!reports.length) { host.textContent = "No reports are waiting for review."; return; }
  const urls = await sb.storage.from("leadership-reports").createSignedUrls(reports.map(report => report.screenshot_path), 900);
  if (urls.error) { host.innerHTML = `<p class="auth-error">Could not load private screenshots: ${esc(urls.error.message)}</p>`; return; }
  const urlByPath = new Map((urls.data || []).map(file => [file.path, file.signedUrl]));
  host.innerHTML = reports.map(report => `<article class="leadership-review-card">
    <div><b>${esc(report.reporter_email)}</b> chatted with <b>${esc(report.chatted_with)}</b><br><small>${esc(new Date(report.created_at).toLocaleString())}</small></div>
    ${urlByPath.has(report.screenshot_path) ? `<a href="${esc(urlByPath.get(report.screenshot_path))}" target="_blank" rel="noopener noreferrer"><img src="${esc(urlByPath.get(report.screenshot_path))}" alt="Private chat report screenshot"></a>` : "<p>Screenshot link unavailable.</p>"}
    <div><button class="auth-btn" type="button" data-review-report="${report.id}" data-decision="approved">Approve and award points</button>
      <button class="auth-btn alt" type="button" data-review-report="${report.id}" data-decision="rejected">Reject</button></div></article>`).join("");
  host.querySelectorAll("[data-review-report]").forEach(button => button.onclick = async () => {
    button.disabled = true;
    const { error } = await sb.rpc("review_leadership_chat_report", { p_report_id: button.dataset.reviewReport, p_decision: button.dataset.decision });
    if (error) { alert(`Could not review report: ${error.message}`); button.disabled = false; return; }
    if (cur === "_h") await show();
  });
}

async function paintRotationSkipQueue(requests) {
  const host = document.getElementById("lh-rotation-skip-queue");
  if (!host) return;
  if (!requests.length) { host.textContent = "No requests are waiting for review."; return; }
  host.innerHTML = requests.map(request => `<article class="leadership-review-card">
    <div><b>${esc(request.member_email)}</b> requested to skip the rotation for the week of ${esc(request.week_start)}.<br>
      <small>${esc(new Date(request.created_at).toLocaleString())}</small>
      <p>${esc(request.reason)}</p></div>
    <div><button class="auth-btn" type="button" data-review-rotation="${request.id}" data-decision="approved">Approve request</button>
      <button class="auth-btn alt" type="button" data-review-rotation="${request.id}" data-decision="rejected">Reject</button></div></article>`).join("");
  host.querySelectorAll("[data-review-rotation]").forEach(button => button.onclick = async () => {
    button.disabled = true;
    const { error } = await sb.rpc("review_leadership_rotation_skip", {
      p_request_id: button.dataset.reviewRotation,
      p_decision: button.dataset.decision,
    });
    if (error) { alert(`Could not review rotation request: ${error.message}`); button.disabled = false; return; }
    leadershipAssignmentsOpen = true;
    if (cur === "_h") await show();
  });
}

async function paintPrizeClaimQueue(claims) {
  const host = document.getElementById("lh-claim-queue");
  if (!claims.length) { host.textContent = "No prize requests are waiting for approval."; return; }
  host.innerHTML = claims.map(claim => `<div class="leadership-list-row"><span>${esc(claim.user_email)} requested ${esc(claim.prize_name)} · ${claim.points_cost} points</span>
    <span><button class="auth-btn" type="button" data-review-claim="${claim.id}" data-decision="approved">Approve</button>
    <button class="auth-btn alt" type="button" data-review-claim="${claim.id}" data-decision="rejected">Reject</button></span></div>`).join("");
  host.querySelectorAll("[data-review-claim]").forEach(button => button.onclick = async () => {
    button.disabled = true;
    const { error } = await sb.rpc("review_leadership_prize_claim", { p_claim_id: button.dataset.reviewClaim, p_decision: button.dataset.decision });
    if (error) { alert(`Could not review prize request: ${error.message}`); button.disabled = false; return; }
    if (cur === "_h") await show();
  });
}

async function alertsUI(generation = activeViewGeneration) {
  const [{ data: c, error }, roleEmailResult, rolesResult, roleTemplatesResult] = await Promise.all([
    sb.from("notify_config").select("*").eq("id", 1).maybeSingle(),
    sb.from("leadership_role_email_settings").select("*").eq("id", 1).maybeSingle(),
    sb.from("leadership_chart_roles").select("id,name").order("sort_order").order("name"),
    sb.from("leadership_role_email_templates").select("*").order("created_at"),
  ]);
  if (!isCurrentView(generation)) return;
  const roleEmailSettings = roleEmailResult.data;
  const roleEmailError = roleEmailResult.error || rolesResult.error || roleTemplatesResult.error;
  const roleEmailSetupHint = roleTemplatesResult.error
    ? "Run update-18-role-specific-email-templates.sql in Supabase."
    : roleEmailResult.error
      ? "Run update-17-leadership-role-emails.sql in Supabase."
      : rolesResult.error
        ? "Run update-10-student-leadership-hub.sql in Supabase."
        : "";
  const roleTemplatesById = new Map((roleTemplatesResult.data || []).map(template => [template.role_id, template]));
  const defaultSubject = "{{photo_count}} waiting for approval";
  const defaultBody = "{{photo_count}} waiting for approval:\n\n{{photo_list}}\n\nReview them here: {{review_url}}";
  const defaultRoleSubject = "{{role_name}} — your Student Leadership assignment";
  const defaultRoleBody = "Hi {{member_name}},\n\nYou are assigned to {{role_name}} for the week of {{week_start}}.\n\nOur next meeting is on {{meeting_date}}.\n\nThank you for serving!";
  const defaultFollowupSubject = "Reminder: {{role_name}} this week";
  const defaultFollowupBody = "Hi {{member_name}},\n\nThis is a reminder that you are assigned to {{role_name}} for the week of {{week_start}}.\n\nOur next meeting is on {{meeting_date}}.\n\nThank you for serving!";
  const dayOptions = (selected, followRotation = false) => `${followRotation ? `<option value="" ${selected == null ? "selected" : ""}>Follow the role rotation day</option>` : ""}${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, index) => `<option value="${index}" ${selected === index ? "selected" : ""}>${day}</option>`).join("")}`;
  app.innerHTML = tabs() + `<header class="admin-page-intro"><span class="admin-page-kicker">MESSAGING CENTER</span><h1>Email alerts</h1><p>Manage Photo Challenge notifications and the weekly Student Leadership emails from one place.</p><div class="admin-feature-pills"><span>Photo submissions</span><span>Weekly assignments</span><span>Test delivery</span></div></header><form id="al" class="admin-schedule admin-email-card"><details class="photo-email-settings" open>
    <summary><h3>Email alerts for new photos</h3></summary>
    <p><small>When students or visitors submit photos, valid @latterup.org addresses in your selected audience get one email (at most every 5 minutes) saying how many are waiting. Test emails go only to your account. Setup steps are at the top of <b>email-alerts.gs</b>.</small></p>
    ${error ? `<p class="auth-error">${esc(error.message)}${/photo_email_subject|photo_email_body/i.test(error.message) ? " Run update-16-photo-email-templates.sql in Supabase." : " Run update-5b-email-alerts.sql first."}</p>` : ""}
    <label class="chk"><input type="checkbox" name="enabled" ${c?.enabled ? "checked" : ""}> Send email alerts</label>
    <label>Photo Challenge notification recipients
      <select name="photo_alert_audience">
        <option value="all" ${(c?.photo_alert_audience || "all") === "all" ? "selected" : ""}>Admins and Student Leadership</option>
        <option value="leaders" ${c?.photo_alert_audience === "leaders" ? "selected" : ""}>Student Leadership only</option>
        <option value="off" ${c?.photo_alert_audience === "off" ? "selected" : ""}>Turn off Photo Challenge notifications</option>
      </select>
    </label>
    <label>Email subject<input name="photo_email_subject" maxlength="200" value="${esc(c?.photo_email_subject || defaultSubject)}" required></label>
    <label>Email message<textarea name="photo_email_body" rows="8" maxlength="10000" required>${esc(c?.photo_email_body || defaultBody)}</textarea>
      <small>Available placeholders: <code>{{photo_count}}</code> (for example, “2 new photos”), <code>{{count}}</code> (number only), <code>{{photo_list}}</code> (names and themes), and <code>{{review_url}}</code>.</small>
    </label>
    <button class="auth-btn alt" type="button" id="al-template-defaults">Restore default message</button>
    <label>Google Apps Script web app URL<input name="url" value="${esc(c?.webhook_url || "")}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label>Secret phrase <small>Must match the SECRET you set in the script</small><input name="secret" type="password" value="${esc(c?.secret || "")}" autocomplete="off"></label>
    <label>Your site address <small>Used for the link inside the email</small><input name="site" value="${esc(c?.site_url || location.origin)}"></label>
    <div><button class="auth-btn" type="submit">Save</button> <button class="auth-btn alt" type="button" id="al-test">Send a test email</button> <button class="auth-btn alt" type="button" id="al-check">Check delivery status</button></div>
    <small id="al-msg">${c?.last_sent_at ? "Last email requested " + esc(new Date(c.last_sent_at).toLocaleString()) + (c.last_status ? ", Google replied " + c.last_status : "") : ""}</small>
  </details></form>`;
  const roleEmailHost = document.createElement("section");
  roleEmailHost.className = "alert-card";
  roleEmailHost.innerHTML = `<header class="alert-card-head">
      <span class="alert-ico">${LUIcon("bell", 22)}</span>
      <div class="alert-card-title"><h3>Weekly Student Leadership role emails</h3>
        <p>Sent to members assigned a role that rotation week, using the Apps Script connection above. Times are Eastern (EST/EDT, follows daylight saving) and may arrive a few minutes late.</p></div>
    </header>
    ${roleEmailError ? `<p class="auth-error">Role email settings could not be loaded: ${esc(roleEmailError.message)}. ${roleEmailSetupHint}</p>` : ""}
    ${!roleEmailError ? `<form id="role-email-form">
      <div class="alert-section alert-master">
        <label class="switch chk"><input type="checkbox" name="enabled" ${roleEmailSettings?.enabled ? "checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="switch-label">Send weekly role emails</span></label>
      </div>
      <div class="alert-section">
        <h4 class="alert-section-title">${LUIcon("clock", 16)} Schedule</h4>
        <details class="alert-defaults role-email-initial">
          <summary><span class="alert-defaults-title"><strong>Initial email and follow-up schedule</strong><small>Set delivery days and times</small></span></summary>
          <div class="alert-schedule">
            <div class="alert-schedule-col">
              <h5>Initial email</h5>
              <label>Send on<select name="initial_day">${dayOptions(roleEmailSettings?.initial_day ?? null, true)}</select></label>
              <label>Send time (Eastern)<input name="initial_time" type="time" value="${esc((roleEmailSettings?.initial_time || "08:30").slice(0, 5))}" required></label>
            </div>
            <div class="alert-schedule-col">
              <h5>Follow-up email</h5>
              <label class="switch chk"><input type="checkbox" name="followup_enabled" ${roleEmailSettings?.followup_enabled !== false ? "checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="switch-label">Send a follow-up</span></label>
              <label>Send on<select name="followup_day">${dayOptions(roleEmailSettings?.followup_day ?? 2)}</select></label>
              <label>Send time (Eastern)<input name="followup_time" type="time" value="${esc((roleEmailSettings?.followup_time || "08:30").slice(0, 5))}" required></label>
            </div>
          </div>
        </details>
      </div>
      <div class="alert-section">
        <h4 class="alert-section-title">Messages by role</h4>
        <p class="alert-hint">Each role has its own initial and follow-up email. Test buttons send the current text only to your signed-in email and do not change the schedule.</p>
        <div id="role-email-templates" class="alert-roles">${(rolesResult.data || []).map(role => {
        const template = roleTemplatesById.get(role.id) || {};
        return `<details class="alert-role leadership-role-management" data-role-email="${role.id}">
          <summary><span class="alert-role-name">${esc(role.name)}</span><span class="alert-role-count">Edit messages</span></summary>
          <div class="alert-role-cols">
            <div class="alert-role-col">
              <h5>Initial email</h5>
              <label>Email subject<input data-role-initial-subject maxlength="200" value="${esc(template.initial_subject || defaultRoleSubject)}" required></label>
              <label>Email message<textarea data-role-initial-body rows="5" maxlength="10000" required>${esc(template.initial_body || defaultRoleBody)}</textarea></label>
              <button class="auth-btn alt" type="button" data-role-test="initial">Send initial email test to my email</button>
              <small data-role-test-message="initial" role="status"></small>
            </div>
            <div class="alert-role-col">
              <h5>Follow-up email</h5>
              <label>Email subject<input data-role-followup-subject maxlength="200" value="${esc(template.followup_subject || defaultFollowupSubject)}" required></label>
              <label>Email message<textarea data-role-followup-body rows="5" maxlength="10000" required>${esc(template.followup_body || defaultFollowupBody)}</textarea></label>
              <button class="auth-btn alt" type="button" data-role-test="followup">Send follow-up test to my email</button>
              <small data-role-test-message="followup" role="status"></small>
            </div>
          </div>
        </details>`;
      }).join("") || "<p>No chart roles have been added yet.</p>"}</div>
        <p class="alert-hint">Template placeholders (hover over each one for details): <code title="Replaced with the assigned member's display name. Use it as plain text in the subject or message, such as Hi {{member_name}},.">{{member_name}}</code>, <code title="Replaced with the exact name of the assigned Student Leadership chart role. Use it wherever the role and any role-specific instructions or links belong.">{{role_name}}</code>, <code title="Replaced with the rotation week's date, formatted as Month day, year (for example, November 2, 2026). Use it to identify when the assignment applies.">{{week_start}}</code>, and <code title="Replaced with the meeting date from Admin → Student Leadership, formatted as Month day, year. If no meeting date has been set, it says a date to be announced.">{{meeting_date}}</code>. Write the email as plain text: use a short subject, and separate paragraphs with blank lines. Put any link on its own line. Placeholders are replaced when each email is sent; no HTML formatting is needed. Adding a chart role automatically adds it here with default messages.</p>
      </div>
      <footer class="alert-actions">
        <button class="auth-btn" type="submit">Save role email settings</button>
        <small id="role-email-msg" class="alert-status" role="status"></small>
      </footer>
    </form>` : ""}`;
  document.getElementById("app").appendChild(roleEmailHost);
  wire();
  const f = document.getElementById("al").elements, msg = document.getElementById("al-msg");
  const save = async () => {
    const subject = f.photo_email_subject.value.trim(), body = f.photo_email_body.value.trim();
    const placeholders = [...subject.matchAll(/\{\{([^}]+)\}\}/g), ...body.matchAll(/\{\{([^}]+)\}\}/g)]
      .map(match => match[1]);
    const invalidPlaceholder = placeholders.find(name => !["photo_count", "count", "photo_list", "review_url"].includes(name));
    if (!subject || subject.length > 200 || !body || body.length > 10000) {
      msg.textContent = "Enter an email subject (up to 200 characters) and message (up to 10,000 characters).";
      return false;
    }
    if (invalidPlaceholder) {
      msg.textContent = `Unknown placeholder {{${invalidPlaceholder}}}. Use {{photo_count}}, {{count}}, {{photo_list}}, or {{review_url}}.`;
      return false;
    }
    const { data: saved, error } = await sb.from("notify_config").update({
      enabled: f.enabled.checked,
      photo_alert_audience: f.photo_alert_audience.value,
      photo_email_subject: subject,
      photo_email_body: body,
      webhook_url: f.url.value.trim(),
      secret: f.secret.value,
      site_url: f.site.value.trim().replace(/\/$/, ""),
    }).eq("id", 1).select("id").maybeSingle();
    if (error) msg.textContent = `Error: ${error.message}${error.message.includes("photo_alert_audience") ? " Run update-12-leadership-role-overrides-and-photo-alerts.sql in Supabase." : ""}`;
    else if (!saved) msg.textContent = "No email alert settings were saved.";
    return !error && !!saved;
  };
  document.getElementById("al-template-defaults").onclick = () => {
    f.photo_email_subject.value = defaultSubject;
    f.photo_email_body.value = defaultBody;
  };
  const roleEmailForm = document.getElementById("role-email-form");
  if (roleEmailForm) roleEmailForm.querySelectorAll("[data-role-test]").forEach(button => button.onclick = async () => {
    const row = button.closest("[data-role-email]");
    const deliveryType = button.dataset.roleTest;
    const message = row.querySelector(`[data-role-test-message="${deliveryType}"]`);
    const subject = row.querySelector(`[data-role-${deliveryType}-subject]`).value.trim();
    const body = row.querySelector(`[data-role-${deliveryType}-body]`).value.trim();
    const placeholders = [...subject.matchAll(/\{\{([^}]+)\}\}/g), ...body.matchAll(/\{\{([^}]+)\}\}/g)]
      .map(match => match[1]);
    const invalidPlaceholder = placeholders.find(name => !["member_name", "role_name", "week_start", "meeting_date"].includes(name));
    if (!subject || subject.length > 200 || !body || body.length > 10000) {
      message.textContent = "Enter a subject (up to 200 characters) and message (up to 10,000 characters) before sending a test.";
      return;
    }
    if (invalidPlaceholder) {
      message.textContent = `Unknown placeholder {{${invalidPlaceholder}}}. Use {{member_name}}, {{role_name}}, {{week_start}}, or {{meeting_date}}.`;
      return;
    }
    button.disabled = true;
    message.textContent = "Queuing test email to your signed-in address…";
    const { data, error: testError } = await sb.rpc("send_leadership_role_test_email", {
      p_role_id: row.dataset.roleEmail,
      p_delivery_type: deliveryType,
      p_subject: subject,
      p_body: body,
    });
    message.textContent = testError
      ? `Could not send test email: ${testError.message}${testError.message.includes("send_leadership_role_test_email") ? " Run update-20-leadership-role-test-email.sql in Supabase SQL Editor." : ""}`
      : `Test email queued to your signed-in email. Request ID: ${data}.`;
    button.disabled = false;
  });
  if (roleEmailForm) roleEmailForm.onsubmit = async event => {
    event.preventDefault();
    const form = event.target.elements, message = document.getElementById("role-email-msg");
    const roleTemplateRows = [...roleEmailForm.querySelectorAll("[data-role-email]")];
    const roleTemplates = [];
    for (const row of roleTemplateRows) {
      const templates = [
        row.querySelector("[data-role-initial-subject]").value.trim(),
        row.querySelector("[data-role-initial-body]").value.trim(),
        row.querySelector("[data-role-followup-subject]").value.trim(),
        row.querySelector("[data-role-followup-body]").value.trim(),
      ];
      if (templates.some(template => !template)) {
        message.textContent = `Enter all four email fields for ${row.querySelector("summary").textContent}.`;
        return;
      }
      const placeholders = templates.flatMap(template => [...template.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]));
      const invalidPlaceholder = placeholders.find(name => !["member_name", "role_name", "week_start", "meeting_date"].includes(name));
      if (invalidPlaceholder) {
        message.textContent = `Unknown placeholder {{${invalidPlaceholder}}} for ${row.querySelector("summary").textContent}. Use {{member_name}}, {{role_name}}, {{week_start}}, or {{meeting_date}}.`;
        return;
      }
      roleTemplates.push({
        role_id: row.dataset.roleEmail,
        initial_subject: templates[0],
        initial_body: templates[1],
        followup_subject: templates[2],
        followup_body: templates[3],
        updated_at: new Date().toISOString(),
      });
    }
    if (!roleTemplates.length) {
      message.textContent = "Add at least one chart role before saving role email settings.";
      return;
    }
    const button = roleEmailForm.querySelector('[type="submit"]');
    button.disabled = true;
    message.textContent = "Saving…";
    const { error: templateSaveError } = await sb.from("leadership_role_email_templates").upsert(roleTemplates, { onConflict: "role_id" });
    if (templateSaveError) {
      message.textContent = `Could not save role email templates: ${templateSaveError.message}`;
      button.disabled = false;
      return;
    }
    const { data, error: saveError } = await sb.from("leadership_role_email_settings").update({
      enabled: form.enabled.checked,
      initial_day: form.initial_day.value === "" ? null : Number(form.initial_day.value),
      initial_time: form.initial_time.value,
      followup_enabled: form.followup_enabled.checked,
      followup_day: Number(form.followup_day.value),
      followup_time: form.followup_time.value,
      updated_at: new Date().toISOString(),
    }).eq("id", 1).select("id").maybeSingle();
    message.textContent = saveError
      ? `Role templates were saved, but role email settings could not be saved: ${saveError.message}`
      : data ? "Role email settings and templates saved." : "Role templates were saved, but no role email settings were updated.";
    button.disabled = false;
  };
  const checkStatus = async () => {
    const { data, error } = await sb.rpc("check_email_alert_status");
    if (error) {
      msg.textContent = error.message.includes("check_email_alert_status")
        ? "Email delivery diagnostics are not installed. Run update-11-email-alert-diagnostics.sql in Supabase."
        : "Error checking email status: " + error.message;
      return null;
    }
    if (data?.pending) { msg.textContent = data.message; return false; }
    if (data?.status == null) { msg.textContent = data?.message || "No email response is available yet."; return true; }
    let response;
    try { response = JSON.parse(data.body || ""); } catch {}
    if (data.status < 200 || data.status >= 300 || response?.ok !== true) {
      msg.textContent = `Apps Script response (HTTP ${data.status}): ${response?.error || data.body || "No response details"}`;
    } else {
      msg.textContent = `Apps Script accepted the email (HTTP ${data.status}). Check the recipient inboxes and spam folders.`;
    }
    return true;
  };
  document.getElementById("al").onsubmit = async e => { e.preventDefault(); if (await save()) msg.textContent = "Saved"; };
  document.getElementById("al-test").onclick = async () => {
    msg.textContent = "Sending…"; if (!(await save())) return;
    const { data, error } = await sb.rpc("send_test_alert");
    if (error) { msg.textContent = "Error: " + error.message; return; }
    msg.textContent = `${data || "Test email queued."} Waiting for Apps Script response…`;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const complete = await checkStatus();
      if (complete !== false) return;
    }
    msg.textContent = "The email request is still processing. Click Check delivery status in a few seconds.";
  };
  document.getElementById("al-check").onclick = checkStatus;
}
async function homeTabUI(generation = activeViewGeneration) {
  if (!isCurrentView(generation)) return;
  app.innerHTML = tabs() + '<div id="hp-portal"><p class="admin-tab-loading">Loading portal settings…</p></div><div id="hp-home"><p class="admin-tab-loading">Loading home page layout…</p></div><section class="portal-admin-section"><h3>Frequently asked questions</h3><div id="hp-faq"><p class="admin-tab-loading">Loading FAQs…</p></div></section>';
  wire();
  const portalHost = document.getElementById("hp-portal");
  const homeHost = document.getElementById("hp-home");
  const faqHost = document.getElementById("hp-faq");
  await Promise.all([
    portalLayoutUI(portalHost, generation),
    homeLayoutUI(homeHost, generation),
    listUI("faq", faqHost, generation),
  ]);
}

function parseCsvRows(text) {
  const rows = [];
  let fields = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      fields.push(field);
      rows.push(fields);
      fields = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index++;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  if (field.length || fields.length) {
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}

function parseStudentNamesCsv(text) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const header = rows[0]?.slice(0, 3).map(value => value.trim().toLowerCase()) || [];
  const hasHeader = header[0]?.includes("first")
    && header[1]?.includes("last")
    && header[2]?.includes("email");
  const students = [], errors = [], emailLines = new Map();
  for (let index = hasHeader ? 1 : 0; index < rows.length; index++) {
    const [rawFirst = "", rawLast = "", rawEmail = ""] = rows[index];
    const firstName = rawFirst.trim(), lastName = rawLast.trim(), email = rawEmail.trim().toLowerCase();
    if (!firstName && !lastName && !email) continue;
    const line = index + 1;
    if (!firstName || !lastName || !/^[^\s@,]+@[^\s@,]+\.[^\s@,.]+$/.test(email)) {
      errors.push(`Row ${line}: enter a first name, last name, and valid email in columns A, B, and C.`);
      continue;
    }
    if (firstName.length > 100 || lastName.length > 100 || email.length > 320) {
      errors.push(`Row ${line}: names must be at most 100 characters and email at most 320 characters.`);
      continue;
    }
    if (emailLines.has(email)) {
      errors.push(`Rows ${emailLines.get(email)} and ${line}: duplicate email ${email}.`);
      continue;
    }
    emailLines.set(email, line);
    students.push({ first_name: firstName, last_name: lastName, email });
  }
  if (students.length > 5000) errors.push("The CSV exceeds the 5,000 student import limit.");
  return { students, errors };
}

async function studentsUI(notice = "", generation = activeViewGeneration) {
  const [{ data, error }, { data: leaderRows, error: leaderError }] = await Promise.all([
    sb.rpc("list_students"),
    sb.from("leadership_chart_members").select("email,display_name").order("email"),
  ]);
  if (!isCurrentView(generation)) return;
  const students = data ?? [];
  if (!leaderError) {
    const knownEmails = new Set(students.map(student => student.email?.toLowerCase()));
    (leaderRows || []).filter(member => !knownEmails.has(member.email.toLowerCase())).forEach(member => {
      students.push({
        email: member.email,
        full_name: member.display_name || "",
        last_sign_in_at: null,
        must_change_password: false,
        admin_role: false,
        leader_role: true,
        prelogin: true,
      });
    });
  }
  const loadError = error || leaderError;
  let removableCount = students.filter(student => !student.admin_role && !student.leader_role).length;
  app.innerHTML = tabs() + `<h3>Students</h3><p><small>Everyone who has signed in to the portal, plus Student Leadership members added by email before their first sign-in. New accounts are created automatically when they sign in with Google. Removing a student permanently deletes their account; they can create it again by signing in with Google.</small></p>${loadError ? `<p class="auth-error">${esc(loadError.message)}, check update-6-students-list.sql and update-5a-leadership-team.sql.</p>` : ""}
    ${notice ? `<p class="role-note" role="status">${esc(notice)}</p>` : ""}
    ${ROLE === "admin" ? `<div class="student-setup-grid">
      <details class="student-setup-card">
        <summary>Add Student Leadership access before first sign-in</summary>
        <form id="st-add-leader"><label>Email address<input name="email" type="email" placeholder="name@latterup.org" required></label><button class="auth-btn" type="submit">Add Student Leadership member</button><small id="st-add-leader-message"></small></form>
      </details>
      <details class="student-setup-card">
        <summary>Import student names from Google Sheets</summary>
        <form id="st-import-names"><p><small>In Google Sheets, choose File → Download → Comma-separated values (.csv). Keep first name in column A, last name in B, and email in C; a header row is optional. This updates names for matching accounts and saves names for students who sign in later. It does not create accounts or remove students omitted from the sheet.</small></p><label>Student directory CSV<input name="file" type="file" accept=".csv,text/csv" required></label><button class="auth-btn" type="submit">Import names</button><small id="st-import-names-message" role="status"></small></form>
      </details>
    </div>` : ""}
    <div class="student-admin-tools"><h3>Student directory</h3><label>Search students<input id="st-q" type="search" placeholder="Type a name or email"></label></div><p><small id="st-count"></small></p><div id="st-list"></div><div class="student-admin-danger-zone"><h4>Bulk actions</h4><p><small>These actions affect student accounts and cannot be undone.</small></p><button class="auth-btn alt" type="button" id="st-remove-all" ${loadError || removableCount === 0 ? "disabled" : ""}>Remove all students (${removableCount})</button></div>`;
  wire();
  const list = document.getElementById("st-list"), count = document.getElementById("st-count");
  const paint = () => {
    const q = document.getElementById("st-q").value.trim().toLowerCase();
    const rows = students.filter(s => !q || (s.email + " " + (s.full_name || "")).toLowerCase().includes(q));
    count.textContent = q ? `${rows.length} of ${students.length} people` : `${students.length} people`;
    list.innerHTML = rows.map(s => {
      const email = s.email || "";
      const canBeLeader = email.toLowerCase().endsWith("@latterup.org");
      return `<div class="row student-admin-row"><span>${s.full_name ? "<b>" + esc(s.full_name) + "</b> · " : ""}${esc(email)}
        ${s.admin_role ? ' <span class="via-badge">Admin</span>' : ""}${s.prelogin ? ' <span class="sched-badge">Student Leadership · not signed in yet</span>' : ""}${s.must_change_password ? ' <span class="sched-badge">Hasn\'t chosen a password yet</span>' : ""}</span>
        <label class="chk student-leader-toggle" title="${canBeLeader ? "Add or remove Student Leadership access" : "Student Leadership requires an @latterup.org account"}">
          <input type="checkbox" data-leader-toggle="${esc(email)}" ${s.leader_role ? "checked" : ""} ${loadError || !canBeLeader ? "disabled" : ""}> Student Leadership
        </label>
        <span class="student-last-signin"><small>${s.prelogin ? "No portal profile yet" : s.last_sign_in_at ? "Last sign-in " + esc(new Date(s.last_sign_in_at).toLocaleDateString()) : "Never signed in"}</small>
        ${!s.admin_role && !s.leader_role ? `<button class="auth-btn alt" type="button" data-remove-student="${esc(email)}">Remove student</button>` : ""}</span></div>`;
    }).join("") || "<p><small>No matches.</small></p>";
    list.querySelectorAll("[data-leader-toggle]").forEach(input => input.onchange = async () => {
      const email = input.dataset.leaderToggle;
      const isAdding = input.checked;
      input.disabled = true;
      const result = isAdding
        ? await sb.from("leadership").insert({ email: email.toLowerCase() })
        : await sb.from("leadership").delete().eq("email", email.toLowerCase());
      if (result.error) {
        input.checked = !isAdding;
        input.disabled = false;
        alert(`Could not ${isAdding ? "add" : "remove"} ${email} ${isAdding ? "to" : "from"} Student Leadership: ${result.error.message}`);
        return;
      }
      if (cur === "_s") await studentsUI(`${email} ${isAdding ? "added to" : "removed from"} Student Leadership.`);
    });
    list.querySelectorAll("[data-remove-student]").forEach(button => button.onclick = async () => {
      const email = button.dataset.removeStudent;
      if (!confirm(`Permanently delete ${email}'s account? They can sign in with Google again to create a new account.`)) return;
      button.disabled = true;
      const { data: deleted, error: deleteError } = await sb.rpc("remove_student_account", { p_email: email });
      if (deleteError) { alert(`Could not remove ${email}: ${deleteError.message}`); button.disabled = false; return; }
      if (cur === "_s") await studentsUI(`Removed ${deleted?.[0]?.email || email}.`);
    });
    removableCount = students.filter(student => !student.admin_role && !student.leader_role).length;
    const removeAllButton = document.getElementById("st-remove-all");
    removeAllButton.textContent = `Remove all students (${removableCount})`;
    removeAllButton.disabled = !!loadError || removableCount === 0;
  };
  const addLeaderForm = document.getElementById("st-add-leader");
  if (addLeaderForm) addLeaderForm.onsubmit = async event => {
    event.preventDefault();
    const email = event.target.elements.email.value.trim().toLowerCase();
    const message = document.getElementById("st-add-leader-message");
    const button = event.target.querySelector('[type="submit"]');
    if (!email.endsWith("@latterup.org")) {
      message.textContent = "Use an @latterup.org email address.";
      return;
    }
    button.disabled = true;
    const { error: addError } = await sb.from("leadership").insert({ email });
    if (addError) {
      message.textContent = `Could not add ${email}: ${addError.message}`;
      button.disabled = false;
      return;
    }
    if (cur === "_s") await studentsUI(`${email} now has Student Leadership access. They can sign in with Google when ready.`);
  };
  const importNamesForm = document.getElementById("st-import-names");
  if (importNamesForm) importNamesForm.onsubmit = async event => {
    event.preventDefault();
    const form = event.target, file = form.elements.file.files[0];
    const button = form.querySelector('[type="submit"]');
    const message = document.getElementById("st-import-names-message");
    if (!file) { message.textContent = "Choose a CSV exported from Google Sheets."; return; }
    if (file.size > 5 * 1024 * 1024) { message.textContent = "The CSV must be 5 MB or smaller."; return; }
    button.disabled = true;
    message.textContent = "Checking CSV rows…";
    try {
      const { students: importedStudents, errors: csvErrors } = parseStudentNamesCsv(await file.text());
      if (csvErrors.length) {
        message.textContent = csvErrors.slice(0, 8).join(" ") + (csvErrors.length > 8 ? ` And ${csvErrors.length - 8} more issue(s).` : "");
        return;
      }
      if (!importedStudents.length) { message.textContent = "No student rows were found in the CSV."; return; }
      if (!confirm(`Import names for ${importedStudents.length} students? Matching students' current names will be replaced; names for students who sign in later will also be applied.`)) return;
      message.textContent = `Importing ${importedStudents.length} student names…`;
      const { data: importedCount, error: importError } = await sb.rpc("import_student_directory_names", { p_students: importedStudents });
      if (importError) {
        message.textContent = `Could not import student names: ${importError.message}${importError.message.includes("import_student_directory_names") ? " Run update-22-student-directory-names.sql in Supabase SQL Editor." : ""}`;
        return;
      }
      await studentsUI(`Imported names for ${importedCount} students.`);
    } catch (importError) {
      message.textContent = `Could not read the CSV: ${importError.message || importError}`;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
  document.getElementById("st-q").oninput = paint;
  paint();
  document.getElementById("st-remove-all").onclick = async buttonEvent => {
    if (!confirm(`Permanently delete all ${removableCount} student accounts? Admin and Student Leadership accounts are protected.`)) return;
    if (prompt('To confirm permanent deletion of all students, type "DELETE ALL".') !== "DELETE ALL") return;
    const button = buttonEvent.currentTarget;
    button.disabled = true;
    const { data: deleted, error: deleteError } = await sb.rpc("remove_all_student_accounts");
    if (deleteError) { alert(`Could not remove student accounts: ${deleteError.message}`); button.disabled = false; return; }
    if (cur === "_s") await studentsUI(`Removed ${deleted?.length || 0} student account${deleted?.length === 1 ? "" : "s"}.`);
  };
}
boot();
