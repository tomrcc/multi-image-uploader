// Custom multi-image uploader for the CloudCannon Visual Editor.
//
// CloudCannon's stock image input adds one file at a time. This module gives an
// editor two ways to add *many* images at once, both driving the Visual Editor
// JavaScript API directly:
//
//   const api = window.CloudCannonAPI.useVersion("v1", true)
//   const url = await api.uploadFile(file, inputConfig)
//   await api.currentFile().data.addArrayItem({ slug, item })
//
//   1. An inline <multi-image-uploader> dropzone rendered inside each Gallery
//      block (contextual, on-canvas).
//   2. A floating "Add images" button (fixed, always visible) — the same
//      always-on-top pattern rcc-v2 uses so the control can't be hidden by
//      page layout or CloudCannon overlays.
//
// Loaded only inside the editor (see Layout.astro). Verbose `[MIU]` logging is
// intentional for this PoC.

type CloudCannonFile = {
  data: {
    addArrayItem(opts: { slug: string; item?: unknown }): Promise<unknown>;
  };
  // May be sync or async depending on API version — always `await` it.
  getInputConfig?(opts: { slug: string }): unknown | Promise<unknown>;
};

type CloudCannonApi = {
  currentFile(): CloudCannonFile;
  uploadFile(file: File, inputConfig?: unknown): Promise<string>;
};

declare global {
  interface Window {
    inEditorMode?: boolean;
    CloudCannonAPI?: {
      useVersion(version: string, live?: boolean): CloudCannonApi;
    };
  }
}

const log = (...args: unknown[]) => console.log("[MIU]", ...args);
const warn = (...args: unknown[]) => console.warn("[MIU]", ...args);

log(
  `module evaluating — inEditorMode=${window.inEditorMode}, CloudCannonAPI present=${!!window.CloudCannonAPI}`,
);

function getApi(): Promise<CloudCannonApi> {
  const resolveApi = () => {
    const api = window.CloudCannonAPI!.useVersion("v1", true);
    log("CloudCannon API acquired via useVersion('v1', true)");
    return api;
  };
  if (window.CloudCannonAPI) return Promise.resolve(resolveApi());
  log("CloudCannonAPI not present yet — waiting for cloudcannon:load");
  return new Promise((resolve) => {
    document.addEventListener("cloudcannon:load", () => resolve(resolveApi()), {
      once: true,
    });
  });
}

// One shared API handle for the whole module.
const apiPromise = getApi();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Given a Gallery's images-array element (`[data-editable="array"]
// [data-prop="images"]`), resolve its absolute data path, e.g.
// `content_blocks.2.images`. Read from the live DOM so it stays correct across
// re-renders and content_blocks reordering.
function resolveSlugFor(imagesArray: Element): string | null {
  const blockItem = imagesArray.closest('[data-editable="array-item"]');
  if (!blockItem) {
    log('resolveSlugFor — no array-item ancestor; using "images"');
    return "images";
  }
  const contentArray = blockItem.closest('[data-editable="array"]');
  const prop = contentArray?.getAttribute("data-prop");
  if (!contentArray || !prop) {
    warn("resolveSlugFor — array-item has no enclosing array/data-prop");
    return null;
  }
  const items = Array.from(
    contentArray.querySelectorAll(':scope > [data-editable="array-item"]'),
  );
  const index = items.indexOf(blockItem);
  if (index < 0) {
    warn("resolveSlugFor — could not find item index in its array");
    return null;
  }
  const slug = `${prop}.${index}.images`;
  log(`resolveSlugFor — ${slug}`);
  return slug;
}

