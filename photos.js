(async () => {
  const PUB = !!window.LU_PUBLIC, C = LU_CONFIG, sb = PUB ? supabase.createClient(C.url, C.key, { auth: { storageKey: "lu-public" } }) : (window.LUsb || supabase.createClient(C.url, C.key)), $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  if (window.LU_LOCAL_PREVIEW) {
    const data = window.LU_PREVIEW_DATA, current = data.currentTheme;
    $("current").innerHTML = `<div class="photo-round-card"><div class="photo-round-copy"><span class="photo-round-badge"><span class="photo-live-dot" aria-hidden="true"></span> Current round · Preview</span><h2>${esc(current.title)}</h2><p class="photo-round-description">${esc(current.description)}</p><div class="photo-deadline"><span><strong>Submit by</strong><br>${new Date(current.endsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span></div><p class="photo-privacy-note">Sample layout only. Photo submissions are disabled in local preview.</p></div><div class="photo-upload-panel"><div class="photo-upload-icon" aria-hidden="true">↑</div><h3>Bring your moment to life</h3><p>Choose photos from your device. JPG and PNG work great.</p><button class="photo-upload-button" type="button" disabled>Uploads disabled in preview</button></div></div>`;
    $("past").innerHTML = data.pastThemes.map(theme => `<button class="theme-card photo-theme-card" data-preview-theme="${theme.id}"><span class="photo-theme-art" aria-hidden="true">${LUIcon("camera", 22)}</span><strong>${esc(theme.title)}</strong><small>${new Date(theme.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${theme.photos.length} photos</small><span class="photo-theme-link">View gallery <span aria-hidden="true">↗</span></span></button>`).join("");
    $("past").querySelectorAll("[data-preview-theme]").forEach(button => button.onclick = () => {
      const theme = data.pastThemes.find(item => item.id === button.dataset.previewTheme);
      const viewer = $("viewer");
      viewer.hidden = false;
      viewer.innerHTML = `<div class="vh"><h3>${esc(theme.title)}</h3><button class="auth-btn alt" id="preview-close">Close</button></div><div class="thumbs local-preview-photo-grid">${theme.photos.map(photo => `<figure><img src="${photo.src}" alt="Sample community photo by ${esc(photo.by)}" loading="lazy"><figcaption>${esc(photo.by)}</figcaption></figure>`).join("")}</div>`;
      $("preview-close").onclick = () => { viewer.hidden = true; };
      viewer.scrollIntoView({ behavior: "smooth" });
    });
    return;
  }
  let { data: { session } } = await sb.auth.getSession();
  let pubMax = 5;
  if (PUB) {
    const { data: cfg, error: cfgErr } = await sb.rpc("public_config"); pubMax = cfg?.max || 5;
    if (cfgErr) { console.error(cfgErr); $("current").innerHTML = '<div class="photo-empty-state"><h2>This page couldn\'t load</h2><p>Please refresh and try again in a moment.</p></div>'; $("past").parentElement.hidden = true; return; }
    if (!cfg?.enabled) { $("current").innerHTML = '<div class="photo-empty-state"><h2>This page isn\'t open right now</h2><p>Please check back later, or ask Student Leadership.</p></div>'; $("past").parentElement.hidden = true; return; }
    if (!session) {
      let anonymous, error;
      try {
        ({ data: anonymous, error } = await sb.auth.signInAnonymously());
      } catch (requestError) {
        error = requestError;
      }
      if (error || !anonymous?.session) {
        const detail = error?.message || "Supabase did not return a visitor session.";
        const normalized = detail.toLowerCase();
        const reason = normalized.includes("captcha")
          ? "Anonymous sign-in is being blocked by CAPTCHA. This page does not currently request a CAPTCHA token; disable CAPTCHA for anonymous sign-ins or add a CAPTCHA flow."
          : normalized.includes("signups not allowed") || normalized.includes("signup is disabled")
            ? "Supabase is blocking all new accounts, including anonymous visitor sessions. Enable project sign-ups as well as Anonymous Sign-Ins in Authentication settings. Keep email confirmations enabled; the database only permits @latterup.org email accounts."
          : normalized.includes("anonymous") && (normalized.includes("disabled") || normalized.includes("not enabled"))
            ? "Anonymous sign-ins are disabled for this Supabase project. Enable Anonymous Sign-Ins in the Supabase Auth settings."
            : "Check the Supabase Auth settings and network connection, then try again.";
        console.error("Anonymous photo session could not be created:", error || detail);
        $("current").innerHTML = `<div class="photo-empty-state"><h2>This page couldn't start a visitor session</h2><p>${esc(reason)}</p><details><summary>Technical details</summary><p>${esc(detail)}</p></details><button class="auth-btn" id="retry-visitor-session" type="button">Try again</button></div>`;
        $("retry-visitor-session").onclick = () => location.reload();
        $("past").parentElement.hidden = true;
        return;
      }
      session = anonymous.session;
    }
  }
  if (!session && !PUB) {
    $("current").innerHTML = '<div class="gate"><p>Sign in with your <strong>@latterup.org</strong> account to join the photo challenge.</p><button class="auth-btn" id="si">Sign in</button></div>';
    $("past").parentElement.hidden = true;
    return $("si").onclick = () => (location.href = "login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() || "index.html"));
  }
  const uid = session?.user?.id ?? null, now = new Date();
  const { data: themeData, error: themeError } = await sb.from("themes").select("*").order("starts_at", { ascending: false });
  if (themeError) {
    console.error("Photo themes could not be loaded:", themeError);
    $("current").innerHTML = '<div class="photo-empty-state"><h2>This page couldn\'t load</h2><p>Please refresh and try again in a moment.</p></div>';
    $("past").parentElement.hidden = true;
    return;
  }
  const themes = themeData ?? [];
  const cur = themes.find(t => new Date(t.starts_at) <= now && now < new Date(t.ends_at));
  const past = themes.filter(t => new Date(t.ends_at) <= now);
  let max = pubMax;
  if (!PUB) {
    const { data, error } = await sb.from("settings").select("max_photos_per_theme").eq("id", 1).single();
    if (error) {
      console.error("Photo settings could not be loaded:", error);
      $("current").innerHTML = '<div class="photo-empty-state"><h2>This page couldn\'t load</h2><p>Please refresh and try again in a moment.</p></div>';
      $("past").parentElement.hidden = true;
      return;
    }
    max = data.max_photos_per_theme;
  }
  const sign = async (bucket, paths) => {
    const m = {};
    if (paths.length) {
      let data;
      try {
        const result = await sb.storage.from(bucket).createSignedUrls(paths, 3600);
        data = result.data;
        if (result.error) console.error("Some photo files could not be signed:", result.error);
      } catch (error) {
        console.error("Photo links could not be requested:", error);
        data = [];
      }
      (data ?? []).forEach(u => {
        if (u.signedUrl) m[u.path] = u.signedUrl;
        else console.error("Photo file could not be signed:", u.path, u.error);
      });
      const signedPaths = new Set((data ?? []).filter(u => u.signedUrl).map(u => u.path));
      paths.filter(path => !signedPaths.has(path)).forEach(path => console.error("Photo file has no signed URL:", path));
    }
    return m;
  };
  const missingPhoto = label => `<div class="photo-missing-file" role="img" aria-label="${esc(label)} unavailable">${esc(label)} unavailable</div>`;
  const shrink = file => new Promise((resolve, reject) => {
    const image = new Image(), objectUrl = URL.createObjectURL(file);
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(objectUrl);
    };
    image.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth * scale;
        canvas.height = image.naturalHeight * scale;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Your browser couldn't prepare this image for upload.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          cleanup();
          if (blob) resolve(blob);
          else reject(new Error("Your browser couldn't encode this image. Try a different JPG or PNG."));
        }, "image/jpeg", .85);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("This image couldn't be read. Try a different JPG or PNG."));
    };
    image.src = objectUrl;
  });

  async function renderCurrent() {
    const box = $("current");
    if (!cur) return box.innerHTML = `<div class="photo-empty-state"><span class="photo-round-badge"><span class="photo-no-round-dot" aria-hidden="true"></span>Between rounds</span><h2>No active challenge just yet</h2><p>Check out past themes below, and come back soon for the next prompt.</p></div>`;
    const { data: mineData, error } = await sb.from("submissions").select("*").eq("theme_id", cur.id).eq("user_id", uid).order("created_at");
    if (error) {
      console.error("Photo submissions could not be loaded:", error);
      box.innerHTML = '<div class="photo-empty-state"><h2>Your submissions couldn\'t load</h2><p>Please refresh and try again.</p></div>';
      return;
    }
    const mine = mineData ?? [];
    const urls = await sign("photos", mine.map(m => m.image_path));
    const label = { approved: "Approved ✓", rejected: "Not approved", pending: "Waiting for review" };
    box.innerHTML = `<div class="photo-round-card"><div class="photo-round-copy"><span class="photo-round-badge"><span class="photo-live-dot" aria-hidden="true"></span> Current round</span><h2>${esc(cur.title)}</h2><p class="photo-round-description">${esc(cur.description || "Share a photo that fits this round's theme.")}</p><div class="photo-deadline"><span aria-hidden="true">${LUIcon("clock", 18)}</span><span><strong>Submit by</strong><br>${new Date(cur.ends_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div><p class="photo-privacy-note">Approved photos will be shared with everyone when the round ends. Your name will appear with your photos.</p></div><div class="photo-upload-panel"><div class="photo-upload-icon" aria-hidden="true">↑</div><h3>Bring your moment to life</h3><p>Choose photos from your device. JPG and PNG work great.</p>${PUB ? '<input id="pname" class="pub-name" maxlength="60" placeholder="Your name (shown with your photos)" autocomplete="name">' : ""}${mine.length < max ? `<label class="photo-upload-button" for="f">Choose photos <span aria-hidden="true">↗</span></label><input class="photo-file-input" type="file" id="f" accept="image/*" multiple><small>${PUB ? `${max - mine.length} of ${max} visitor-session uploads remaining` : `${max - mine.length} of ${max} uploads remaining`}</small>` : `<p class="photo-limit-reached">You've reached the ${max}-photo limit for this round.</p>`}<p id="msg" class="photo-upload-message" role="status"></p></div></div>
      ${mine.length ? `<div class="photo-submissions"><div class="photo-section-heading"><div><h3>Your submissions</h3><p>Manage the photos you've sent for this round.</p></div><span class="photo-count">${mine.length} / ${max}</span></div><div class="thumbs">${mine.map(m => `<figure>${urls[m.image_path] ? `<img src="${urls[m.image_path]}" alt="Your submitted photo">` : missingPhoto("Your submitted photo") }<figcaption><span>${label[m.status]}</span><button class="auth-btn alt" data-del="${m.id}" data-p="${esc(m.image_path)}">Remove</button></figcaption></figure>`).join("")}</div></div>` : ""}`;
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      if (!confirm("Remove this photo?")) return;
      const { data: deleted, error } = await sb.from("submissions").delete().eq("id", b.dataset.del).select("id").maybeSingle();
      if (error || !deleted) { $("msg").textContent = "Couldn't remove the photo: " + (error?.message || "the submission was not deleted"); return; }
      const cleanup = await sb.storage.from("photos").remove([b.dataset.p]);
      if (cleanup.error) { $("msg").textContent = "The photo record was removed, but its file could not be deleted: " + cleanup.error.message; return; }
      renderCurrent();
    });
    const f = $("f"); if (f) f.onchange = async () => {
      const files = [...f.files].slice(0, max - mine.length), msg = $("msg"); let n = 0;
      const nm = PUB
        ? ($("pname")?.value || "").trim()
        : (session.user.app_metadata?.full_name || session.user.email?.split("@")[0] || "").trim();
      if (!nm) { msg.textContent = "Please type your name first."; f.value = ""; return; }
      for (const file of files) {
        msg.textContent = `Uploading ${++n} of ${files.length}…`;
        let path;
        try {
          const blob = await shrink(file); path = `${PUB ? `public/${uid}` : uid}/${cur.id}/${crypto.randomUUID()}.jpg`;
          const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" }); if (up.error) throw up.error;
          const ins = await sb.from("submissions").insert({ theme_id: cur.id, user_id: uid, submitted_by: nm, image_path: path }); if (ins.error) throw ins.error;
        } catch (e) {
          const cleanup = path ? await sb.storage.from("photos").remove([path]) : { error: null };
          msg.textContent = "Couldn't upload " + file.name + ": " + (e.message || "unsupported photo, try JPG or PNG.") + (cleanup.error ? "; uploaded-file cleanup failed: " + cleanup.error.message : "");
          return;
        }
      }
      await renderCurrent(); if (PUB && $("msg")) $("msg").textContent = "Thank you! Your photo is waiting for review ✓";
    };
  }

  const counts = {};
  if (past.length) {
    const { data, error } = await sb.from("submissions").select("theme_id").eq("status", "approved").in("theme_id", past.map(t => t.id));
    if (error) {
      console.error("Photo counts could not be loaded:", error);
      $("past").innerHTML = '<p class="photo-empty-state">Past photo counts could not be loaded. Please refresh and try again.</p>';
      return;
    }
    (data ?? []).forEach(c => counts[c.theme_id] = (counts[c.theme_id] || 0) + 1);
  }
  $("past").innerHTML = past.length ? past.map(t => `<button class="theme-card photo-theme-card" data-t="${t.id}"><span class="photo-theme-art" aria-hidden="true">${LUIcon("camera", 22)}</span><strong>${esc(t.title)}</strong><small>${new Date(t.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${counts[t.id] || 0} photo${(counts[t.id] || 0) === 1 ? "" : "s"}</small><span class="photo-theme-link">View gallery <span aria-hidden="true">↗</span></span></button>`).join("") : `<div class="photo-empty-past"><span aria-hidden="true">${LUIcon("camera", 22)}</span><p>Your gallery is getting ready. Past themes and approved photos will appear here after a round wraps up.</p></div>`;
  $("past").querySelectorAll("[data-t]").forEach(b => b.onclick = () => openTheme(themes.find(t => t.id === b.dataset.t)));

  async function openTheme(t) {
    const v = $("viewer");
    const { data, error } = await sb.from("submissions").select("*").eq("theme_id", t.id).eq("status", "approved").order("created_at");
    if (error) { alert("Could not load gallery photos: " + error.message); return; }
    const ph = data ?? [];
    const urls = await sign("photos", ph.map(p => p.image_path));
    const vid = t.video_path ? (await sign("media", [t.video_path]))[t.video_path] : null;
    let playbackFrame = 0, playbackStartedAt = 0, playbackElapsed = 0, playbackRunning = false, reelImages = null, reelImagesPromise = null, exporting = false;
    const canvas = document.createElement("canvas");
    canvas.id = "reel-canvas";
    canvas.width = 1280;
    canvas.height = 720;
    canvas.setAttribute("aria-label", `Animated photo reel for ${t.title}`);
    const ctx = canvas.getContext("2d", { alpha: false });
    const slideDuration = 3600, totalDuration = ph.length * slideDuration;
    v.hidden = false; v.scrollIntoView({ behavior: "smooth" });
    v.innerHTML = `<div class="vh"><h3>${esc(t.title)}</h3><button class="auth-btn alt" id="vc">Close</button></div>${vid ? `<video controls src="${vid}"></video>` : t.video_path ? missingPhoto("Video") : ""}
      ${ph.length ? `<div class="reel-stage" id="reel-stage"></div><p id="reel-message" role="status" class="reel-message"></p>
      <div class="vh"><button class="auth-btn" id="pl">Play reel</button><button class="auth-btn" id="export-reel">Export MP4</button><button class="auth-btn alt" id="fs">Full screen</button><button class="auth-btn alt" id="mu">Music: on</button></div><small class="reel-export-note">Creates an animated 720p MP4 in your browser. The first export downloads the video encoder (~30 MB); photos stay on this device.</small><h4 class="all-title">All ${ph.length} photo${ph.length === 1 ? "" : "s"} from this theme</h4><div class="thumbs theme-all">${ph.map(x => `<figure>${urls[x.image_path] ? `<img src="${urls[x.image_path]}" alt="">` : missingPhoto(`Photo by ${x.submitted_by}`)}<figcaption>${esc(x.submitted_by)}</figcaption></figure>`).join("")}</div>` : "<p>No approved photos for this theme.</p>"}`;
    if (!ph.length) {
      $("vc").onclick = () => { document.fullscreenElement && document.exitFullscreen(); v.hidden = true; };
      return;
    }
    const stage = $("reel-stage"), message = $("reel-message"), playButton = $("pl"), exportButton = $("export-reel");
    stage.appendChild(canvas);
    stage.setAttribute("aria-label", `${t.title} animated photo reel`);
    const loadImage = index => new Promise((resolve, reject) => {
      const url = urls[ph[index]?.image_path];
      if (!url) return reject(new Error(`Photo ${index + 1} could not be loaded.`));
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Photo ${index + 1} could not be read for the reel. Refresh the gallery and try again.`));
      image.src = url;
    });
    const prepareImages = async () => {
      if (reelImages) return reelImages;
      if (!reelImagesPromise) reelImagesPromise = (async () => {
        const images = [];
        for (let start = 0; start < ph.length; start += 4) {
          const batch = await Promise.all(Array.from({ length: Math.min(4, ph.length - start) }, (_, index) => loadImage(start + index)));
          images.push(...batch);
          message.textContent = `Preparing photos ${images.length} of ${ph.length}…`;
        }
        reelImages = images;
        message.textContent = "";
        return images;
      })().catch(error => {
        reelImagesPromise = null;
        throw error;
      });
      return reelImagesPromise;
    };
    const drawPhoto = (image, progress, alpha = 1, index = 0) => {
      if (!image) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const width = canvas.width, height = canvas.height;
      const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight) * 1.12;
      const bgWidth = image.naturalWidth * cover, bgHeight = image.naturalHeight * cover;
      ctx.filter = "blur(24px) brightness(.42)";
      ctx.drawImage(image, (width - bgWidth) / 2, (height - bgHeight) / 2, bgWidth, bgHeight);
      ctx.filter = "none";
      const fit = Math.min(1100 / image.naturalWidth, 600 / image.naturalHeight) * (1.02 + progress * .035);
      const imageWidth = image.naturalWidth * fit, imageHeight = image.naturalHeight * fit;
      const drift = Math.sin(progress * Math.PI) * 22 * (index % 2 ? -1 : 1);
      ctx.shadowColor = "rgba(0,0,0,.4)";
      ctx.shadowBlur = 28;
      ctx.drawImage(image, (width - imageWidth) / 2 + drift, (height - imageHeight) / 2, imageWidth, imageHeight);
      ctx.restore();
    };
    const drawFrame = elapsed => {
      const index = Math.min(ph.length - 1, Math.floor(elapsed / slideDuration));
      const progress = (elapsed % slideDuration) / slideDuration;
      const fade = index < ph.length - 1 ? Math.max(0, (progress - .72) / .28) : 0;
      ctx.fillStyle = "#07152b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawPhoto(reelImages[index], progress, 1, index);
      if (fade > 0) drawPhoto(reelImages[index + 1], 0, Math.min(1, fade), index + 1);
      const shade = ctx.createLinearGradient(0, 410, 0, 720);
      shade.addColorStop(0, "rgba(0,0,0,0)");
      shade.addColorStop(1, "rgba(0,12,34,.82)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 410, canvas.width, 310);
      ctx.fillStyle = "#e1a730";
      ctx.fillRect(72, 612, 54, 5);
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 24px 'Barlow Condensed', sans-serif";
      ctx.fillText("LATTER UP  ·  PHOTO CHALLENGE", 72, 574);
      ctx.font = "700 43px 'Barlow Semi Condensed', sans-serif";
      const title = elapsed < 3000 ? t.title : `${ph[index].submitted_by}  ·  ${index + 1} / ${ph.length}`;
      ctx.fillText(title.slice(0, 56), 72, 655, 1120);
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.font = "500 18px 'Barlow Condensed', sans-serif";
      ctx.fillText(elapsed < 3000 ? "A collection of moments from our community" : t.title.slice(0, 90), 72, 694, 1120);
      ctx.fillStyle = "#e1a730";
      ctx.fillRect(0, 712, canvas.width * Math.min(1, elapsed / totalDuration), 8);
      return index;
    };
    prepareImages().then(() => drawFrame(0)).catch(error => {
      message.textContent = `Reel could not start: ${error.message || error}`;
    });
    const stopPlayback = reset => {
      if (playbackFrame) cancelAnimationFrame(playbackFrame);
      playbackFrame = 0;
      if (playbackRunning) playbackElapsed = performance.now() - playbackStartedAt;
      playbackRunning = false;
      LUMusic.stop();
      if (reset) playbackElapsed = 0;
      playButton.textContent = playbackElapsed ? "Resume reel" : "Play reel";
    };
    const showReelStage = () => {
      stage.hidden = false;
    };
    const startPlayback = async () => {
      if (playbackRunning) return stopPlayback(false);
      try {
        await prepareImages();
        showReelStage();
        if (playbackElapsed >= totalDuration) playbackElapsed = 0;
        if (LUMusic.enabled) await LUMusic.start();
        playbackStartedAt = performance.now() - playbackElapsed;
        playbackRunning = true;
        playButton.textContent = "Pause reel";
        const animate = now => {
          if (!playbackRunning) return;
          playbackElapsed = now - playbackStartedAt;
          drawFrame(playbackElapsed);
          if (playbackElapsed >= totalDuration) {
            playbackRunning = false;
            playbackFrame = 0;
            playbackElapsed = 0;
            LUMusic.stop();
            playButton.textContent = "Play reel";
            return;
          }
          playbackFrame = requestAnimationFrame(animate);
        };
        playbackFrame = requestAnimationFrame(animate);
      } catch (error) {
        message.textContent = `Reel could not start: ${error.message || error}`;
      }
    };
    const loadFfmpegScript = () => new Promise((resolve, reject) => {
      if (window.FFmpegWASM?.FFmpeg) return resolve();
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js";
      script.onload = () => window.FFmpegWASM?.FFmpeg ? resolve() : reject(new Error("The video encoder did not load correctly."));
      script.onerror = () => reject(new Error("The video encoder could not be downloaded. Check your connection and try again."));
      document.head.appendChild(script);
    });
    const fetchBlobUrl = async (url, type) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download video encoder component (HTTP ${response.status}).`);
      return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
    };
    const transcodeToMp4 = async webm => {
      await loadFfmpegScript();
      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();
      const base = "https://cdn.jsdelivr.net/npm";
      let workerURL, coreURL, wasmURL;
      try {
        const workerBase = `${base}/@ffmpeg/ffmpeg@0.12.10/dist/esm/`;
        const workerResponse = await fetch(`${workerBase}worker.js`);
        if (!workerResponse.ok) throw new Error(`Could not download video encoder worker (HTTP ${workerResponse.status}).`);
        const workerSource = (await workerResponse.text())
          .replaceAll('"./const.js"', JSON.stringify(`${workerBase}const.js`))
          .replaceAll('"./errors.js"', JSON.stringify(`${workerBase}errors.js`));
        workerURL = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        coreURL = await fetchBlobUrl(`${base}/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js`, "text/javascript");
        wasmURL = await fetchBlobUrl(`${base}/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm`, "application/wasm");
        message.textContent = "Loading the MP4 encoder…";
        await ffmpeg.load({ classWorkerURL: workerURL, coreURL, wasmURL });
        message.textContent = "Converting the reel to MP4…";
        await ffmpeg.writeFile("reel.webm", new Uint8Array(await webm.arrayBuffer()));
        const exitCode = await ffmpeg.exec(["-i", "reel.webm", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "reel.mp4"]);
        if (exitCode !== 0) throw new Error(`FFmpeg could not convert the reel (exit code ${exitCode}).`);
        const output = await ffmpeg.readFile("reel.mp4");
        return new Blob([output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)], { type: "video/mp4" });
      } finally {
        ffmpeg.terminate();
        [workerURL, coreURL, wasmURL].filter(Boolean).forEach(URL.revokeObjectURL);
      }
    };
    const exportMp4 = async () => {
      if (exporting) return;
      exporting = true;
      let recordingFrame = 0, captureTracks = [];
      exportButton.disabled = true;
      $("vc").disabled = true;
      message.textContent = "Preparing the reel…";
      stopPlayback(true);
      try {
        await prepareImages();
        showReelStage();
        if (!canvas.captureStream || !window.MediaRecorder) throw new Error("This browser cannot record the reel. Try the latest Chrome or Edge.");
        const audio = await LUMusic.createRecordingDestination();
        LUMusic.setRecordingDestination(audio);
        if (LUMusic.enabled) await LUMusic.start();
        const videoStream = canvas.captureStream(30);
        captureTracks = [...videoStream.getTracks(), ...audio.stream.getTracks()];
        const stream = new MediaStream(captureTracks);
        const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
          .find(type => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6000000 } : undefined);
        const chunks = [];
        const recorded = new Promise((resolve, reject) => {
          recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
          recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
          recorder.onerror = event => reject(event.error || new Error("The browser could not record the reel."));
        });
        recorder.start(1000);
        const start = performance.now();
        await new Promise(resolve => {
          const animate = now => {
            const elapsed = now - start;
            drawFrame(elapsed);
            if (elapsed >= totalDuration) {
              recorder.stop();
              recordingFrame = 0;
              resolve();
            } else recordingFrame = requestAnimationFrame(animate);
          };
          recordingFrame = requestAnimationFrame(animate);
        });
        const webm = await recorded;
        LUMusic.stop();
        message.textContent = "Converting to MP4 in your browser…";
        const mp4 = await transcodeToMp4(webm);
        const objectUrl = URL.createObjectURL(mp4), link = document.createElement("a");
        link.href = objectUrl;
        link.download = `${t.title.normalize("NFKD").replace(/[\\/:*?\"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "photo-challenge"}-reel.mp4`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        message.textContent = "Your MP4 reel is ready and downloading.";
      } catch (error) {
        message.textContent = `MP4 export failed: ${error.message || error}`;
      } finally {
        if (recordingFrame) cancelAnimationFrame(recordingFrame);
        captureTracks.forEach(track => track.stop());
        LUMusic.stop();
        LUMusic.setRecordingDestination(null);
        $("vc").disabled = false;
        exportButton.disabled = false;
        exporting = false;
      }
    };
    const close = () => {
      stopPlayback(true);
      if (reelImages) reelImages.forEach(image => { image.onload = null; image.onerror = null; image.src = ""; });
      document.fullscreenElement && document.exitFullscreen();
      v.hidden = true;
    };
    $("vc").onclick = close;
    $("mu").onclick = async () => {
      LUMusic.enabled = !LUMusic.enabled;
      $("mu").textContent = "Music: " + (LUMusic.enabled ? "on" : "off");
      try {
        if (playbackRunning) {
          if (LUMusic.enabled) await LUMusic.start();
          else LUMusic.stop();
        }
      } catch (error) {
        message.textContent = `Music could not start: ${error.message || error}`;
      }
    };
    playButton.onclick = startPlayback;
    exportButton.onclick = exportMp4;
    $("fs").onclick = () => v.requestFullscreen?.();
    v.onkeydown = event => { if (event.key === "ArrowRight") $("nx").click(); if (event.key === "ArrowLeft") $("pv").click(); };
    v.tabIndex = 0;
    v.focus();
  }
  renderCurrent();
})();
