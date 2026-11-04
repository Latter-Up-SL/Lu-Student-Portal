(() => {
  const sb = window.LUsb || supabase.createClient(LU_CONFIG.url, LU_CONFIG.key);
  const app = document.getElementById("app");
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const showError = (host, message) => {
    host.innerHTML = `<p class="auth-error">${esc(message)}</p>`;
  };
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function rotationWeekIndexForDate(weekday, dateString) {
    const date = Date.parse(`${dateString}T00:00:00Z`);
    const dateWeekday = new Date(date).getUTCDay();
    const daysSinceRotation = (dateWeekday - weekday + 7) % 7;
    const lastRotation = date - daysSinceRotation * 86400000;
    const firstRotation = Date.UTC(2024, 0, 7) + weekday * 86400000;
    if (lastRotation < firstRotation) return 0;
    return Math.floor((lastRotation - firstRotation) / (7 * 86400000));
  }

  function rotationWeekStart(weekday) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const thisWeekday = new Date(todayUtc).getUTCDay();
    const daysSinceRotation = (thisWeekday - weekday + 7) % 7;
    return new Date(todayUtc - daysSinceRotation * 86400000).toISOString().slice(0, 10);
  }

  function rotationWeekStartForDate(weekday, dateString) {
    const date = Date.parse(`${dateString}T00:00:00Z`);
    const daysSinceRotation = (new Date(date).getUTCDay() - weekday + 7) % 7;
    return new Date(date - daysSinceRotation * 86400000).toISOString().slice(0, 10);
  }

  function easternToday() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = name => parts.find(item => item.type === name).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function nextWednesdayAfter(dateString) {
    const date = Date.parse(`${dateString}T00:00:00Z`);
    const daysUntilWednesday = (3 - new Date(date).getUTCDay() + 7) % 7 || 7;
    return new Date(date + daysUntilWednesday * 86400000).toISOString().slice(0, 10);
  }

  function effectiveMeetingDate(dateString) {
    return dateString && dateString === easternToday() ? nextWednesdayAfter(dateString) : dateString;
  }

  function thursdayBefore(dateString) {
    const date = Date.parse(`${dateString}T00:00:00Z`);
    const daysSinceThursday = ((new Date(date).getUTCDay() - 4 + 7) % 7) || 7;
    return new Date(date - daysSinceThursday * 86400000).toISOString().slice(0, 10);
  }

  function currentAssignments(members, roles, weekIndex, excludedEmails, overrides) {
    const assigned = new Set();
    return roles.map((role, roleIndex) => {
      if (overrides.has(role.id) && overrides.get(role.id) === null) {
        return { role: role.name, member: null };
      }
      const pinnedEmail = overrides.get(role.id);
      if (pinnedEmail) {
        const member = members.find(candidate => candidate.email.toLowerCase() === pinnedEmail);
        if (member) {
          assigned.add(member.email.toLowerCase());
          return { role: role.name, member };
        }
      }
      const candidates = members.filter(member =>
        member.in_cycle && !excludedEmails.has(member.email.toLowerCase())
        && member.roles.includes(role.name)
      );
      if (!candidates.length) return { role: role.name, member: null };
      const start = (weekIndex + roleIndex) % candidates.length;
      const rotated = candidates.map((_, index) => candidates[(start + index) % candidates.length]);
      const member = rotated.find(candidate => !assigned.has(candidate.email.toLowerCase())) || candidates[start];
      assigned.add(member.email.toLowerCase());
      return { role: role.name, member };
    });
  }

  function renderPausedChart(host, reason, nextMeetingDate, resumeDate) {
    const dateLabel = dateString => new Date(`${dateString}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    host.innerHTML = `<section class="leadership-section leadership-chart-section" aria-labelledby="weekly-chart-title">
      <div class="leadership-section-heading"><div><h2 id="weekly-chart-title">Weekly assignments</h2></div></div>
      <p>${esc(reason || "Student Leadership role rotation is paused.")}</p>
      ${nextMeetingDate ? `<p><strong>Next meeting:</strong> ${esc(dateLabel(nextMeetingDate))}. Roles will appear Thursday, ${esc(dateLabel(resumeDate))}.</p>` : "<p>An admin will add the next meeting date before roles resume.</p>"}
    </section>`;
  }

  function meetingDateLabel(dateString) {
    if (!dateString) return "Not scheduled";
    return new Date(`${dateString}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function renderChart(host, members, roles, weekday, weekStart, assignmentPeriodLabel, nextMeetingDate, excludedEmails, userEmail, skipRequest, overrides) {
    const assignments = currentAssignments(members, roles, rotationWeekIndexForDate(weekday, weekStart), excludedEmails, overrides);
    const chartTitle = assignmentPeriodLabel === "the next meeting" ? "Assignments for the next meeting" : "Weekly assignments";
    host.innerHTML = `<section class="leadership-section leadership-chart-section" aria-labelledby="weekly-chart-title">
      <div class="leadership-section-heading">
        <div><h2 id="weekly-chart-title">${chartTitle}</h2></div>
        <span class="leadership-rotation-badge">${LUIcon("clock", 17)} Rotates ${weekdayNames[weekday]}</span>
      </div>
      <div class="leadership-chart" aria-label="Weekly Student Leadership roles">
        ${assignments.map(({ role, member }, index) => `<article class="leadership-role-card">
          <span class="leadership-role-number">0${index + 1}</span>
          <div class="leadership-role-copy"><h3>${esc(role)}</h3>
            <p>${member ? esc(member.display_name) : "No one assigned this week"}</p>
            ${member && member.email.toLowerCase() === userEmail && !excludedEmails.has(userEmail)
              ? skipRequest?.status
                ? `<small class="leadership-skip-status">Week-off request ${esc(skipRequest.status)}${skipRequest.status === "rejected" ? ". Contact an admin if you still need help." : "."}</small>`
                : `<button class="auth-btn alt leadership-skip-request" type="button" data-request-week-off>Request ${esc(assignmentPeriodLabel)} off</button>`
              : ""}</div>
        </article>`).join("")}
      </div>
      <p class="leadership-next-meeting"><strong>Next meeting:</strong> ${esc(meetingDateLabel(nextMeetingDate))}</p>
    </section>`;
  }

  async function load() {
    const { data: { session }, error: sessionError } = await sb.auth.getSession();
    if (sessionError) return showError(app, "We couldn't check your sign-in. Please refresh and try again.");
    if (!session) {
      location.replace("login.html?next=leadership.html");
      return;
    }
    const { data: role, error: roleError } = await sb.rpc("my_role");
    if (roleError) return showError(app, "Student Leadership access couldn't be verified. Please try again later.");
    if (!["admin", "leader"].includes(role)) {
      location.replace("index.html");
      return;
    }

    const settingsResult = await sb.from("leadership_hub_settings").select("rotation_weekday,approval_points,visibility,rotation_paused,rotation_pause_reason,next_meeting_date,show_chat_reports,show_prizes").eq("id", 1).single();
    if (settingsResult.error) return showError(app, `The Student Leadership hub could not load: ${settingsResult.error.message}. Ask an admin to run update-10-student-leadership-hub.sql, update-19-leadership-rotation-pause.sql, and update-23-leadership-visibility-and-prize-fulfillment.sql.`);
    const mayViewHub = settingsResult.data.visibility === "leaders_admins"
      || (settingsResult.data.visibility === "admins" && role === "admin");
    if (!mayViewHub) {
      location.replace("index.html");
      return;
    }

    const settings = {
      ...settingsResult.data,
      next_meeting_date: effectiveMeetingDate(settingsResult.data.next_meeting_date),
    };
    const today = easternToday();
    const resumeDate = settings.next_meeting_date ? thursdayBefore(settings.next_meeting_date) : null;
    const rotationPausedNow = settings.rotation_paused && (!resumeDate || today < resumeDate);
    const currentWeekStart = rotationWeekStart(settings.rotation_weekday);
    const meetingWeekStart = settings.next_meeting_date
      ? rotationWeekStartForDate(settings.rotation_weekday, settings.next_meeting_date)
      : currentWeekStart;
    const useMeetingWeek = settings.rotation_paused && resumeDate && today >= resumeDate
      && today <= settings.next_meeting_date && meetingWeekStart > currentWeekStart;
    const weekStart = useMeetingWeek ? meetingWeekStart : currentWeekStart;
    const assignmentPeriodLabel = weekStart === currentWeekStart ? "this week" : "the next meeting";
    const userEmail = (session.user.email || "").toLowerCase();
    const [membersResult, rolesResult, assignmentsResult, exclusionsResult, skipRequestResult, overridesResult] = await Promise.all([
      sb.from("leadership_chart_members").select("email,display_name,in_cycle,sort_order").order("sort_order").order("display_name"),
      sb.from("leadership_chart_roles").select("id,name,sort_order").order("sort_order").order("name"),
      sb.from("leadership_member_roles").select("member_email,role_id"),
      sb.from("leadership_rotation_exclusions").select("member_email").eq("week_start", weekStart),
      sb.from("leadership_rotation_skip_requests").select("status").eq("week_start", weekStart).eq("member_email", userEmail).maybeSingle(),
      sb.from("leadership_role_overrides").select("role_id,member_email,is_unassigned").eq("week_start", weekStart),
    ]);
    const failed = [membersResult, rolesResult, assignmentsResult, exclusionsResult, skipRequestResult, overridesResult].find(result => result.error);
    if (failed) return showError(app, `The Student Leadership hub could not load: ${failed.error.message}. Ask an admin to run update-10-student-leadership-hub.sql, update-12-leadership-role-overrides-and-photo-alerts.sql, and update-25-leadership-empty-roles-and-meeting-date.sql.`);
    const roleNames = new Map(rolesResult.data.map(item => [item.id, item.name]));
    const assignments = new Map();
    assignmentsResult.data.forEach(item => {
      if (!assignments.has(item.member_email)) assignments.set(item.member_email, []);
      const name = roleNames.get(item.role_id);
      if (name) assignments.get(item.member_email).push(name);
    });
    const members = membersResult.data.map(member => ({ ...member, roles: assignments.get(member.email) || [] }));
    const roleOverrides = new Map(overridesResult.data.map(item => [
      item.role_id,
      item.is_unassigned ? null : item.member_email.toLowerCase(),
    ]));

    const reportChatSection = settings.show_chat_reports ? `<section class="leadership-section leadership-report-section" id="report-section">
        <div class="leadership-section-heading"><div><p class="eyebrow">Share a moment of connection</p><h2>Report My Chats</h2></div>
          <span class="leadership-section-icon">${LUIcon("camera", 23)}</span></div>
        <p>These reports help Student Leadership members connect with the student body and help everyone feel included. Share a conversation that helped someone feel welcomed or involved. An admin reviews each screenshot; approved reports earn ${settingsResult.data.approval_points} points.</p>
        <form id="chat-report-form" class="leadership-form">
          <label>Who did you chat with?<input name="chatted_with" maxlength="120" placeholder="Enter their name" required></label>
          <label class="leadership-file-field">Add a screenshot<input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPG, or WebP · Up to 10 MB. Only you and admins can view your screenshot.</small></label>
          <div class="leadership-form-footer"><button class="auth-btn" type="submit">Submit chat report</button><p id="chat-report-message" role="status"></p></div>
        </form></section>` : "";
    const prizesSection = settings.show_prizes ? `<section class="leadership-section leadership-rewards-section" id="points-section">
        <div class="leadership-section-heading"><div><p class="eyebrow">A little thank-you</p><h2>Points and prizes</h2></div>
          <span class="leadership-section-icon leadership-rewards-icon">★</span></div>
        <div id="points-summary">Loading your points…</div>
        <div id="leadership-prizes" class="leadership-prize-grid"></div>
        <div class="leadership-claims"><h3>My prize requests</h3><div id="my-prize-claims"></div></div></section>` : "";
    app.innerHTML = `<div id="weekly-role-chart"></div>${reportChatSection}${prizesSection}`;
    const excludedEmails = new Set(exclusionsResult.data.map(item => item.member_email.toLowerCase()));
    const chartHost = document.getElementById("weekly-role-chart");
    if (rotationPausedNow) {
      renderPausedChart(chartHost, settings.rotation_pause_reason, settings.next_meeting_date, resumeDate);
    } else {
      renderChart(chartHost, members, rolesResult.data, settings.rotation_weekday, weekStart, assignmentPeriodLabel,
        settings.next_meeting_date, excludedEmails, userEmail, skipRequestResult.data, roleOverrides);
    }
    document.querySelectorAll("[data-request-week-off]").forEach(button => button.onclick = async () => {
      const reason = prompt(`Please explain why you need to be removed from ${assignmentPeriodLabel}'s Student Leadership rotation (up to 500 characters).`);
      if (reason === null) return;
      if (!reason.trim() || reason.trim().length > 500) {
        alert("Enter a reason between 1 and 500 characters.");
        return;
      }
      button.disabled = true;
      const { error } = await sb.rpc("request_leadership_rotation_skip", {
        p_week_start: weekStart,
        p_reason: reason.trim(),
      });
      if (error) {
        alert(`Could not submit your request: ${error.message}`);
        button.disabled = false;
        return;
      }
      await load();
    });
    if (settings.show_chat_reports) await wireReports(session.user);
    if (settings.show_prizes) await loadRewards(session.user.id, userEmail);
  }

  async function wireReports(user) {
    const form = document.getElementById("chat-report-form");
    const message = document.getElementById("chat-report-message");
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const file = form.elements.screenshot.files[0];
      const chattedWith = form.elements.chatted_with.value.trim();
      if (!chattedWith || !file) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
        message.textContent = "Choose a PNG, JPG, or WebP screenshot no larger than 10 MB.";
        return;
      }
      button.disabled = true;
      message.textContent = "Uploading your report…";
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const upload = await sb.storage.from("leadership-reports").upload(path, file, { contentType: file.type, upsert: false });
      if (upload.error) {
        button.disabled = false;
        message.textContent = `Screenshot upload failed: ${upload.error.message}`;
        return;
      }
      const insert = await sb.from("leadership_chat_reports").insert({
        reporter_id: user.id,
        chatted_with: chattedWith,
        screenshot_path: path,
      });
      if (insert.error) {
        const cleanup = await sb.storage.from("leadership-reports").remove([path]);
        button.disabled = false;
        message.textContent = `Report could not be saved: ${insert.error.message}${cleanup.error ? ` Screenshot cleanup failed: ${cleanup.error.message}` : ""}`;
        return;
      }
      form.reset();
      button.disabled = false;
      message.textContent = "Report submitted for admin review. You can submit another report now.";
    };
  }

  async function loadRewards(userId, userEmail) {
    const summary = document.getElementById("points-summary");
    const prizeHost = document.getElementById("leadership-prizes");
    const claimsHost = document.getElementById("my-prize-claims");
    const [reports, claims, prizes, bonusResult] = await Promise.all([
      sb.from("leadership_chat_reports").select("points_awarded").eq("reporter_id", userId).eq("status", "approved"),
      sb.from("leadership_prize_claims").select("id,prize_name,points_cost,status,created_at").eq("user_id", userId).order("created_at", { ascending: false }),
      sb.from("leadership_prizes").select("id,name,description,points_cost").eq("active", true).order("created_at"),
      sb.from("leadership_bonus_points").select("points,reason,created_at").eq("member_email", userEmail.toLowerCase()),
    ]);
    const failed = [reports, claims, prizes, bonusResult].find(result => result.error);
    if (failed) {
      summary.innerHTML = `<p class="auth-error">Points and prizes couldn't load: ${esc(failed.error.message)}${failed === bonusResult ? " Run update-14-leadership-bonus-points.sql in Supabase." : ""}</p>`;
      return;
    }
    const chatPoints = reports.data.reduce((total, report) => total + report.points_awarded, 0);
    const bonusPoints = bonusResult.data.reduce((total, entry) => total + entry.points, 0);
    const earned = chatPoints + bonusPoints;
    const reserved = claims.data.filter(claim => ["pending", "approved", "fulfilled"].includes(claim.status)).reduce((total, claim) => total + claim.points_cost, 0);
    summary.innerHTML = `<div class="leadership-points-balance"><span>Available to spend<br><small>${chatPoints} chat points + ${bonusPoints} bonus points</small></span><strong>${earned - reserved} points</strong></div>
      ${bonusResult.data.length ? `<details class="leadership-bonus-history"><summary>Bonus points history</summary>${bonusResult.data.map(entry => `<p><strong>${entry.points} points</strong> · ${esc(entry.reason)} <small>${esc(new Date(entry.created_at).toLocaleDateString())}</small></p>`).join("")}</details>` : ""}`;
    prizeHost.innerHTML = prizes.data.map(prize => `<article class="leadership-prize-card">
      <h3>${esc(prize.name)}</h3><p>${esc(prize.description)}</p><p><strong>${prize.points_cost} points</strong></p>
      <button class="auth-btn" type="button" data-claim="${prize.id}" ${earned - reserved < prize.points_cost ? "disabled" : ""}>Request prize</button></article>`).join("")
      || "<p>No prizes are available right now.</p>";
    prizeHost.querySelectorAll("[data-claim]").forEach(button => button.onclick = async () => {
      button.disabled = true;
      const { error } = await sb.rpc("claim_leadership_prize", { p_prize_id: button.dataset.claim });
      if (error) {
        button.disabled = false;
        summary.insertAdjacentHTML("beforeend", `<p class="auth-error">${esc(error.message)}</p>`);
        return;
      }
      await loadRewards(userId, userEmail);
    });
    claimsHost.innerHTML = claims.data.map(claim => `<div class="leadership-list-row"><span>${esc(claim.prize_name)} · ${claim.points_cost} points</span><span class="sched-badge">${esc(claim.status)}</span></div>`).join("")
      || "<p>You haven't requested a prize yet.</p>";
  }

  load().catch(error => {
    console.error("Student Leadership hub could not load:", error);
    showError(app, "The Student Leadership hub could not load. Please refresh and try again.");
  });
})();