async function uploadAll(
  slug: string,
  fileList: FileList | File[],
  onStatus: (text: string) => void,
): Promise<void> {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  log(`uploadAll — ${files.length} image file(s) → ${slug}`);
  if (!files.length) return;

  const api = await apiPromise;
  const file = api.currentFile();

  // getInputConfig may return a Promise — it MUST be awaited to a plain object
  // before being handed to uploadFile(), which postMessages it to the parent
  // window (a pending Promise → DataCloneError, and the upload never runs).
  let inputConfig: unknown;
  try {
    inputConfig = await file.getInputConfig?.({ slug: `${slug}.0.image_path` });
    log("getInputConfig (resolved) →", inputConfig);
  } catch (e) {
    warn("getInputConfig threw (continuing without it):", e);
  }

  let done = 0;
  onStatus(`Uploading 0/${files.length}…`);
  for (const f of files) {
    try {
      log(`uploadFile → ${f.name} (${f.type}, ${f.size} bytes)`);
      const url = await api.uploadFile(f, inputConfig);
      log(`uploadFile ← ${f.name} => ${url}`);
      await file.data.addArrayItem({
        slug,
        item: { image_path: url, alt_text: "" },
      });
      log(`addArrayItem ✓ ${slug} += ${url}`);
      done++;
    } catch (err) {
      console.error("[MIU] upload/append FAILED:", f.name, err);
    }
    onStatus(`Uploading ${done}/${files.length}…`);
  }
  log(`uploadAll complete — ${done}/${files.length}`);
  onStatus(
    done === files.length
      ? `Added ${done} image${done === 1 ? "" : "s"}.`
      : `Added ${done} of ${files.length} (see console).`,
  );
}

function pickFiles(onFiles: (files: FileList) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", () => {
    if (input.files?.length) onFiles(input.files);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

// ---------------------------------------------------------------------------
// 1. Inline dropzone custom element
// ---------------------------------------------------------------------------

class MultiImageUploader extends HTMLElement {
  private statusEl: HTMLElement | null = null;

  connectedCallback() {
    log("connectedCallback — rendering inline dropzone");
    this.render();
    this.diagnoseVisibility();
  }

  private diagnoseVisibility() {
    requestAnimationFrame(() => {
      const rect = this.getBoundingClientRect();
      const cs = getComputedStyle(this);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const atPoint = document.elementFromPoint(cx, cy);
      const covered = !!atPoint && atPoint !== this && !this.contains(atPoint);
      log(
        `inline mount — rect={x:${Math.round(rect.x)},y:${Math.round(rect.y)},w:${Math.round(rect.width)},h:${Math.round(rect.height)}} ` +
          `display=${cs.display} opacity=${cs.opacity} visibility=${cs.visibility}`,
      );
      log(
        `inline mount — elementFromPoint(center)=<${atPoint?.tagName?.toLowerCase()} class="${(atPoint as HTMLElement)?.className}">, coveredByOther=${covered}`,
      );
      if (covered) {
        warn(
          "inline dropzone is COVERED by another element at its centre — that's why it's not clickable/visible. The floating button (bottom-right) is the reliable path.",
        );
      }
    });
  }

  private render() {
    this.innerHTML = `
      <style>
        .miu-zone {
          display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 0.25rem; padding: 1.5rem;
          border: 2px dashed #c7cdd6; border-radius: 0.75rem;
          background: #f8fafc; color: #475569;
          font: 500 0.95rem/1.4 system-ui, sans-serif; text-align: center;
          cursor: pointer; transition: border-color 0.15s, background 0.15s;
        }
        .miu-zone[data-drag="true"] { border-color: #2563eb; background: #eff6ff; }
        .miu-zone strong { color: #1e293b; }
        .miu-hint { font-size: 0.8rem; color: #64748b; }
        .miu-status { font-size: 0.8rem; color: #2563eb; min-height: 1.1em; }
        .miu-zone input { display: none; }
      </style>
      <label class="miu-zone">
        <span>⬆ <strong>Drop images here</strong> or click to select</span>
        <span class="miu-hint">Upload multiple at once</span>
        <span class="miu-status"></span>
        <input type="file" accept="image/*" multiple />
      </label>
    `;

    const zone = this.querySelector<HTMLElement>(".miu-zone")!;
    const input = this.querySelector<HTMLInputElement>("input")!;
    this.statusEl = this.querySelector<HTMLElement>(".miu-status");

    input.addEventListener("change", () => {
      if (input.files?.length) this.upload(input.files);
      input.value = "";
    });

    const setDrag = (on: boolean) => zone.setAttribute("data-drag", String(on));
    ["dragenter", "dragover"].forEach((evt) =>
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        setDrag(true);
      }),
    );
    ["dragleave", "dragend"].forEach((evt) =>
      zone.addEventListener(evt, () => setDrag(false)),
    );
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      setDrag(false);
      const files = (e as DragEvent).dataTransfer?.files;
      if (files?.length) this.upload(files);
    });
  }

  private upload(files: FileList) {
    const imagesArray =
      this.parentElement?.querySelector('[data-editable="array"][data-prop="images"]') ??
      this.closest('[data-editable="array-item"]')?.querySelector('[data-editable="array"][data-prop="images"]');
    if (!imagesArray) {
      warn("inline upload — could not find sibling images array");
      return;
    }
    const slug = resolveSlugFor(imagesArray);
    if (!slug) return;
    uploadAll(slug, files, (t) => {
      if (this.statusEl) this.statusEl.textContent = t;
    });
  }
}

