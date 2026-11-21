import { voiceGuide } from './voices.mjs';

// Pinned Kokoro v1.0 assets from the Hub. Weights and voice hashes come from
// the LFS metadata. The SHA-256 of config.json is computed from its raw bytes.
export const SPEECH_DOWNLOAD_FILES = Object.fromEntries([
  ['config.json', 2351, '5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f'],
  ['kokoro-v1_0.pth', 327212226, '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4'],
  ['voices/af_heart.pt', 523425, '0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff'],
  ['voices/af_alloy.pt', 523425, '6d877149dd8b348fbad12e5845b7e43d975390e9f3b68a811d1d86168bef5aa3'],
  ['voices/af_aoede.pt', 523425, 'c03bd1a4c3716c2d8eaa3d50022f62d5c31cfbd6e15933a00b17fefe13841cc4'],
  ['voices/af_bella.pt', 523425, '8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6'],
  ['voices/af_jessica.pt', 523435, 'cdfdccb8cc975aa34ee6b89642963b0064237675de0e41a30ae64cc958dd4e87'],
  ['voices/af_kore.pt', 523420, '8bfbc512321c3db49dff984ac675fa5ac7eaed5a96cc31104d3a9080e179d69d'],
  ['voices/af_nicole.pt', 523430, 'c5561808bcf5250fe8c5f5de32caf2d94f27e57e95befdb098c5c85991d4c5da'],
  ['voices/af_nova.pt', 523420, 'e0233676ddc21908c37a1f102f6b88a59e4e5c1bd764983616eb9eda629dbcd2'],
  ['voices/af_river.pt', 523425, 'e149459bd9c084416b74756b9bd3418256a8b839088abb07d463730c369dab8f'],
  ['voices/af_sarah.pt', 523425, '49bd364ea3be9eb3e9685e8f9a15448c4883112a7c0ff7ab139fa4088b08cef9'],
  ['voices/af_sky.pt', 523351, 'c799548aed06e0cb0d655a85a01b48e7f10484d71663f9a3045a5b9362e8512c'],
  ['voices/am_adam.pt', 523420, 'ced7e284aba12472891be1da3ab34db84cc05cc02b5889535796dbf2d8b0cb34'],
  ['voices/am_echo.pt', 523420, '8bcfdc852bc985fb45c396c561e571ffb9183930071f962f1b50df5c97b161e8'],
  ['voices/am_eric.pt', 523420, 'ada66f0eefff34ec921b1d7474d7ac8bec00cd863c170f1c534916e9b8212aae'],
  ['voices/am_fenrir.pt', 523430, '98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a'],
  ['voices/am_liam.pt', 523420, 'c82550757ddb31308b97f30040dda8c2d609a9e2de6135848d0a948368138518'],
  ['voices/am_michael.pt', 523435, '9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37'],
  ['voices/am_onyx.pt', 523420, 'e8452be16cd0f6da7b4579eaf7b1e4506e92524882053d86d72b96b9a7fed584'],
  ['voices/am_puck.pt', 523420, 'dd1d8973f4ce4b7d8ae407c77a435f485dabc052081b80ea75c4f30b84f36223'],
  ['voices/am_santa.pt', 523425, '7f2f7582fa2b1f160e90aafe6d0b442a685e773608b6667e545d743b073e97a7'],
  ['voices/bf_alice.pt', 523425, 'd292651b6af6c0d81705c2580dcb4463fccc0ff7b8d618a471dbb4e45655b3f3'],
  ['voices/bf_emma.pt', 523420, 'd0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701'],
  ['voices/bf_isabella.pt', 523440, 'cdd4c37003805104d1d08fb1e05855c8fb2c68de24ca6e71f264a30aaa59eefd'],
  ['voices/bf_lily.pt', 523420, '6e09c2e481e2d53004d7e5ae7d3a325369e130a6f45c35a6002de75084be9285'],
  ['voices/bm_daniel.pt', 523430, 'fc3fce4e9c12ed4dbc8fa9680cfe51ee190a96444ce7c3ad647549a30823fc5d'],
  ['voices/bm_fable.pt', 523425, 'd44935f3135257a9064df99f007fc1342ff1aa767552b4a4fa4c3b2e6e59079c'],
  ['voices/bm_george.pt', 523430, 'f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b'],
  ['voices/bm_lewis.pt', 523425, 'b5204750dcba01029d2ac9cec17aec3b20a6d64073c579d694a23cb40effbd0e'],
  ['voices/ef_dora.pt', 523420, 'd9d69b0f8a2b87a345f269d89639f89dfbd1a6c9da0c498ae36dd34afcf35530'],
  ['voices/em_alex.pt', 523420, '5eac53f767c3f31a081918ba531969aea850bed18fe56419b804d642c6973431'],
  ['voices/em_santa.pt', 523430, 'aa8620cb96cec705823efca0d956a63e158e09ad41aca934d354b7f0778f63cb'],
  ['voices/ff_siwis.pt', 523425, '8073bf2d2c4b9543a90f2f0fd2144de4ed157e2d4b79ddeb0d5123066171fbc9'],
  ['voices/hf_alpha.pt', 523425, '06906fe05746d13a79c5c01e21fd7233b05027221a933c9ada650f5aafc8f044'],
  ['voices/hf_beta.pt', 523420, '63c0a1a6272e98d43f4511bba40e30dd9c8ceaf5f39af869509b9f51a71c503e'],
  ['voices/hm_omega.pt', 523425, 'b55f02a8e8483fffe0afa566e7d22ed8013acf47ad4f6bbee2795a840155703e'],
  ['voices/hm_psi.pt', 523351, '2f0f055cea4f1083f4ef127ece48d71606347f6557dbb961c0ca5740a2da485b'],
  ['voices/if_sara.pt', 523425, '6c0b253b955fe32f1a1a86006aebe83d050ea95afd0e7be15182f087deedbf55'],
  ['voices/im_nicola.pt', 523341, '234ed06648649f9bd874b37508ea17560b9c993ef85b4ddb3e3a71e062bd2c12'],
  ['voices/pf_dora.pt', 523425, '07e4ff987c5d5a8c3995efd15cc4f0db7c4c15e881b198d8ab7f67ecf51f5eb7'],
  ['voices/pm_alex.pt', 523425, 'cf0ba8c573c2480fc54123683a35cf1e2ae130428e441eb91f9149bdb188a526'],
  ['voices/pm_santa.pt', 523430, 'd42103169c5c872abbafb9129133af7e942bb9d272c3cc3b95c203e7d7198c29'],
].map(([path, size, sha256]) => [path, {
  repo: 'hexgrad/Kokoro-82M', revision: 'f3ff3571791e39611d31c381e3a41a3af07b4987',
  filename: path, path, size, sha256,
}]));

const supportedVoices = voiceGuide().voices.filter(({ supported }) => supported);
const supportedSpeakers = new Set(supportedVoices.map(({ speaker }) => speaker));
export const SPEECH_VOICE_GROUPS = [
  'all', 'English', ...new Set(supportedVoices.map(({ language }) => language)),
];

export function selectSpeechVoices(selection = 'all') {
  if (Array.isArray(selection)) {
    if (!selection.length || selection.some(speaker => !supportedSpeakers.has(speaker))) {
      throw new Error('Choose one or more supported Kokoro voice IDs from get_voice_guide.');
    }
    return [...new Set(selection)].sort();
  }
  if (!SPEECH_VOICE_GROUPS.includes(selection)) {
    throw new Error('Choose all voices, a supported language, or a list of Kokoro voice IDs.');
  }
  return supportedVoices.filter(({ language }) => selection === 'all' || selection === language ||
    (selection === 'English' && language.endsWith(' English'))).map(({ speaker }) => speaker).sort();
}
