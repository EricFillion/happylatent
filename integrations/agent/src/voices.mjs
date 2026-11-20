// IDs, language and presentation from the upstream Kokoro v1 voice catalog.
// Style is deliberately unknown until auditioned, not inferred from a name.
const groups = {
  af: 'heart alloy aoede bella jessica kore nicole nova river sarah sky',
  am: 'adam echo eric fenrir liam michael onyx puck santa',
  bf: 'alice emma isabella lily', bm: 'daniel fable george lewis',
  jf: 'alpha gongitsune nezumi tebukuro', jm: 'kumo',
  zf: 'xiaobei xiaoni xiaoxiao xiaoyi', zm: 'yunjian yunxi yunxia yunyang',
  ef: 'dora', em: 'alex santa', ff: 'siwis', hf: 'alpha beta', hm: 'omega psi',
  if: 'sara', im: 'nicola', pf: 'dora', pm: 'alex santa',
};
const languages = { a: 'American English', b: 'British English', j: 'Japanese', z: 'Mandarin Chinese',
  e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', p: 'Brazilian Portuguese' };
const defaults = new Set(['af_heart', 'am_michael', 'bf_emma', 'bm_fable']);
export function voiceGuide(speakers) {
  return {
    model: 'Kokoro 82M v1.0',
    source: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md',
    evidence: 'Documented language and voice presentation. No listening analysis has been performed; timbre, pitch, warmth, age, emotion and acting style are unverified.',
    selection: 'Honor the requested language/accent and voice presentation, then choose an installed voice. The four starter presets are defaults, not style rankings. For a requested timbre or emotion, audition a short representative line before committing. Keep the same speaker and speed for a recurring character. Start speed at 1; speed changes pace, not voice identity or an emotion control.',
    voices: Object.entries(groups).flatMap(([prefix, names]) => names.split(' ').map(name => {
      const speaker = `${prefix}_${name}`;
      return { speaker, language: languages[prefix[0]], presentation: prefix[1] === 'f' ? 'feminine' : 'masculine',
        supported: !['j', 'z'].includes(prefix[0]),
        installed: speakers === undefined ? null : speakers.includes(speaker),
        starterPreset: defaults.has(speaker), style: null, styleEvidence: 'Not auditioned' };
    })),
  };
}
