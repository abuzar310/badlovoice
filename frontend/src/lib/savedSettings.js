// Presets and profiles for when there is no server to keep them: the built-in
// presets ship with the app, and the user's own are saved in this browser.

export const MAX_NAME_LENGTH = 40;

const tilt = (pitch, formant, low, high) => ({
  pitch_shift: pitch,
  formant_shift: formant,
  effects: {
    robot: { enabled: false, freq: 90 },
    eq: { enabled: true, low, high },
  },
});

// Same ids, names and settings as BUILTIN_PRESETS in
// backend/services/preset_store.py, whose list is used instead whenever a
// server answers. Effect keys and parameter names are the ones in lib/effects.js.
export const BUILTIN_PRESETS = [
  { id: 'male', name: 'Male', description: 'Young adult man', settings: tilt(-1, -1.5, 2, -1) },
  { id: 'female', name: 'Female', description: 'Young adult woman', settings: tilt(5, 3.5, -1, 3) },
  { id: 'mid-man', name: 'Mid-age man', description: 'Deeper, warmer man', settings: tilt(-4, -3, 4, -3) },
  { id: 'mid-woman', name: 'Mid-age woman', description: 'Mature woman tone', settings: tilt(3, 2, 1, 1) },
  { id: 'teen-boy', name: 'Teen boy', description: 'Teenage boy', settings: tilt(2, 1, 0, 1) },
  { id: 'teen-girl', name: 'Teen girl', description: 'Teenage girl', settings: tilt(6, 4, -1, 4) },
  { id: 'boy', name: 'Boy', description: 'Young boy', settings: tilt(8, 5, -2, 5) },
  { id: 'girl', name: 'Girl', description: 'Young girl', settings: tilt(10, 6.5, -3, 6) },
  {
    id: 'clean',
    name: 'Clean',
    description: 'No pitch change and no effects',
    settings: { pitch_shift: 0, formant_shift: 0, effects: {} },
  },
  {
    id: 'robot',
    name: 'Robot',
    description: 'Metallic voice with a lo-fi edge',
    settings: {
      pitch_shift: 0,
      formant_shift: 0,
      effects: {
        robot: { enabled: true, freq: 90 },
        bitcrush: { enabled: true, bits: 10, down: 2 },
      },
    },
  },
  {
    id: 'monster',
    name: 'Monster',
    description: 'Growling low pitch with drive',
    settings: {
      pitch_shift: -9,
      formant_shift: -5,
      effects: {
        distortion: { enabled: true, drive: 0.45 },
        reverb: { enabled: true, size: 0.35, mix: 0.25 },
      },
    },
  },
  {
    id: 'telephone',
    name: 'Telephone',
    description: 'Narrow landline call',
    settings: {
      pitch_shift: 0,
      formant_shift: 0,
      effects: {
        telephone: { enabled: true },
        compressor: { enabled: true, threshold: -24, ratio: 4 },
      },
    },
  },
];

const isSavedItem = (item) =>
  Boolean(item) &&
  typeof item.id === 'string' &&
  typeof item.name === 'string' &&
  Boolean(item.settings) &&
  typeof item.settings === 'object';

/** A named list kept in localStorage. Saving a name that exists replaces it. */
function createLocalStore(key, limit, plural) {
  const list = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(stored) ? stored.filter(isSavedItem) : [];
    } catch {
      return [];
    }
  };

  const write = (items) => {
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch {
      throw new Error("The browser's storage on this device is full or switched off.");
    }
  };

  return {
    list,
    save(name, settings) {
      const clean = String(name).trim().slice(0, MAX_NAME_LENGTH);
      if (!clean) throw new Error('Give it a name first.');
      // The id is the name itself, so any language or emoji works.
      const item = { id: `local:${clean.toLowerCase()}`, name: clean, settings, local: true };
      const items = list();
      const at = items.findIndex((other) => other.id === item.id);
      if (at === -1 && items.length >= limit) {
        throw new Error(`You already have ${limit} saved ${plural}. Delete one to save another.`);
      }
      if (at === -1) items.push(item);
      else items[at] = item;
      write(items);
      return item;
    },
    remove(id) {
      write(list().filter((item) => item.id !== id));
    },
  };
}

export const localPresets = createLocalStore('badlovoice_presets_v1', 100, 'presets');
export const localProfiles = createLocalStore('badlovoice_profiles_v1', 40, 'profiles');
