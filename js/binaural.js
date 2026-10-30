// Binaural headphone render of a speaker bed: every speaker becomes a virtual
// source at its position through the browser's built-in HRTF panner
// (OfflineAudioContext, so it runs faster than real time). The LFE goes to
// both ears at its +10 dB playback gain.

import { LAYOUTS } from './engine/spatial.js';

export async function renderBinaural(chs, sr, layout) {
  const n = chs[0].length;
  const ctx = new OfflineAudioContext(2, n, sr);
  LAYOUTS[layout].channels.forEach((c, i) => {
    const buf = ctx.createBuffer(1, n, sr);
    buf.copyToChannel(chs[i], 0);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    if (c.lfe) {
      src.connect(new GainNode(ctx, { gain: Math.pow(10, 10 / 20) })).connect(ctx.destination);
    } else {
      // Web Audio: listener at the origin facing -z, +x to the right, +y up.
      const az = (c.az * Math.PI) / 180, el = (c.el * Math.PI) / 180;
      const p = new PannerNode(ctx, {
        panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0,
        positionX: -Math.sin(az) * Math.cos(el), positionY: Math.sin(el), positionZ: -Math.cos(az) * Math.cos(el),
      });
      src.connect(p).connect(ctx.destination);
    }
    src.start();
  });
  const out = await ctx.startRendering();
  return [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
}
