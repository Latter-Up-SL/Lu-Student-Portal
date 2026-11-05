(() => {
  if (!window.LU_LOCAL_PREVIEW || !window.LU_PREVIEW_DATA) {
    document.getElementById("app").textContent = "Admin preview is only available when Local Preview is enabled on localhost.";
    return;
  }

  const app = document.getElementById("app");
  const data = window.LU_PREVIEW_DATA;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const sections = [
    ["announcements", "Announcements"],
    ["videos", "Videos"],
    ["themes", "Photo challenge"],
    ["home", "Home page"],
    ["students", "Students"],
    ["admins", "Admins"],
    ["leadership", "Student Leadership"],
    ["alerts", "Email alerts"],
  ];
  let selected = "announcements";

  function renderRows(items, titleKey, detailKey) {
    return `<div class="local-admin-rows">${items.map(item => `<article class="local-admin-row"><div><h3>${escapeHtml(item[titleKey])}</h3><p>${escapeHtml(item[detailKey] || "Sample preview content")}</p></div><div class="local-admin-actions"><button type="button" disabled>Edit</button><button type="button" disabled>Delete</button></div></article>`).join("")}</div>`;
  }

  function panelContent() {
    if (selected === "announcements") return renderRows(data.announcements, "title", "text");
    if (selected === "videos") return renderRows(data.videos, "title", "description");
    if (selected === "themes") return renderRows([data.currentTheme, ...data.pastThemes], "title", "description");
    if (selected === "home") return `<div class="local-admin-section"><h3>Home page sections</h3><p>Reorder and show or hide sections in the live home page editor.</p>${["Tools", "Announcements", "Videos", "Your Schedule embed", "Questions", "Photo Challenge"].map((item, index) => `<label><input type="checkbox" checked disabled> ${item} <span>Section ${index + 1}</span></label>`).join("")}</div>`;
    if (selected === "students") return renderRows([{ title: "Sample Student", email: "student@example.org" }, { title: "Sample Family", email: "family@example.org" }], "title", "email");
    if (selected === "admins") return renderRows([{ title: "Sample Administrator", email: "admin@example.org" }], "title", "email");
    if (selected === "leadership") return renderRows([{ title: "Sample Student Leader", email: "leader@example.org" }], "title", "email");
    return `<div class="local-admin-section"><h3>Email alerts</h3><p>New announcement and photo-submission alerts would be configured here.</p><label><input type="checkbox" checked disabled> Email alerts enabled (sample)</label></div>`;
  }

  function render() {
    app.innerHTML = `<div class="local-admin-preview">
      <div class="local-admin-heading"><div><p class="eyebrow">Local preview · Admin</p><h1>Portal administration</h1><p>Sample admin interface for reviewing the layout. It is not connected to Supabase.</p></div><a class="auth-btn alt" href="index.html">Back to portal</a></div>
      <p class="local-admin-warning" role="status">Read-only demo: changes, uploads, and account actions are disabled and will not be saved.</p>
      <nav class="local-admin-tabs" aria-label="Admin sections">${sections.map(([id, label]) => `<button type="button" data-admin-tab="${id}" class="auth-btn alt${selected === id ? " on" : ""}" ${selected === id ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>
      <div class="local-admin-panel"><div class="local-admin-panel-heading"><h2>${sections.find(([id]) => id === selected)[1]}</h2><button type="button" class="auth-btn" disabled>+ Add new</button></div>${panelContent()}</div>
      <p class="local-admin-footnote">Local preview has visual admin access only. Real admin permissions are always checked by Supabase.</p>
    </div>`;
    app.querySelectorAll("[data-admin-tab]").forEach(button => {
      button.onclick = () => { selected = button.dataset.adminTab; render(); };
    });
  }

  render();
})();
