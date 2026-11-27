/**
 * Voice presets for the in-browser engine (hosted site + Android APK).
 *
 * A profile is either
 *   - a target speaking pitch (`targetHz`): the shift is worked out from the
 *     user's own pitch, so "Female" is right for a deep and a high voice, or
 *   - a fixed shift (`pitch`) for effect voices that should not depend on who
 *     is talking.
 * `fx` is applied over a clean rack, so voices never inherit each other's effects.
 */
import { defaultEffects } from './effects';

export const VOICE_PROFILES = [
  // Adult
  {
    id: 'male',
    name: 'Male',
    group: 'Adult',
    blurb: 'Young adult man',
    targetHz: 120,
    formantBias: -0.5,
    fx: { eq: { low: 2, high: -1 } },
  },
  {
    id: 'female',
    name: 'Female',
    group: 'Adult',
    blurb: 'Young adult woman',
    targetHz: 210,
    formantBias: 0.5,
    fx: { eq: { low: -1, high: 3 } },
  },
  {
    id: 'mid-man',
    name: 'Mid-age man',
    group: 'Adult',
    blurb: 'Deeper, warmer man',
    targetHz: 105,
    formantBias: -1,
    fx: { eq: { low: 4, high: -3 } },
  },
  {
    id: 'mid-woman',
    name: 'Mid-age woman',
    group: 'Adult',
    blurb: 'Mature woman tone',
    targetHz: 185,
    formantBias: 0.2,
    fx: { eq: { low: 1, high: 1 } },
  },
  {
    id: 'deep',
    name: 'Deeper',
    group: 'Adult',
    blurb: 'Extra deep chest voice',
    targetHz: 90,
    formantBias: -1.5,
    fx: { eq: { low: 5, high: -3 }, compressor: { threshold: -22, ratio: 3 } },
  },
  {
    id: 'bright-female',
    name: 'Bright female',
    group: 'Adult',
    blurb: 'Airy higher woman',
    targetHz: 240,
    formantBias: 0.8,
    fx: { eq: { low: -2, high: 5 } },
  },
  {
    id: 'narrator',
    name: 'Narrator',
    group: 'Adult',
    blurb: 'Warm broadcast voice',
    pitch: -2,
    formant: -1,
    fx: { eq: { low: 4, high: 2 }, compressor: { threshold: -26, ratio: 4 } },
  },
  // Teen / Child
  {
    id: 'teen-boy',
    name: 'Teen boy',
    group: 'Teen',
    blurb: 'Teenage boy',
    targetHz: 165,
    formantBias: 0,
    fx: { eq: { low: 0, high: 1 } },
  },
  {
    id: 'teen-girl',
    name: 'Teen girl',
    group: 'Teen',
    blurb: 'Teenage girl',
    targetHz: 230,
    formantBias: 0.6,
    fx: { eq: { low: -1, high: 4 } },
  },
  {
    id: 'boy',
    name: 'Boy',
    group: 'Child',
    blurb: 'Young boy',
    targetHz: 280,
    formantBias: 1,
    fx: { eq: { low: -2, high: 4 } },
  },
  {
    id: 'girl',
    name: 'Girl',
    group: 'Child',
    blurb: 'Young girl',
    targetHz: 310,
    formantBias: 1.4,
    fx: { eq: { low: -3, high: 5 } },
  },
  // Fun / FX
  {
    id: 'giant',
    name: 'Giant',
    group: 'Fun',
    blurb: 'Huge and slow-sounding',
    targetHz: 75,
    formantBias: -2,
    fx: { eq: { low: 6, high: -4 }, reverb: { size: 0.7, mix: 0.18 } },
  },
  {
    id: 'chipmunk',
    name: 'Chipmunk',
    group: 'Fun',
    blurb: 'Tiny and squeaky',
    targetHz: 360,
    formantBias: 2,
    fx: { eq: { low: -4, high: 5 } },
  },
  {
    id: 'helium',
    name: 'Helium',
    group: 'Fun',
    blurb: 'Balloon voice, same pitch',
    pitch: 2,
    formant: 7,
    fx: { eq: { low: -3, high: 4 } },
  },
  {
    id: 'monster',
    name: 'Monster',
    group: 'Fun',
    blurb: 'Dark creature growl',
    targetHz: 82,
    formantBias: -2.2,
    fx: {
      robot: { freq: 48, mix: 0.3 },
      distortion: { drive: 0.22 },
      eq: { low: 5, high: -5 },
      reverb: { size: 0.35, mix: 0.14 },
    },
  },
  {
    id: 'demon',
    name: 'Demon',
    group: 'Fun',
    blurb: 'Layered, hellish low voice',
    pitch: -10,
    formant: -5,
    fx: {
      chorus: { rate: 0.4, depth: 0.9, mix: 0.5 },
      distortion: { drive: 0.3 },
      eq: { low: 6, high: -4 },
      reverb: { size: 0.8, mix: 0.28 },
    },
  },
  {
    id: 'villain',
    name: 'Villain',
    group: 'Fun',
    blurb: 'Movie bad-guy deep',
    targetHz: 95,
    formantBias: -1.8,
    fx: { eq: { low: 4, high: -3 }, reverb: { size: 0.6, mix: 0.2 } },
  },
  {
    id: 'robot',
    name: 'Robot',
    group: 'Fun',
    blurb: 'Flat, metallic machine',
    pitch: 0,
    formant: -0.5,
    fx: {
      monotone: { freq: 115 },
      robot: { freq: 58, mix: 0.3 },
      eq: { low: 0, high: 3 },
    },
  },
  {
    id: 'alien',
    name: 'Alien',
    group: 'Fun',
    blurb: 'Warbling outer-space voice',
    pitch: 4,
    formant: 4,
    fx: {
      vibrato: { rate: 9, depth: 1.4 },
      chorus: { rate: 2.2, depth: 0.8, mix: 0.5 },
      eq: { low: -3, high: 4 },
    },
  },
  {
    id: 'ghost',
    name: 'Ghost',
    group: 'Fun',
    blurb: 'Breathy and far away',
    pitch: 3,
    formant: 1,
    fx: {
      whisper: { mix: 0.65 },
      reverb: { size: 0.95, mix: 0.45 },
      eq: { low: -4, high: 3 },
    },
  },
  {
    id: 'whisper-high',
    name: 'Whisper',
    group: 'Fun',
    blurb: 'Secret-telling whisper',
    pitch: 0,
    formant: 0.5,
    fx: { whisper: { mix: 1 }, eq: { low: -4, high: 3 } },
  },
  {
    id: 'radio',
    name: 'Radio',
    group: 'Fun',
    blurb: 'Walkie-talkie vibe',
    pitch: 0,
    formant: 0,
    fx: {
      distortion: { drive: 0.12 },
      telephone: {},
      compressor: { threshold: -24, ratio: 5 },
    },
  },
  {
    id: 'megaphone',
    name: 'Megaphone',
    group: 'Fun',
    blurb: 'Loud, crunchy bullhorn',
    pitch: 0,
    formant: 0,
    fx: {
      distortion: { drive: 0.4 },
      telephone: {},
      echo: { time: 0.11, feedback: 0.2, mix: 0.18 },
    },
  },
  {
    id: 'cave',
    name: 'Cave',
    group: 'Fun',
    blurb: 'Big echoing space',
    pitch: 0,
    formant: 0,
    fx: {
      echo: { time: 0.32, feedback: 0.45, mix: 0.3 },
      reverb: { size: 0.9, mix: 0.35 },
    },
  },
];

