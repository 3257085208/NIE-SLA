export const NQ_OPTION_DEFAULTS = Object.freeze({
  hardware: "f",
  ip: "y",
  net: "y",
  route: "y",
  accelerator: "auto",
});

const NQ_OPTION_ALLOWED = Object.freeze({
  hardware: new Set(["y", "f", "v", "n"]),
  ip: new Set(["y", "n"]),
  net: new Set(["y", "l", "n"]),
  route: new Set(["y", "n"]),
  accelerator: new Set(["auto", "cf"]),
});

const NQ_OPTION_LABELS = Object.freeze({
  hardware: "运行 HardwareQuality 测试？",
  ip: "运行 IPQuality 测试？",
  net: "运行 NetQuality 测试？",
  route: "运行 回程路由追踪（Backroute Trace）测试？",
  accelerator: "加速源",
});

const NQ_OPTION_CHOICES = Object.freeze({
  hardware: [["y", "是"], ["f", "快速"], ["v", "深度"], ["n", "否"]],
  ip: [["y", "是"], ["n", "否"]],
  net: [["y", "是"], ["l", "低流量"], ["n", "否"]],
  route: [["y", "是"], ["n", "否"]],
  accelerator: [["auto", "默认"], ["cf", "Cloudflare 海外"]],
});

export function normalizeNqOptions(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(NQ_OPTION_DEFAULTS)) {
    const candidate = String(raw[key] ?? fallback).trim().toLowerCase();
    normalized[key] = NQ_OPTION_ALLOWED[key].has(candidate) ? candidate : fallback;
  }
  return normalized;
}

export function nqOptionsHtml(values = NQ_OPTION_DEFAULTS) {
  const current = normalizeNqOptions(values);
  return `<div class="nq-options">${Object.keys(NQ_OPTION_DEFAULTS).map((key) => {
    const choices = NQ_OPTION_CHOICES[key];
    return `<label class="nq-option"><span>${NQ_OPTION_LABELS[key]}</span><select data-nq-option="${key}" name="nq-${key}">${choices.map(([value, text]) => `<option value="${value}"${value === current[key] ? " selected" : ""}>${text}</option>`).join("")}</select></label>`;
  }).join("")}</div>`;
}

export function readNqOptions(root = document) {
  const values = {};
  for (const key of Object.keys(NQ_OPTION_DEFAULTS)) {
    const select = root && typeof root.querySelector === "function" ? root.querySelector(`[data-nq-option="${key}"]`) : null;
    values[key] = select?.value || NQ_OPTION_DEFAULTS[key];
  }
  return normalizeNqOptions(values);
}
