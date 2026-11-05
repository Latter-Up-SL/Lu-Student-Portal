// Shared banner for every page (except admin): brand mark, menu, theme toggle, profile menu.
(async () => {
  const C = window.LU_CONFIG; window.LUsb = window.LUsb || supabase.createClient(C.url, C.key);
  const sb = window.LUsb, host = document.getElementById("site-header"); if (!host) return;
  const page = location.pathname.split("/").pop() || "index.html";
  const links = [["Home", "index.html"], ["Announcements", "announcements.html"], ["Videos", "videos.html"], ["Your Schedule", "schedule.html"], ["Photo Challenge", "photos.html"]];
  const mark = '<svg viewBox="0 0 64 64" role="img" aria-label="Latter UP home"><defs><linearGradient id="luNavy" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#263B70"/><stop offset="1" stop-color="#111A44"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="18" fill="url(#luNavy)"/><circle cx="45" cy="17" r="5" fill="#FFC83D"/><path d="M13 42 25 21l9 15 6-9 12 19H13Z" fill="#F6F8FF" opacity=".96"/><path d="M13 46h39" stroke="#FFC83D" stroke-width="4" stroke-linecap="round"/><path d="m25 21 4 7-4 2-4-2Z" fill="#FFC83D"/></svg>';
  const el = document.createElement("header"); el.className = "site-header";
  el.innerHTML = `<div class="wrap header-inner"><a class="brand" href="index.html">${mark}</a>
    <nav class="site-nav" id="nav" aria-label="Primary">${links.map(([t, h]) => `<a href="${h}" ${h === page ? 'aria-current="page"' : ""}>${t}</a>`).join("")}</nav>
    <div class="hdr-right"><div class="menu-wrap" id="pf"></div>
    <button class="icon-btn burger" id="bg" aria-label="Menu" aria-expanded="false">${LUIcon("menu", 22)}</button></div></div>`;
  host.replaceWith(el);
  const $ = id => document.getElementById(id), root = document.documentElement;
  document.querySelectorAll(".calendar-combo").forEach(card => {
    const openCalendar = () => window.open(card.dataset.calendarUrl, "_blank", "noopener");
    card.addEventListener("click", event => { if (!event.target.closest(".calendar-secondary")) openCalendar(); });
    card.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest(".calendar-secondary")) { event.preventDefault(); openCalendar(); } });
  });
  const paint = () => {
    const th = $("th");
    if (th) th.innerHTML = th.classList.contains("theme-standalone") ? (root.dataset.theme === "dark" ? LUIcon("sun", 20) : LUIcon("moon", 20)) : (root.dataset.theme === "dark" ? LUIcon("sun", 18) + " Switch to light mode" : LUIcon("moon", 18) + " Switch to dark mode");
  };
  const toggleTheme = () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("lu-theme", root.dataset.theme);
    paint();
  };
  const toggleLocalPreview = () => {
    try {
      if (window.LU_LOCAL_PREVIEW) localStorage.removeItem("lu-local-preview");
      else localStorage.setItem("lu-local-preview", "enabled");
      location.reload();
    } catch (error) {
      console.error("Could not update local preview mode.", error);
    }
  };
  const wireProfileMenu = () => {
    $("pb").onclick = event => { event.stopPropagation(); $("pm").classList.toggle("open"); };
    $("th").onclick = event => { event.stopPropagation(); toggleTheme(); };
    const previewToggle = $("preview-toggle");
    if (previewToggle) previewToggle.onclick = toggleLocalPreview;
    document.addEventListener("click", () => $("pm").classList.remove("open"));
  };
  $("bg").onclick = () => { const o = $("nav").classList.toggle("open"); $("bg").setAttribute("aria-expanded", o); };
  if (window.LU_LOCAL_PREVIEW) {
    $("pf").innerHTML = '<button class="icon-btn avatar" id="pb" aria-label="Local preview profile menu" aria-haspopup="true">P</button><div class="menu" id="pm"><div class="who"><b>Local preview</b><br>Admin interface · sample data only</div><a href="admin.html">Admin preview</a><button id="preview-toggle" type="button">Exit local preview</button><button id="th" class="theme-menu-toggle" type="button"></button></div>';
    paint(); wireProfileMenu();
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  const user = session?.user;
  const hasGoogleIdentity = user?.app_metadata?.provider === "google"
    || (Array.isArray(user?.app_metadata?.providers) && user.app_metadata.providers.includes("google"))
    || user?.identities?.some(identity => identity.provider === "google");
  if (!hasGoogleIdentity
      && String(user?.app_metadata?.must_change_password).toLowerCase() === "true"
      && !["change-password.html", "login.html"].includes(page.toLowerCase())) {
    location.replace("change-password.html?next=" + encodeURIComponent(page));
    return;
  }
  if (!session) {
    const previewOption = window.LU_LOCAL_HOST ? '<button id="preview-toggle" type="button">Use local preview</button>' : "";
    $("pf").innerHTML = `<button class="icon-btn avatar" id="pb" aria-label="Profile menu" aria-haspopup="true">?</button><div class="menu" id="pm"><div class="who"><b>Not signed in</b></div><a href="#" id="si">Sign in</a>${previewOption}<button id="th" class="theme-menu-toggle" type="button"></button></div>`;
    $("si").onclick = () => (location.href = "login.html?next=" + encodeURIComponent(page));
    paint(); wireProfileMenu();
  }
  else {
    const u = session.user, name = u.app_metadata?.full_name || u.email, adm = await (async () => { const r = await sb.rpc("my_role"); return r.data || ((await sb.rpc("is_admin")).data ? "admin" : "student"); })();
    if (adm === "admin" || adm === "leader") {
      const { data: canViewLeadershipHub, error: leadershipHubError } = await sb.rpc("can_view_leadership_hub");
      if (leadershipHubError) console.error("Student Leadership tab access could not be checked:", leadershipHubError);
      if (canViewLeadershipHub) {
        const link = document.createElement("a");
        link.href = "leadership.html";
        link.textContent = "Student Leadership";
        if (page === "leadership.html") link.setAttribute("aria-current", "page");
        $("nav").appendChild(link);
      }
    }
    const previewOption = window.LU_LOCAL_HOST ? '<button id="preview-toggle" type="button">Use local preview</button>' : "";
    $("pf").innerHTML = `<button class="icon-btn avatar" id="pb" aria-label="Profile menu" aria-haspopup="true">${name[0].toUpperCase()}</button>
      <div class="menu" id="pm"><div class="who"><b>${name.replace(/[<>&]/g, "")}</b><br>${u.email}</div><a href="change-password.html">Change password</a><a href="photos.html">My photos</a>${adm !== "student" ? '<a href="admin.html">' + (adm === "admin" ? "Admin" : "Student Leadership tools") + '</a>' : ""}<a href="https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=studentleadership%40latterup.org" target="_blank" rel="noopener noreferrer">Contact Student Leadership</a>${previewOption}<button id="th" class="theme-menu-toggle" type="button"></button><button id="so">Sign out</button></div>`;
    paint(); wireProfileMenu();
    $("so").onclick = async () => { await sb.auth.signOut(); location.href = "index.html"; };
  }
})();