/** Featured presets for the phone-first home (tap-first). */
export const FEATURED_PROFILE_IDS = [
  'deep',
  'female',
  'chipmunk',
  'monster',
  'robot',
  'whisper-high',
  'alien',
  'cave',
];

/** Assumed speaking pitch until the engine has measured the user's own. */
export const DEFAULT_HOST_HZ = 120;

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Semitone shift from host F0 toward profile target F0. */
export function pitchFromHost(hostHz, targetHz) {
  const h = Math.max(60, Number(hostHz) || DEFAULT_HOST_HZ);
  const t = Math.max(60, Number(targetHz) || h);
  const semis = 12 * Math.log2(t / h);
  return Math.round(clamp(semis, -16, 16) * 10) / 10;
}

/**
 * Vocal-tract (formant) shift that goes with a pitch change. A real voice an
 * octave higher has resonances only ~3–4 semitones higher, so formants follow
 * pitch at roughly a third of the rate.
 */
export function formantFromPitch(pitchSemis, bias = 0) {
  return Math.round(clamp(pitchSemis * 0.3 + bias, -8, 8) * 10) / 10;
}

export function profileToVoicePartial(profile, hostHz = DEFAULT_HOST_HZ) {
  if (typeof profile.pitch === 'number') {
    return {
      pitch: profile.pitch,
      formant: typeof profile.formant === 'number' ? profile.formant : 0,
    };
  }
  const pitch = pitchFromHost(hostHz, profile.targetHz);
  const formant =
    typeof profile.formant === 'number'
      ? profile.formant
      : formantFromPitch(pitch, profile.formantBias || 0);
  return { pitch, formant };
}

/** A clean rack with only this profile's effects switched on. */
export function profileToEffects(profile) {
  const next = defaultEffects();
  for (const [key, params] of Object.entries(profile.fx || {})) {
    if (next[key]) next[key] = { ...next[key], ...params, enabled: true };
  }
  return next;
}

export function describeShift(hostHz, profile) {
  return {
    ...profileToVoicePartial(profile, hostHz),
    hostHz,
    targetHz: profile.targetHz,
  };
}
