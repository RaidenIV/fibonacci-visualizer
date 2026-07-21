import { DEFAULTS, SETTINGS_VERSION, VISUAL_PRESETS } from "./config.js";

export class StateStore extends EventTarget {
  constructor(storageKey = "fibonacci-audio-field-settings") {
    super();
    this.storageKey = storageKey;
    this.settings = { ...DEFAULTS, ...this.readStoredSettings() };
    if (!["mp4", "mkv"].includes(this.settings.exportFormat)) this.settings.exportFormat = "mp4";
  }

  readStoredSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (!parsed || parsed.version !== SETTINGS_VERSION || !parsed.settings) return {};
      return parsed.settings;
    } catch {
      return {};
    }
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value, { silent = false } = {}) {
    if (!(key in DEFAULTS)) return;
    this.settings[key] = value;
    this.persist();
    if (!silent) this.dispatchEvent(new CustomEvent("change", { detail: { key, value } }));
  }

  patch(values, { silent = false } = {}) {
    const changed = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!(key in DEFAULTS)) continue;
      this.settings[key] = value;
      changed[key] = value;
    }
    this.persist();
    if (!silent) this.dispatchEvent(new CustomEvent("patch", { detail: changed }));
  }

  applyPreset(name) {
    const preset = VISUAL_PRESETS[name];
    if (!preset) return;
    this.patch(preset);
  }

  reset() {
    this.settings = { ...DEFAULTS };
    this.persist();
    this.dispatchEvent(new CustomEvent("reset", { detail: { ...this.settings } }));
  }

  exportPayload() {
    return {
      app: "Fibonacci Audio Field",
      version: SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      settings: { ...this.settings },
    };
  }

  importPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.settings !== "object") {
      throw new Error("This JSON file does not contain Fibonacci Audio Field settings.");
    }
    this.patch(payload.settings);
  }

  persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ version: SETTINGS_VERSION, settings: this.settings }));
    } catch {
      // The app remains functional when storage is blocked.
    }
  }
}
