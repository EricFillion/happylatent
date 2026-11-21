// Pinned Kokoro v1.0 assets from the Hub. Weights and voice hashes come from
// the LFS metadata. The SHA-256 of config.json is computed from its raw bytes.
export const SPEECH_DOWNLOAD_FILES = Object.fromEntries([
  ['config.json', 2351, '5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f'],
  ['kokoro-v1_0.pth', 327212226, '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4'],
  ['voices/af_heart.pt', 523425, '0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff'],
  ['voices/am_michael.pt', 523435, '9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37'],
  ['voices/bf_emma.pt', 523420, 'd0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701'],
  ['voices/bm_fable.pt', 523425, 'd44935f3135257a9064df99f007fc1342ff1aa767552b4a4fa4c3b2e6e59079c'],
].map(([path, size, sha256]) => [path, {
  repo: 'hexgrad/Kokoro-82M', revision: 'f3ff3571791e39611d31c381e3a41a3af07b4987',
  filename: path, path, size, sha256,
}]));