if (!customElements.get("multi-image-uploader")) {
  customElements.define("multi-image-uploader", MultiImageUploader);
  log("customElements.define('multi-image-uploader') done");
} else {
  log("multi-image-uploader already defined — skipping");
}

// ---------------------------------------------------------------------------
// 2. Floating always-visible button (rcc-v2-style FAB)
// ---------------------------------------------------------------------------

function injectFloatingButton(): void {
  if (document.getElementById("miu-fab")) return;

  const fab = document.createElement("button");
  fab.id = "miu-fab";
  fab.type = "button";
  fab.innerHTML = "⬆ Add images";
  Object.assign(fab.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "999999",
    padding: "12px 18px",
    border: "none",
    borderRadius: "999px",
    background: "#034ad8",
    color: "#ffffff",
    font: "600 14px/1 system-ui, sans-serif",
    boxShadow: "0 2px 12px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.12)",
    cursor: "pointer",
  });

  const status = document.createElement("div");
  Object.assign(status.style, {
    position: "fixed",
    bottom: "64px",
    right: "20px",
    zIndex: "999999",
    padding: "6px 10px",
    borderRadius: "8px",
    background: "#0f172a",
    color: "#fff",
    font: "500 12px/1.3 system-ui, sans-serif",
    boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
    display: "none",
    maxWidth: "240px",
  });

  const setStatus = (t: string) => {
    status.textContent = t;
    status.style.display = t ? "block" : "none";
  };

  fab.addEventListener("click", () => {
    const galleries = document.querySelectorAll<HTMLElement>(
      '[data-editable="array"][data-prop="images"]',
    );
    log(`floating button — found ${galleries.length} gallery array(s) on page`);
    if (!galleries.length) {
      setStatus("No Gallery block on this page. Add one to the home page.");
      setTimeout(() => setStatus(""), 4000);
      return;
    }
    if (galleries.length > 1) {
      log("floating button — multiple galleries; targeting the first");
    }
    const slug = resolveSlugFor(galleries[0]);
    if (!slug) {
      setStatus("Couldn't resolve the gallery's data path (see console).");
      return;
    }
    pickFiles((files) => uploadAll(slug, files, setStatus));
  });

  document.body.appendChild(fab);
  document.body.appendChild(status);
  log("floating 'Add images' button injected (bottom-right)");
}

// The FAB needs the DOM ready; body exists by the time this editor-only module
// runs, but guard anyway.
if (document.body) injectFloatingButton();
else document.addEventListener("DOMContentLoaded", injectFloatingButton);

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

requestAnimationFrame(() => {
  const count = document.querySelectorAll("multi-image-uploader").length;
  log(`${count} <multi-image-uploader> element(s) in the DOM`);
});

export {};
