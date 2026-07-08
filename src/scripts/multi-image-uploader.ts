// Custom multi-image uploader for the CloudCannon Visual Editor.
//
// CloudCannon's stock image input adds one file at a time. The <multi-image-uploader>
// element renders an on-canvas dropzone inside each Gallery block that uploads
// *many* files in a single action and appends each to that block's `images`
// array, driving the Visual Editor JavaScript API directly:
//
//   const api = window.CloudCannonAPI.useVersion("v1", true)
//   const url = await api.uploadFile(file, await file.getInputConfig({ slug }))
//   await api.currentFile().data.addArrayItem({ slug, item })
//
// Loaded only inside the editor (see Layout.astro). Set `localStorage.miu-debug
// = "1"` and reload to see verbose `[MIU]` tracing; errors always log.

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

const DEBUG =
  typeof localStorage !== "undefined" && localStorage.getItem("miu-debug") === "1";
const log = (...args: unknown[]) => DEBUG && console.log("[MIU]", ...args);
const warn = (...args: unknown[]) => console.warn("[MIU]", ...args);

function getApi(): Promise<CloudCannonApi> {
  // window.inEditorMode can be true while window.CloudCannonAPI is still absent,
  // so fall back to the cloudcannon:load event.
  if (window.CloudCannonAPI) {
    return Promise.resolve(window.CloudCannonAPI.useVersion("v1", true));
  }
  return new Promise((resolve) => {
    document.addEventListener(
      "cloudcannon:load",
      () => resolve(window.CloudCannonAPI!.useVersion("v1", true)),
      { once: true },
    );
  });
}

const apiPromise = getApi();

// Resolve a Gallery's images-array element to its absolute data path, e.g.
// `content_blocks.2.images`. Read from the live DOM so it stays correct across
// component re-renders and content_blocks reordering.
function resolveSlug(imagesArray: Element): string | null {
  const blockItem = imagesArray.closest('[data-editable="array-item"]');
  if (!blockItem) return "images"; // Gallery placed outside an array wrapper.

  const contentArray = blockItem.closest('[data-editable="array"]');
  const prop = contentArray?.getAttribute("data-prop");
  if (!contentArray || !prop) {
    warn("[MIU] could not resolve the gallery's data path");
    return null;
  }

  const items = Array.from(
    contentArray.querySelectorAll(':scope > [data-editable="array-item"]'),
  );
  const index = items.indexOf(blockItem);
  if (index < 0) {
    warn("[MIU] could not locate the gallery block's index");
    return null;
  }
  return `${prop}.${index}.images`;
}

async function uploadAll(
  slug: string,
  fileList: FileList,
  onStatus: (text: string) => void,
): Promise<void> {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;

  const api = await apiPromise;
  const file = api.currentFile();

  // getInputConfig may return a Promise — it MUST be awaited to a plain object
  // before uploadFile(), which postMessages it to the parent window (a pending
  // Promise → DataCloneError and the upload silently never runs).
  let inputConfig: unknown;
  try {
    inputConfig = await file.getInputConfig?.({ slug: `${slug}.0.image_path` });
  } catch (e) {
    warn("[MIU] getInputConfig failed (continuing without it):", e);
  }

  // Sequential: keeps append order deterministic and avoids racing the coarse
  // `change` events the API fires on each write.
  let done = 0;
  onStatus(`Uploading 0/${files.length}…`);
  for (const f of files) {
    try {
      const url = await api.uploadFile(f, inputConfig);
      await file.data.addArrayItem({
        slug,
        item: { image_path: url, alt_text: "" },
      });
      log(`added ${url} to ${slug}`);
      done++;
    } catch (err) {
      console.error("[MIU] upload/append failed:", f.name, err);
    }
    onStatus(`Uploading ${done}/${files.length}…`);
  }
  onStatus(
    done === files.length
      ? `Added ${done} image${done === 1 ? "" : "s"}.`
      : `Added ${done} of ${files.length} (see console).`,
  );
}

class MultiImageUploader extends HTMLElement {
  private statusEl: HTMLElement | null = null;

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = `
      <style>
        .miu-zone {
          display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 0.25rem; padding: 1rem;
          height: 100%; min-height: 12rem;
          border: 2px dashed #c7cdd6; border-radius: 0.5rem;
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
    // The dropzone is a sibling of the block's images array.
    const imagesArray = this.parentElement?.querySelector(
      '[data-editable="array"][data-prop="images"]',
    );
    if (!imagesArray) {
      warn("[MIU] could not find this block's images array");
      return;
    }
    const slug = resolveSlug(imagesArray);
    if (!slug) return;
    uploadAll(slug, files, (t) => {
      if (this.statusEl) this.statusEl.textContent = t;
    });
  }
}

if (!customElements.get("multi-image-uploader")) {
  customElements.define("multi-image-uploader", MultiImageUploader);
}

export {};
