// Custom multi-image uploader for the CloudCannon Visual Editor.
//
// CloudCannon's stock image input adds one file at a time. This web component
// renders an on-canvas dropzone that uploads *many* files in a single action
// and appends each to the enclosing Gallery block's `images` array, driving the
// Visual Editor JavaScript API directly:
//
//   const api = window.CloudCannonAPI.useVersion("v1", true)
//   const url = await api.uploadFile(file, inputConfig)
//   await api.currentFile().data.addArrayItem({ slug, item })
//
// It is only ever loaded inside the editor (imported from register-components.ts,
// which Layout.astro loads under `if (window.inEditorMode)`).

type CloudCannonFile = {
  data: {
    addArrayItem(opts: { slug: string; item?: unknown }): Promise<unknown>;
  };
  getInputConfig?(opts: { slug: string }): unknown;
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

function getApi(): Promise<CloudCannonApi> {
  const resolveApi = () => window.CloudCannonAPI!.useVersion("v1", true);
  if (window.CloudCannonAPI) return Promise.resolve(resolveApi());
  return new Promise((resolve) => {
    document.addEventListener("cloudcannon:load", () => resolve(resolveApi()), {
      once: true,
    });
  });
}

class MultiImageUploader extends HTMLElement {
  private apiPromise?: Promise<CloudCannonApi>;
  private statusEl: HTMLElement | null = null;

  connectedCallback() {
    this.render();
    this.apiPromise = getApi();
  }

  private render() {
    this.innerHTML = `
      <style>
        .miu-zone {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.25rem;
          padding: 1.5rem;
          border: 2px dashed #c7cdd6;
          border-radius: 0.75rem;
          background: #f8fafc;
          color: #475569;
          font: 500 0.95rem/1.4 system-ui, sans-serif;
          text-align: center;
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
        }
        .miu-zone[data-drag="true"] { border-color: #2563eb; background: #eff6ff; }
        .miu-zone strong { color: #1e293b; }
        .miu-hint { font-size: 0.8rem; color: #64748b; }
        .miu-status { font-size: 0.8rem; color: #2563eb; min-height: 1.1em; }
        .miu-zone input { display: none; }
      </style>
      <label class="miu-zone" part="zone">
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
      if (input.files?.length) this.handleFiles(input.files);
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
      if (files?.length) this.handleFiles(files);
    });
  }

  private setStatus(text: string) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  // Resolve this uploader's target array path from the live DOM, e.g.
  // `content_blocks.2.images`. Reading it from the DOM at action time keeps it
  // correct across component re-renders and content_blocks reordering.
  private resolveSlug(): string | null {
    const blockItem = this.closest('[data-editable="array-item"]');
    if (!blockItem) return "images"; // Gallery placed outside an array wrapper.

    const arrayEl = blockItem.closest('[data-editable="array"]');
    const arrayProp = arrayEl?.getAttribute("data-prop");
    if (!arrayEl || !arrayProp) return null;

    const items = Array.from(
      arrayEl.querySelectorAll(':scope > [data-editable="array-item"]'),
    );
    const index = items.indexOf(blockItem);
    if (index < 0) return null;

    return `${arrayProp}.${index}.images`;
  }

  private async handleFiles(fileList: FileList) {
    const files = Array.from(fileList).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (!files.length) return;

    const slug = this.resolveSlug();
    if (!slug) {
      this.setStatus("Couldn't locate this gallery's data path.");
      console.error("[multi-image-uploader] could not resolve data path");
      return;
    }

    const api = await this.apiPromise!;
    const file = api.currentFile();

    let inputConfig: unknown;
    try {
      inputConfig = file.getInputConfig?.({ slug: `${slug}.0.image_path` });
    } catch {
      inputConfig = undefined;
    }

    // Sequential: keeps append order deterministic and avoids racing the
    // coarse `change` events the API fires on each write.
    let done = 0;
    this.setStatus(`Uploading 0/${files.length}…`);
    for (const f of files) {
      try {
        const url = await api.uploadFile(f, inputConfig);
        await file.data.addArrayItem({
          slug,
          item: { image_path: url, alt_text: "" },
        });
        done++;
      } catch (err) {
        console.error("[multi-image-uploader] upload failed:", f.name, err);
      }
      this.setStatus(`Uploading ${done}/${files.length}…`);
    }

    this.setStatus(
      done === files.length
        ? `Added ${done} image${done === 1 ? "" : "s"}.`
        : `Added ${done} of ${files.length} (see console for errors).`,
    );
  }
}

if (!customElements.get("multi-image-uploader")) {
  customElements.define("multi-image-uploader", MultiImageUploader);
}

export {};
