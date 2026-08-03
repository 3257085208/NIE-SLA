

function storageArea(name) {
  try {
    return globalThis[name] || null;
  } catch (_) {
    return null;
  }
}

export function readStorage(name, key, fallback = null) {
  try {
    return storageArea(name)?.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

export function writeStorage(name, key, value) {
  try {
    const storage = storageArea(name);
    if (!storage) return false;
    storage.setItem(key, String(value));
    return true;
  } catch (_) {
    return false;
  }
}

export function removeStorage(name, key) {
  try {
    const storage = storageArea(name);
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}
