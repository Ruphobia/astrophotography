(() => {
  "use strict";

  // ---------------- constants ----------------
  const IMAGE_PREVIEW_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
  const UPLOAD_EXT = new Set([
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp",
    ".fits", ".fit", ".fts",
    ".cr2", ".cr3", ".nef", ".arw", ".raf", ".dng", ".orf", ".rw2",
  ]);
  const EDITABLE_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp"]);

  const SLIDER_DEFAULTS = { brightness: 1, contrast: 1, gamma: 1, saturation: 1 };
  const LEVELS_DEFAULT = { black: 0, white: 255, gamma: 1 };
  const SHARPEN_DEFAULT = { radius: 2, amount: 150, threshold: 3 };
  const STREAK_DEFAULT = { angle: 0, vertical_radius: 3, horizontal_radius: 15, threshold: 10 };

  // ---------------- state ----------------
  const state = {
    projects: [],
    view: "empty",              // "empty" | "new" | "detail" | "editor"
    activeProjectId: null,
    detail: null,               // { project, inputs, outputs }
    editor: null,               // see openEditor()
  };

  // ---------------- DOM ----------------
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const dom = {
    content: $("#content"),
    projectList: $("#project-list"),
    projectListEmpty: $("#project-list-empty"),
    newProjectBtn: $("#new-project-btn"),
    toasts: $("#toasts"),
  };

  // ---------------- toasts ----------------
  const toast = (message, kind = "info", ttl = 3200) => {
    const el = document.createElement("div");
    el.className = `toast is-${kind}`;
    el.textContent = message;
    dom.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, ttl);
  };

  // ---------------- utils ----------------
  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  };
  const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");
  const extOf = (name) => {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // ---------------- api ----------------
  const api = {
    async listProjects() {
      const r = await fetch("/api/projects");
      if (!r.ok) throw await asError(r);
      return (await r.json()).projects;
    },
    async createProject(name, description) {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!r.ok) throw await asError(r);
      return (await r.json()).project;
    },
    async getProject(id) {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}`);
      if (!r.ok) throw await asError(r);
      return await r.json();
    },
    async deleteProject(id) {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) throw await asError(r);
      return await r.json();
    },
    uploadImage(projectId, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `/api/projects/${encodeURIComponent(projectId)}/images?name=${encodeURIComponent(file.name)}`;
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText).image); }
            catch { resolve({ name: file.name, size: file.size }); }
          } else {
            let msg = `HTTP ${xhr.status}`;
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.onabort = () => reject(new Error("aborted"));
        xhr.send(file);
      });
    },
    async preview(projectId, source, sourceKind, operations, signal, max = 1400) {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, source_kind: sourceKind, operations, max }),
        signal,
      });
      if (!r.ok) throw await asError(r);
      return await r.blob();
    },
    async saveOutput(projectId, payload) {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/outputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw await asError(r);
      return (await r.json()).output;
    },
    async instructIr(projectId, payload) {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/instructir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw await asError(r);
      const ct = r.headers.get("Content-Type") || "";
      if (ct.startsWith("image/")) return { blob: await r.blob() };
      return await r.json();
    },
  };
  async function asError(response) {
    let msg = `HTTP ${response.status}`;
    try { const j = await response.json(); if (j && j.error) msg = j.error; } catch {}
    return new Error(msg);
  }

  // ---------------- sidebar ----------------
  function renderSidebar() {
    dom.projectList.innerHTML = "";
    if (state.projects.length === 0) {
      dom.projectList.appendChild(dom.projectListEmpty);
      return;
    }
    for (const p of state.projects) {
      const li = document.createElement("li");
      li.className = "project-item";
      li.dataset.id = p.id;
      if (p.id === state.activeProjectId) li.classList.add("is-active");
      li.tabIndex = 0; li.setAttribute("role", "button");
      li.innerHTML = `
        <div class="project-item-main">
          <span class="project-name"></span>
          <span class="project-sub"></span>
        </div>
        <button class="project-delete" type="button" aria-label="Delete project" title="Delete project">×</button>
      `;
      li.querySelector(".project-name").textContent = p.name;
      li.querySelector(".project-sub").textContent = fmtDate(p.created_at);
      li.addEventListener("click", (e) => {
        if (e.target.closest(".project-delete")) return;
        openProject(p.id);
      });
      li.addEventListener("keydown", (e) => {
        if (e.target.closest(".project-delete")) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProject(p.id); }
      });
      li.querySelector(".project-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteProject(p.id);
      });
      dom.projectList.appendChild(li);
    }
  }

  // ---------------- view routing ----------------
  function renderView() {
    dom.content.replaceChildren();
    if (state.view === "empty")   return renderEmpty();
    if (state.view === "new")     return renderNewProject();
    if (state.view === "detail")  return renderDetail();
    if (state.view === "editor")  return renderEditor();
  }

  // ---------------- empty ----------------
  function renderEmpty() {
    const node = $("#tpl-empty-state").content.cloneNode(true);
    node.querySelector('[data-action="new-project"]').addEventListener("click", showNewProject);
    dom.content.appendChild(node);
  }

  // ---------------- new project ----------------
  function renderNewProject() {
    const node = $("#tpl-new-project").content.cloneNode(true);
    const form = node.querySelector('[data-form="new-project"]');
    const nameInput = form.querySelector('input[name="name"]');
    const descInput = form.querySelector('textarea[name="description"]');
    const nameErr = form.querySelector('[data-error-for="name"]');

    form.querySelector('[data-action="cancel-new-project"]').addEventListener("click", () => {
      if (state.activeProjectId) openProject(state.activeProjectId);
      else showEmpty();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const description = descInput.value.trim();
      nameErr.textContent = "";
      if (!name) { nameErr.textContent = "Name is required."; nameInput.focus(); return; }
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = "Creating…";
      try {
        const project = await api.createProject(name, description);
        state.projects.push(project);
        toast(`Created "${project.name}"`, "success");
        await openProject(project.id);
      } catch (err) {
        nameErr.textContent = err.message || "Failed to create project.";
        submitBtn.disabled = false; submitBtn.textContent = "Create project";
      }
    });
    dom.content.appendChild(node);
    setTimeout(() => nameInput.focus(), 0);
  }

  // ---------------- project detail ----------------
  function renderDetail() {
    const { project, inputs, outputs } = state.detail;
    const node = $("#tpl-project-detail").content.cloneNode(true);

    node.querySelector('[data-field="name"]').textContent = project.name;
    const parts = [
      `Created ${fmtDate(project.created_at)}`,
      `${inputs.length} input${inputs.length === 1 ? "" : "s"}`,
      `${outputs.length} output${outputs.length === 1 ? "" : "s"}`,
    ];
    node.querySelector('[data-field="meta"]').textContent = parts.join(" · ");
    const descEl = node.querySelector('[data-field="description"]');
    descEl.textContent = project.description || "No description.";

    // Uploads
    const zone = node.querySelector("[data-dropzone]");
    const fileInput = node.querySelector("[data-file-input]");
    const uploadsSection = node.querySelector("[data-uploads]");
    const uploadList = node.querySelector("[data-upload-list]");
    const pick = () => fileInput.click();
    zone.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="pick-files"]')) return;
      pick();
    });
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    node.querySelector('[data-action="pick-files"]').addEventListener("click", (e) => {
      e.stopPropagation(); pick();
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length) startUploads(project.id, [...fileInput.files], uploadsSection, uploadList);
      fileInput.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("is-drag"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("is-drag"); }));
    zone.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (files.length) startUploads(project.id, files, uploadsSection, uploadList);
    });

    // Inputs
    node.querySelector("[data-input-count]").textContent = inputs.length;
    const inputGrid = node.querySelector("[data-input-grid]");
    if (inputs.length === 0) node.querySelector("[data-empty-inputs]").hidden = false;
    else inputs.forEach((img) => inputGrid.appendChild(inputTile(project.id, img)));

    // Outputs
    node.querySelector("[data-output-count]").textContent = outputs.length;
    const outGrid = node.querySelector("[data-output-grid]");
    if (outputs.length === 0) node.querySelector("[data-empty-outputs]").hidden = false;
    else outputs.forEach((img) => outGrid.appendChild(outputTile(project.id, img)));

    dom.content.appendChild(node);
  }

  function makeTile(url, name, subText) {
    const node = $("#tpl-image-tile").content.cloneNode(true);
    const tile = node.querySelector(".image-tile");
    const thumb = tile.querySelector(".thumb");
    const ext = extOf(name);
    if (url && IMAGE_PREVIEW_EXT.has(ext)) thumb.style.backgroundImage = `url("${url}")`;
    else thumb.textContent = ext.replace(".", "") || "file";
    tile.querySelector(".name").textContent = name;
    tile.querySelector(".sub").textContent = subText;
    return tile;
  }

  function inputTile(projectId, img) {
    const url = `/api/projects/${encodeURIComponent(projectId)}/inputs/${encodeURIComponent(img.name)}`;
    const tile = makeTile(url, img.name, `${fmtBytes(img.size)} · ${fmtDate(img.modified_at)}`);
    const btn = tile.querySelector('[data-action="tile-primary"]');
    btn.textContent = img.editable ? "Edit" : "Not editable";
    if (!img.editable) {
      tile.classList.add("is-uneditable");
      btn.disabled = true; btn.title = "Editing this format isn't supported yet";
    } else {
      btn.addEventListener("click", () => openEditor(projectId, img.name));
    }
    return tile;
  }

  function outputTile(projectId, img) {
    const url = `/api/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(img.name)}`;
    const tile = makeTile(url, img.name, `${fmtBytes(img.size)} · ${fmtDate(img.modified_at)}`);
    const editable = isEditableExt(img.name);
    tile.classList.add("has-actions");
    // Replace the single primary button with two: Edit + Open.
    const actions = tile.querySelector(".tile-actions");
    actions.innerHTML = "";
    const editBtn = document.createElement("button");
    editBtn.type = "button"; editBtn.className = "btn btn-sm";
    editBtn.textContent = editable ? "Edit" : "Not editable";
    if (editable) editBtn.addEventListener("click", () => openEditor(projectId, img.name, "outputs"));
    else { editBtn.disabled = true; editBtn.title = "Editing this format isn't supported yet"; }
    const openBtn = document.createElement("button");
    openBtn.type = "button"; openBtn.className = "btn btn-sm";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => window.open(url, "_blank", "noopener"));
    actions.appendChild(editBtn);
    actions.appendChild(openBtn);
    return tile;
  }

  function isEditableExt(name) {
    return new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp"]).has(extOf(name));
  }

  // ---------------- uploads ----------------
  async function startUploads(projectId, files, uploadsSection, uploadList) {
    uploadsSection.hidden = false;
    const jobs = files.map((f) => enqueueUpload(projectId, f, uploadList));
    const CONCURRENCY = 3;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (cursor < jobs.length) await jobs[cursor++].run();
    });
    await Promise.all(workers);
    await refreshDetail(projectId);
  }
  function enqueueUpload(projectId, file, uploadList) {
    const row = document.createElement("li");
    row.className = "upload-row";
    row.innerHTML = `
      <span class="upload-name"></span>
      <span class="upload-progress"><span class="upload-progress-bar"></span></span>
      <span class="upload-status">…</span>`;
    row.querySelector(".upload-name").textContent = file.name;
    const bar = row.querySelector(".upload-progress-bar");
    const status = row.querySelector(".upload-status");
    uploadList.appendChild(row);
    const ext = extOf(file.name);
    if (ext && !UPLOAD_EXT.has(ext)) {
      row.classList.add("is-err"); bar.style.width = "100%"; status.textContent = "type";
      toast(`Skipped "${file.name}" — unsupported type`, "warn");
      return { run: async () => {} };
    }
    return {
      run: async () => {
        status.textContent = "0%";
        try {
          await api.uploadImage(projectId, file, (frac) => {
            const pct = Math.round(frac * 100);
            bar.style.width = pct + "%"; status.textContent = pct + "%";
          });
          bar.style.width = "100%"; row.classList.add("is-done"); status.textContent = "done";
        } catch (err) {
          row.classList.add("is-err"); bar.style.width = "100%"; status.textContent = "failed";
          row.title = err.message || "upload failed";
          toast(`"${file.name}" failed: ${err.message || "upload failed"}`, "error");
        }
      },
    };
  }

  async function refreshDetail(projectId) {
    if (state.activeProjectId !== projectId) return;
    try {
      state.detail = await api.getProject(projectId);
      if (state.view === "detail") renderView();
    } catch (err) {
      toast(err.message || "Failed to refresh project", "error");
    }
  }

  // ==========================================================================
  // Editor
  // ==========================================================================

  function openEditor(projectId, sourceName, sourceKind = "inputs") {
    // If we already have a chat WebSocket for this project, keep it open.
    const existingChat = state.editor && state.editor.projectId === projectId ? state.editor.chat : null;
    state.view = "editor";
    state.editor = {
      projectId, sourceName, sourceKind,
      ops: [],
      redo: [],
      // staged (multi-slider) op values
      levels: { ...LEVELS_DEFAULT },
      sharpen: { ...SHARPEN_DEFAULT },
      streak: { ...STREAK_DEFAULT },
      // preview
      previewUrl: null,
      previewLoading: false,
      previewAbort: null,
      previewSeq: 0,
      // compare
      compareOn: false,
      originalUrl: null,
      originalLoading: false,
      // save panel
      saveOpen: false,
      saving: false,
      // chat drawer
      chat: existingChat || { open: false, mode: "claude", ws: null, term: null, fit: null, status: "idle" },
    };
    renderView();
    requestPreview();
    ensureOriginal();
  }

  function closeEditor() {
    if (state.editor) {
      if (state.editor.previewUrl) URL.revokeObjectURL(state.editor.previewUrl);
      if (state.editor.originalUrl) URL.revokeObjectURL(state.editor.originalUrl);
      closeChat(true);
    }
    state.editor = null;
    state.view = "detail";
    renderView();
  }

  function renderEditor() {
    const ed = state.editor;
    if (!ed) return;

    const node = $("#tpl-editor").content.cloneNode(true);
    node.querySelector('[data-field="name"]').textContent = ed.sourceName;
    node.querySelector('[data-field="sub"]').textContent = "Non-destructive editing — the original is never modified.";

    // header buttons
    node.querySelector('[data-action="editor-back"]').addEventListener("click", closeEditor);
    node.querySelector('[data-action="editor-reset"]').addEventListener("click", editorReset);
    const undoBtn = node.querySelector('[data-action="editor-undo"]');
    const redoBtn = node.querySelector('[data-action="editor-redo"]');
    undoBtn.addEventListener("click", editorUndo);
    redoBtn.addEventListener("click", editorRedo);
    undoBtn.disabled = ed.ops.length === 0;
    redoBtn.disabled = ed.redo.length === 0;
    node.querySelector('[data-action="editor-save"]').addEventListener("click", openSavePanel);

    const compareBtn = node.querySelector('[data-action="editor-compare"]');
    compareBtn.dataset.toggle = ed.compareOn ? "on" : "off";
    compareBtn.addEventListener("click", toggleCompare);
    const chatBtn = node.querySelector('[data-action="editor-chat"]');
    chatBtn.dataset.toggle = ed.chat.open ? "on" : "off";
    chatBtn.addEventListener("click", toggleChat);

    // Body 3-column when chat is open
    const body = node.querySelector("[data-editor-body]");
    body.classList.toggle("chat-open", ed.chat.open);

    // Compare view
    const previewWrap = node.querySelector("[data-preview-wrap]");
    const compareBox = node.querySelector("[data-compare]");
    const singleImg = node.querySelector("[data-preview]");
    if (ed.compareOn) {
      compareBox.hidden = false;
      singleImg.hidden = true;
      const origImg = node.querySelector("[data-compare-orig]");
      const editImg = node.querySelector("[data-compare-edit]");
      if (ed.originalUrl) origImg.src = ed.originalUrl;
      if (ed.previewUrl) editImg.src = ed.previewUrl;
    } else {
      compareBox.hidden = true;
      singleImg.hidden = false;
    }

    // one-shot op buttons
    $$('[data-op]', node).forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.op;
        let args = {};
        if (btn.dataset.args) { try { args = JSON.parse(btn.dataset.args); } catch {} }
        pushOp({ op: kind, ...args });
      });
    });

    // slider adjustments (auto-coalesced)
    $$('[data-slider]', node).forEach((slider) => {
      const kind = slider.dataset.slider;
      // if last op is this kind, reflect its value
      const tail = ed.ops[ed.ops.length - 1];
      if (tail && tail.op === kind && typeof tail.value === "number") slider.value = String(tail.value);
      updateSliderVal(slider);
      slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        updateSliderVal(slider);
        setAdjustment(kind, v);
      });
    });

    // levels — staged
    const levelsSliders = $$('[data-levels]', node);
    levelsSliders.forEach((slider) => {
      const which = slider.dataset.levels;
      slider.value = String(ed.levels[which]);
      updateSliderVal(slider);
      slider.addEventListener("input", () => {
        const v = which === "gamma" ? parseFloat(slider.value) : parseInt(slider.value, 10);
        ed.levels[which] = v;
        updateSliderVal(slider);
        schedulePreview(); // preview reflects staged levels
      });
    });
    node.querySelector('[data-action="commit-levels"]').addEventListener("click", () => {
      const lv = ed.levels;
      if (lv.black === LEVELS_DEFAULT.black && lv.white === LEVELS_DEFAULT.white && lv.gamma === LEVELS_DEFAULT.gamma) {
        toast("Levels are at defaults — nothing to apply.", "warn"); return;
      }
      pushOp({ op: "levels", black: lv.black, white: lv.white, gamma: lv.gamma });
      ed.levels = { ...LEVELS_DEFAULT };
      renderView();
    });

    // sharpen — staged
    $$('[data-sharpen]', node).forEach((slider) => {
      const which = slider.dataset.sharpen;
      slider.value = String(ed.sharpen[which]);
      updateSliderVal(slider);
      slider.addEventListener("input", () => {
        const v = which === "radius" ? parseFloat(slider.value) : parseInt(slider.value, 10);
        ed.sharpen[which] = v;
        updateSliderVal(slider);
        schedulePreview();
      });
    });
    node.querySelector('[data-action="commit-sharpen"]').addEventListener("click", () => {
      const s = ed.sharpen;
      pushOp({ op: "sharpen", radius: s.radius, amount: s.amount, threshold: s.threshold });
      ed.sharpen = { ...SHARPEN_DEFAULT };
      renderView();
    });

    // streak removal — staged
    $$('[data-streak]', node).forEach((slider) => {
      const which = slider.dataset.streak;
      slider.value = String(ed.streak[which]);
      updateSliderVal(slider);
      slider.addEventListener("input", () => {
        const v = which === "angle" ? parseInt(slider.value, 10) : parseInt(slider.value, 10);
        ed.streak[which] = v;
        updateSliderVal(slider);
        schedulePreview();
      });
    });
    node.querySelector('[data-action="commit-streak"]').addEventListener("click", () => {
      pushOp({ op: "remove_streak", ...ed.streak });
      ed.streak = { ...STREAK_DEFAULT };
      renderView();
    });
    node.querySelector('[data-action="autofind-streak"]').addEventListener("click", autoFindStreakAngle);

    // history
    const hist = node.querySelector("[data-history]");
    node.querySelector("[data-history-count]").textContent = ed.ops.length;
    if (ed.ops.length === 0) node.querySelector("[data-history-empty]").hidden = false;
    else {
      node.querySelector("[data-history-empty]").hidden = true;
      ed.ops.forEach((op, i) => {
        const li = document.createElement("li");
        li.textContent = describeOp(op);
        if (i === ed.ops.length - 1) li.classList.add("is-latest");
        hist.appendChild(li);
      });
    }

    // preview image
    const previewImg = node.querySelector("[data-preview]");
    const spinner = node.querySelector("[data-spinner]");
    if (ed.previewUrl) previewImg.src = ed.previewUrl;
    else previewImg.removeAttribute("src");
    if (ed.previewLoading) { previewImg.classList.add("is-loading"); spinner.hidden = false; }
    else { previewImg.classList.remove("is-loading"); spinner.hidden = true; }

    // save panel
    const savePanel = node.querySelector("[data-save-panel]");
    savePanel.hidden = !ed.saveOpen;
    if (ed.saveOpen) wireSavePanel(savePanel);

    // chat drawer
    const drawer = node.querySelector("[data-chat-drawer]");
    if (ed.chat.open) {
      drawer.hidden = false;
      wireChatDrawer(drawer);
    } else {
      drawer.hidden = true;
    }

    dom.content.appendChild(node);
  }

  function updateSliderVal(slider) {
    let key;
    let suffix = "";
    if (slider.dataset.slider) key = slider.dataset.slider;
    else if (slider.dataset.levels) key = "lv-" + slider.dataset.levels;
    else if (slider.dataset.sharpen) key = "sh-" + slider.dataset.sharpen;
    else if (slider.dataset.streak) {
      const short = { angle: "angle", vertical_radius: "vr", horizontal_radius: "hr", threshold: "thr" };
      key = "rs-" + short[slider.dataset.streak];
      if (slider.dataset.streak === "angle") suffix = "°";
    }
    if (!key) return;
    const val = slider.parentElement.querySelector(`[data-val="${key}"]`);
    if (!val) return;
    const step = parseFloat(slider.step || "1");
    const num = parseFloat(slider.value);
    const rendered = (step < 1) ? num.toFixed(2) : String(Math.round(num));
    val.textContent = rendered + suffix;
  }

  function describeOp(op) {
    switch (op.op) {
      case "auto_enhance": return "Auto enhance";
      case "auto_stretch": return "Auto stretch";
      case "levels":       return `Levels  b:${op.black}  w:${op.white}  γ:${(+op.gamma).toFixed(2)}`;
      case "brightness":   return `Brightness  ×${(+op.value).toFixed(2)}`;
      case "contrast":     return `Contrast  ×${(+op.value).toFixed(2)}`;
      case "gamma":        return `Gamma  ${(+op.value).toFixed(2)}`;
      case "saturation":   return `Saturation  ×${(+op.value).toFixed(2)}`;
      case "sharpen":      return `Sharpen  r:${(+op.radius).toFixed(1)}  a:${op.amount}  t:${op.threshold}`;
      case "denoise":      return `Denoise (median ${op.size})`;
      case "blur":         return `Blur  r:${(+op.radius).toFixed(1)}`;
      case "rotate":       return `Rotate ${op.degrees}°`;
      case "flip_h":       return "Flip horizontal";
      case "flip_v":       return "Flip vertical";
      case "grayscale":    return "Grayscale";
      case "invert":       return "Invert";
      case "remove_streak":return `Remove streak  ${op.angle}°  w:±${op.vertical_radius}  L:±${op.horizontal_radius}  s:${op.threshold}`;
      default:             return op.op;
    }
  }

  // Push a discrete op (used by one-shot buttons and staged commits).
  function pushOp(op) {
    const ed = state.editor;
    ed.ops.push(op);
    ed.redo = [];
    renderView();
    requestPreview();
  }

  // Coalescing slider adjustment: replaces trailing op of same kind, or pushes.
  function setAdjustment(kind, value) {
    const ed = state.editor;
    const tail = ed.ops[ed.ops.length - 1];
    const def = SLIDER_DEFAULTS[kind];
    ed.redo = [];
    if (tail && tail.op === kind) {
      if (value === def) ed.ops.pop();
      else tail.value = value;
    } else if (value !== def) {
      ed.ops.push({ op: kind, value });
    }
    // Update history + button states without a full re-render on every tick.
    updateHistoryUi();
    schedulePreview();
  }

  function updateHistoryUi() {
    const ed = state.editor;
    const list = $("[data-history]"); if (!list) return;
    list.innerHTML = "";
    ed.ops.forEach((op, i) => {
      const li = document.createElement("li");
      li.textContent = describeOp(op);
      if (i === ed.ops.length - 1) li.classList.add("is-latest");
      list.appendChild(li);
    });
    const count = $("[data-history-count]"); if (count) count.textContent = ed.ops.length;
    const empty = $("[data-history-empty]"); if (empty) empty.hidden = ed.ops.length !== 0;
    const undoBtn = $('[data-action="editor-undo"]'); if (undoBtn) undoBtn.disabled = ed.ops.length === 0;
    const redoBtn = $('[data-action="editor-redo"]'); if (redoBtn) redoBtn.disabled = ed.redo.length === 0;
  }

  function editorUndo() {
    const ed = state.editor;
    if (ed.ops.length === 0) return;
    ed.redo.push(ed.ops.pop());
    renderView();
    requestPreview();
  }
  function editorRedo() {
    const ed = state.editor;
    if (ed.redo.length === 0) return;
    ed.ops.push(ed.redo.pop());
    renderView();
    requestPreview();
  }
  function editorReset() {
    const ed = state.editor;
    const stagedDirty =
      ed.levels.black !== LEVELS_DEFAULT.black || ed.levels.white !== LEVELS_DEFAULT.white || ed.levels.gamma !== LEVELS_DEFAULT.gamma ||
      ed.sharpen.radius !== SHARPEN_DEFAULT.radius || ed.sharpen.amount !== SHARPEN_DEFAULT.amount || ed.sharpen.threshold !== SHARPEN_DEFAULT.threshold ||
      ed.streak.angle !== STREAK_DEFAULT.angle || ed.streak.vertical_radius !== STREAK_DEFAULT.vertical_radius ||
      ed.streak.horizontal_radius !== STREAK_DEFAULT.horizontal_radius || ed.streak.threshold !== STREAK_DEFAULT.threshold;
    if (ed.ops.length === 0 && !stagedDirty) return;
    ed.redo = ed.ops.slice().reverse().concat(ed.redo); // preserve redo-ability
    ed.ops = [];
    ed.levels = { ...LEVELS_DEFAULT };
    ed.sharpen = { ...SHARPEN_DEFAULT };
    ed.streak = { ...STREAK_DEFAULT };
    renderView();
    requestPreview();
  }

  // Try common streak orientations and pick the one that removes the most bright
  // linear content (indirect measure: preview render size is a rough proxy for
  // how much the pipeline actually changed the image — a real streak removal
  // reduces high-frequency detail and encodes to a smaller JPEG).
  async function autoFindStreakAngle() {
    const ed = state.editor; if (!ed) return;
    const status = () => toast("Trying angles 0°, 45°, 90°, 135°…", "info", 2000);
    status();
    const angles = [0, 45, 90, 135];
    let best = null;
    for (const angle of angles) {
      const trial = { ...STREAK_DEFAULT, angle, threshold: 8 };
      try {
        const blob = await api.preview(ed.projectId, ed.sourceName, ed.sourceKind,
          [...ed.ops, { op: "remove_streak", ...trial }], null, 640);
        const score = blob.size;
        if (best === null || score < best.score) best = { angle, score };
      } catch {}
    }
    if (best === null) { toast("Couldn't probe angles", "error"); return; }
    ed.streak = { ...STREAK_DEFAULT, angle: best.angle, threshold: 8 };
    toast(`Best angle: ${best.angle}° — tune sensitivity, then Apply.`, "success");
    renderView();
    requestPreview();
  }

  // ---------------- preview requests ----------------
  let previewTimer = null;
  function schedulePreview(delay = 140) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewTimer = null; requestPreview(); }, delay);
  }

  function currentPreviewOps() {
    const ed = state.editor;
    const ops = ed.ops.slice();
    // Append staged levels if any deviate from defaults.
    const lv = ed.levels;
    if (lv.black !== LEVELS_DEFAULT.black || lv.white !== LEVELS_DEFAULT.white || lv.gamma !== LEVELS_DEFAULT.gamma) {
      ops.push({ op: "levels", black: lv.black, white: lv.white, gamma: lv.gamma });
    }
    // Append staged sharpen only if user actively edited it (amount > 0 with non-default settings)
    const s = ed.sharpen;
    if (s.amount !== SHARPEN_DEFAULT.amount || s.radius !== SHARPEN_DEFAULT.radius || s.threshold !== SHARPEN_DEFAULT.threshold) {
      if (s.amount > 0) ops.push({ op: "sharpen", radius: s.radius, amount: s.amount, threshold: s.threshold });
    }
    // Append staged streak removal if any slider deviates
    const rs = ed.streak;
    if (rs.angle !== STREAK_DEFAULT.angle
        || rs.vertical_radius !== STREAK_DEFAULT.vertical_radius
        || rs.horizontal_radius !== STREAK_DEFAULT.horizontal_radius
        || rs.threshold !== STREAK_DEFAULT.threshold) {
      ops.push({ op: "remove_streak", ...rs });
    }
    return ops;
  }

  async function requestPreview() {
    const ed = state.editor; if (!ed) return;
    if (ed.previewAbort) { try { ed.previewAbort.abort(); } catch {} }
    const controller = new AbortController();
    ed.previewAbort = controller;
    const seq = ++ed.previewSeq;
    setPreviewLoading(true);
    try {
      const blob = await api.preview(ed.projectId, ed.sourceName, ed.sourceKind, currentPreviewOps(), controller.signal);
      if (seq !== ed.previewSeq) return; // superseded
      const url = URL.createObjectURL(blob);
      if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
      ed.previewUrl = url;
      setPreviewImage(url);
    } catch (err) {
      if (err.name === "AbortError") return;
      toast(err.message || "Preview failed", "error");
    } finally {
      if (seq === ed.previewSeq) setPreviewLoading(false);
    }
  }
  function setPreviewImage(url) {
    const img = $("[data-preview]"); if (img) img.src = url;
    const editImg = $("[data-compare-edit]"); if (editImg) editImg.src = url;
  }

  async function ensureOriginal() {
    const ed = state.editor; if (!ed || ed.originalUrl || ed.originalLoading) return;
    ed.originalLoading = true;
    try {
      const blob = await api.preview(ed.projectId, ed.sourceName, ed.sourceKind, [], null, 1400);
      const url = URL.createObjectURL(blob);
      if (state.editor !== ed) { URL.revokeObjectURL(url); return; }
      ed.originalUrl = url;
      const orig = $("[data-compare-orig]"); if (orig) orig.src = url;
    } catch {
      // toast on failure only if user actually toggled compare; else silent.
    } finally {
      ed.originalLoading = false;
    }
  }

  function toggleCompare() {
    const ed = state.editor; if (!ed) return;
    ed.compareOn = !ed.compareOn;
    if (ed.compareOn && !ed.originalUrl) ensureOriginal();
    renderView();
  }
  function setPreviewLoading(on) {
    const ed = state.editor; if (!ed) return;
    ed.previewLoading = on;
    const img = $("[data-preview]"); const sp = $("[data-spinner]");
    if (img) img.classList.toggle("is-loading", on);
    if (sp) sp.hidden = !on;
  }

  // ---------------- save panel ----------------
  function openSavePanel() {
    const ed = state.editor;
    ed.saveOpen = true;
    renderView();
  }
  function closeSavePanel() {
    const ed = state.editor;
    ed.saveOpen = false;
    renderView();
  }
  function wireSavePanel(panel) {
    const ed = state.editor;
    const nameInput = panel.querySelector("[data-save-name]");
    const formatSel = panel.querySelector("[data-save-format]");
    const qualityWrap = panel.querySelector("[data-jpg-quality]");
    const qualitySlider = panel.querySelector("[data-save-quality]");
    const qualityVal = panel.querySelector("[data-save-quality-val]");

    const stem = ed.sourceName.replace(/\.[^.]+$/, "");
    nameInput.value = `${stem}-edited`;
    formatSel.value = "jpg";
    qualitySlider.value = 92; qualityVal.textContent = "92";

    const syncQualityVisibility = () => { qualityWrap.hidden = formatSel.value !== "jpg"; };
    syncQualityVisibility();
    formatSel.addEventListener("change", syncQualityVisibility);
    qualitySlider.addEventListener("input", () => { qualityVal.textContent = qualitySlider.value; });

    panel.querySelector('[data-action="cancel-save"]').addEventListener("click", closeSavePanel);
    panel.querySelector('[data-action="confirm-save"]').addEventListener("click", async () => {
      if (ed.saving) return;
      const name = nameInput.value.trim();
      if (!name) { toast("Please enter a filename.", "warn"); nameInput.focus(); return; }
      ed.saving = true;
      const confirmBtn = panel.querySelector('[data-action="confirm-save"]');
      confirmBtn.disabled = true; confirmBtn.textContent = "Saving…";
      try {
        const payload = {
          source: ed.sourceName,
          source_kind: ed.sourceKind,
          operations: currentPreviewOps(),
          output_name: name,
          format: formatSel.value,
        };
        if (formatSel.value === "jpg") payload.quality = parseInt(qualitySlider.value, 10);
        const output = await api.saveOutput(ed.projectId, payload);
        toast(`Saved "${output.name}"`, "success");
        ed.saveOpen = false; ed.saving = false;
        // Refresh detail in the background and go back to project view.
        await refreshDetail(ed.projectId);
        closeEditor();
      } catch (err) {
        toast(err.message || "Save failed", "error");
        ed.saving = false;
        confirmBtn.disabled = false; confirmBtn.textContent = "Save";
      }
    });

    setTimeout(() => nameInput.focus(), 0);
  }

  // ---------------- chat drawer (Claude terminal + InstructIR) ----------------
  function toggleChat() {
    const ed = state.editor; if (!ed) return;
    ed.chat.open = !ed.chat.open;
    renderView();
    if (ed.chat.open && ed.chat.mode === "claude") connectChatWebSocket();
  }
  function closeChat(keepAlive = false) {
    const ed = state.editor; if (!ed) return;
    const c = ed.chat;
    if (!keepAlive) c.open = false;
    if (c.ws) {
      try { c.ws.close(); } catch {}
      c.ws = null;
    }
    if (c.term) {
      try { c.term.dispose(); } catch {}
      c.term = null;
    }
    c.fit = null;
    c.status = "idle";
    if (!keepAlive) renderView();
  }

  function switchChatMode(mode) {
    const ed = state.editor; if (!ed) return;
    ed.chat.mode = mode;
    // Reflect mode in the drawer without a full re-render (avoid tearing down the terminal).
    $$('.chat-mode-btn', $("[data-chat-drawer]")).forEach((b) => {
      b.classList.toggle("is-active", b.dataset.chatMode === mode);
    });
    $$(".chat-pane", $("[data-chat-drawer]")).forEach((p) => {
      p.hidden = p.dataset.chatPane !== mode;
    });
    if (mode === "claude") {
      connectChatWebSocket();
      // Give the terminal a moment to relayout after unhiding.
      setTimeout(() => { if (ed.chat.fit) try { ed.chat.fit.fit(); } catch {} }, 30);
    }
  }

  function wireChatDrawer(drawer) {
    const ed = state.editor;
    drawer.querySelector('[data-action="chat-close"]').addEventListener("click", () => toggleChat());
    drawer.querySelector('[data-action="chat-restart"]').addEventListener("click", () => {
      if (!ed.chat.ws || ed.chat.ws.readyState !== WebSocket.OPEN) return;
      ed.chat.ws.send(JSON.stringify({ type: "restart" }));
    });
    drawer.querySelector('[data-action="chat-clear"]').addEventListener("click", () => {
      if (!ed.chat.ws || ed.chat.ws.readyState !== WebSocket.OPEN) return;
      ed.chat.ws.send(JSON.stringify({ type: "clear" }));
    });
    $$('.chat-mode-btn', drawer).forEach((b) => {
      b.classList.toggle("is-active", b.dataset.chatMode === ed.chat.mode);
      b.addEventListener("click", () => switchChatMode(b.dataset.chatMode));
    });
    $$(".chat-pane", drawer).forEach((p) => p.hidden = p.dataset.chatPane !== ed.chat.mode);

    if (ed.chat.mode === "claude") connectChatWebSocket();
    wireInstructIrPanel(drawer.querySelector('[data-chat-pane="instructir"]'));
  }

  function setChatStatus(text, kind = "") {
    const ed = state.editor; if (!ed) return;
    ed.chat.status = text;
    const el = $("[data-chat-status]"); if (!el) return;
    el.textContent = text;
    el.classList.remove("is-connected", "is-error");
    if (kind === "connected") el.classList.add("is-connected");
    if (kind === "error")     el.classList.add("is-error");
  }

  function connectChatWebSocket() {
    const ed = state.editor; if (!ed) return;
    const c = ed.chat;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) {
      // Already connected — just make sure the terminal is mounted.
      mountTerminalIfNeeded();
      return;
    }
    if (typeof Terminal === "undefined") {
      setChatStatus("xterm.js not loaded", "error");
      return;
    }
    mountTerminalIfNeeded();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/chat/${encodeURIComponent(ed.projectId)}?source=${encodeURIComponent(ed.sourceName)}`;
    setChatStatus("connecting…");
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { setChatStatus("connect failed", "error"); return; }
    c.ws = ws;

    ws.onopen = () => {
      setChatStatus("connected", "connected");
      // Send initial size to tmux
      if (c.term && c.fit) {
        try { c.fit.fit(); } catch {}
        ws.send(JSON.stringify({ type: "resize", cols: c.term.cols, rows: c.term.rows }));
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "data" && msg.b64 && c.term) {
        // Decode base64 → binary string → Uint8Array; xterm.write accepts Uint8Array.
        const bin = atob(msg.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        c.term.write(arr);
      } else if (msg.type === "error") {
        setChatStatus(msg.message || "error", "error");
      } else if (msg.type === "hello") {
        setChatStatus(msg.fresh ? "starting Claude…" : "connected", "connected");
      }
    };
    ws.onerror = () => setChatStatus("connection error", "error");
    ws.onclose = () => {
      setChatStatus("disconnected");
      c.ws = null;
    };

    // Wire terminal input → WS
    if (c.term && !c._wired) {
      c._wired = true;
      c.term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
      });
      c.term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
    }
  }

  function mountTerminalIfNeeded() {
    const ed = state.editor; const c = ed.chat;
    const host = $("[data-chat-term]");
    if (!host) return;
    if (c.term && host.querySelector(".xterm")) return;
    const theme = {
      background: "#05070b", foreground: "#e6e8ee",
      cursor: "#7aa2ff", cursorAccent: "#0b0d12",
      selectionBackground: "#2a3a66",
      black: "#12151d", red: "#ff6b6b", green: "#4ade80", yellow: "#fbbf24",
      blue: "#7aa2ff", magenta: "#c084fc", cyan: "#22d3ee", white: "#e6e8ee",
      brightBlack: "#5f677a", brightRed: "#ff8a8a", brightGreen: "#86efac",
      brightYellow: "#fde68a", brightBlue: "#a5c0ff", brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9", brightWhite: "#ffffff",
    };
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      convertEol: false,
      cursorBlink: true,
      theme,
      allowProposedApi: true,
    });
    const fit = (typeof FitAddon !== "undefined") ? new FitAddon.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    term.open(host);
    if (fit) try { fit.fit(); } catch {}
    c.term = term; c.fit = fit;

    // Re-fit on window resize.
    if (!c._resizeBound) {
      c._resizeBound = () => { if (c.fit) try { c.fit.fit(); } catch {} };
      window.addEventListener("resize", c._resizeBound);
    }
  }

  // ---------------- InstructIR panel ----------------
  function wireInstructIrPanel(pane) {
    if (!pane || pane.dataset.wired === "1") return;
    pane.dataset.wired = "1";
    const ed = state.editor;
    const promptEl = pane.querySelector("[data-instructir-prompt]");
    const statusEl = pane.querySelector("[data-instructir-status]");
    const setStatus = (msg, kind = "") => {
      statusEl.textContent = msg;
      statusEl.classList.remove("is-error", "is-success", "is-busy");
      if (kind) statusEl.classList.add(`is-${kind}`);
    };
    pane.querySelector('[data-action="instructir-preview"]').addEventListener("click", async () => {
      const instruction = (promptEl.value || "").trim();
      if (!instruction) { setStatus("Enter an instruction first.", "error"); return; }
      setStatus("Running InstructIR (preview)…", "busy");
      try {
        const out = await api.instructIr(ed.projectId, {
          source: ed.sourceName, source_kind: ed.sourceKind,
          instruction, mode: "preview",
        });
        if (!out.blob) throw new Error("no preview returned");
        const url = URL.createObjectURL(out.blob);
        if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
        ed.previewUrl = url;
        setPreviewImage(url);
        setStatus("Preview ready.", "success");
      } catch (err) {
        setStatus(err.message || "InstructIR failed", "error");
      }
    });
    pane.querySelector('[data-action="instructir-save"]').addEventListener("click", async () => {
      const instruction = (promptEl.value || "").trim();
      if (!instruction) { setStatus("Enter an instruction first.", "error"); return; }
      setStatus("Running InstructIR (save)…", "busy");
      try {
        const out = await api.instructIr(ed.projectId, {
          source: ed.sourceName, source_kind: ed.sourceKind,
          instruction, mode: "save",
        });
        setStatus(`Saved "${out.output && out.output.name}"`, "success");
        toast(`InstructIR saved "${out.output && out.output.name}"`, "success");
        await refreshDetail(ed.projectId);
      } catch (err) {
        setStatus(err.message || "InstructIR failed", "error");
      }
    });
  }

  // ---------------- navigation ----------------
  function showEmpty() {
    state.view = "empty"; state.activeProjectId = null; state.detail = null; state.editor = null;
    renderSidebar(); renderView();
  }

  async function deleteProject(id) {
    const p = state.projects.find((x) => x.id === id);
    const name = p ? p.name : "project";
    try {
      await api.deleteProject(id);
    } catch (err) {
      toast(`Delete failed: ${err.message || err}`, "error");
      return;
    }
    state.projects = state.projects.filter((x) => x.id !== id);
    if (state.activeProjectId === id) {
      state.activeProjectId = null; state.detail = null; state.editor = null;
      state.view = state.projects.length ? "empty" : "empty";
    }
    toast(`Deleted "${name}"`, "success");
    renderSidebar(); renderView();
  }
  function showNewProject() {
    state.view = "new";
    renderSidebar(); renderView();
  }
  async function openProject(id) {
    state.activeProjectId = id;
    if (state.editor && state.editor.projectId !== id) state.editor = null;
    state.view = "detail";
    renderSidebar();
    try {
      state.detail = await api.getProject(id);
      renderView();
    } catch (err) {
      toast(err.message || "Failed to load project", "error");
    }
  }

  // ---------------- bootstrap ----------------
  async function init() {
    dom.newProjectBtn.addEventListener("click", showNewProject);
    document.addEventListener("keydown", onGlobalKeydown);
    try { state.projects = await api.listProjects(); }
    catch (err) { toast("Could not load projects: " + (err.message || err), "error"); state.projects = []; }
    renderSidebar();
    renderView();
  }

  function onGlobalKeydown(e) {
    if (state.view !== "editor") return;
    // Ignore if typing in an input
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); editorUndo(); }
    else if ((e.metaKey || e.ctrlKey) && (e.shiftKey && e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) { e.preventDefault(); editorRedo(); }
    else if (e.key === "Escape" && state.editor && state.editor.saveOpen) { e.preventDefault(); closeSavePanel(); }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
