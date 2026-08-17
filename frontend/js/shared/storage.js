

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

export function readMigratedStorage(name, key, legacyKey, fallback = null) {
  const current = readStorage(name, key, null);
  if (current !== null) return current;
  const legacy = readStorage(name, legacyKey, null);
  if (legacy === null) return fallback;
  writeStorage(name, key, legacy);
  removeStorage(name, legacyKey);
  return legacy;
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
