// Static Guide content: plain language first, technical detail folded away.

export const GUIDE_HTML = `
<h1>How MIXIT works</h1>
<p>MIXIT mixes stems and masters songs right here in your browser. Your audio is read, processed and saved on this computer. Nothing is uploaded, and there are no accounts or limits beyond your computer's memory.</p>

<h2>Easy and Advanced</h2>
<p><b>Easy</b> gives you eight plain sliders (lows, highs, punch, reverb and so on) and always comes out at streaming volume, -12 LUFS. <b>Advanced</b> opens every setting, charts, extra versions and more file types. Switch any time with the button at the top of the Mix and Master pages; each keeps its own settings.</p>

<h2>Mixing stems</h2>
<ul>
  <li><b>Drop all the stems of one song.</b> They should start at the same point (export them from the top of your session). Names like "kick", "808", "lead vox" or "dbl L" are sorted into vocals, drums, bass, music and FX automatically; fix any that land in the wrong place.</li>
  <li><b>Your rough mix (optional).</b> Add a bounce of the same song from your session. MIXIT works out how loud each part is in it and keeps that balance, then nudges the final tone toward it. If the bounce does not line up with the stems, MIXIT says so and uses its own balance instead.</li>
  <li><b>What happens:</b> each stem is cleaned up and evened out, the buses are balanced, the vocal is kept steady over the music, the music makes a little room for the voice and the bass for the kick, then reverb, echo and a gentle glue finish it off.</li>
  <li><b>Pitch correction</b> (Advanced, per vocal stem) pulls sung notes toward the key while keeping the voice natural. <b>Section moves</b> find verses and hooks and add contrast between them.</li>
</ul>

<h2>Mastering a song</h2>
<ul>
  <li>MIXIT listens to the track first and sets a starting point: brightness, muddiness cleanup, softening of harsh "s" sounds, compression and centred bass. Anything you change by hand is kept.</li>
  <li><b>Sound like this song</b> (optional): drop a finished song you like and the tone leans toward it. In Advanced you can average up to eight references and save them as a sound profile.</li>
  <li>Repair tools (clicks, hum, clipping, noise) are always off until you turn them on.</li>
  <li><b>Reverb</b> adds a touch of room to the whole song (the bass stays dry). <b>Vintage tape</b> adds warmth and a softer top; <b>tape hiss</b> adds faint tape noise, heard mostly in quiet parts.</li>
</ul>

<h2>Comparing fairly</h2>
<p>Louder nearly always sounds "better", so the player matches every version to the same loudness and keeps your place when you switch. You hear what changed, not just the volume. In Advanced you can also hear how streaming apps would play it, approximate a phone, laptop or car speaker, or play only the difference.</p>

<h2>Files</h2>
<ul>
  <li><b>In:</b> WAV and AIFF (including the uncompressed AIFF that Logic and other Mac apps export) are read directly at their own sample rate. FLAC, MP3, M4A and OGG are decoded by the browser at 48 kHz.</li>
  <li><b>Out:</b> <b>Download all</b> packs everything into one ZIP, or grab each file on its own. A master comes as WAV, an MP3 for sharing, CD-quality WAV and FLAC with a quality report; a mix comes as WAV and MP3 with its stems (vocals, drums, bass, music, FX). The MP3 is 320 kbps, or a little lower for long songs so it stays under 10 MB. Advanced adds other bit depths and sample rates, versions for each platform, mono, vinyl, loops, frequency layers and 5.1 / 7.1.4 surround with a headphone version.</li>
</ul>

<h2>Good to know</h2>
<ul>
  <li>Keep the MIXIT tab in front while it works. Browsers slow down background tabs, which can make a render several times longer.</li>
  <li>A 4-minute song needs roughly 0.5–1 GB of memory while rendering; big stem sessions are happiest on a desktop browser.</li>
  <li>Automatic settings are starting points worked out from measurements. Always trust your ears.</li>
  <li>Repairs are best guesses: rebuilt clipped peaks and clicks are estimates, and hum removal can touch bass notes at the same pitch. Listen before you keep a result.</li>
</ul>

<details class="tech">
<summary><h2>Technical details</h2></summary>
<h3>Mastering chain, in order</h3>
<ol>
  <li><b>Analysis.</b> BS.1770-4 / EBU R128 loudness and range, 4× oversampled true peak, crest factor, per-band correlation and mono loss, spectral slope, bandwidth, sibilance, tempo, spectrogram and a repair scan.</li>
  <li><b>Repair (opt-in).</b> Stereo delay (cross-correlation, up to 1.5 ms), clipped peaks (Burg prediction from both sides), clicks (linear-prediction residual), hum (50/60 Hz series with narrow cuts), noise (spectral subtraction from a learned floor), per-band L/R balance and a bandwidth guard.</li>
  <li><b>Gain staging and tone.</b> Input brought to about −20 LUFS; high-pass, shelves, bell, tilt, air and a broad low-mid cut.</li>
  <li><b>Reference match.</b> Loudness-normalised spectra smoothed to 1/3 octave; a capped (±8 dB) curve applied in the frequency domain. Width can be matched per band.</li>
  <li><b>2× processing (optional).</b> The chain and limiter run at twice the rate through a 143-tap linear-phase half-band filter, with a final limiter pass at the source rate.</li>
  <li><b>Dynamics.</b> Resonance control, dynamic low-mid de-box, de-esser, attack/sustain shaping, bass de-bloom, three-band Linkwitz-Riley compression, glue, and section-aware outlier control.</li>
  <li><b>Character and width.</b> An optional plate reverb on the whole song (high-passed at 300 Hz, level set against the song's loudness), 2× oversampled tape, tube or soft-clip saturation, seeded and shaped tape hiss, per-band width with correlation protection and mono bass.</li>
  <li><b>High-frequency peak reserve and limiting.</b> Peaks driven by the band above 5 kHz are reduced in that band only, then a look-ahead true-peak limiter reaches the loudness target.</li>
</ol>
<h3>Mixing engine</h3>
<ul>
  <li><b>Per stem:</b> polarity, gain, high-pass, 3-band EQ, de-esser, smooth or punch compression, width, mono bass and pan; optional YIN pitch tracking with TD-PSOLA correction.</li>
  <li><b>Balance:</b> each bus is set toward a standard loudness relationship (scaled by "How much to even out"). With a rough mix, the unprocessed buses are fitted to it frame by frame in three bands (non-negative least squares, after aligning the two in time, with per-band tone factors), and each processed bus is set to its loudness in the rough mix.</li>
  <li><b>Bus and mix:</b> vocal presence, drum transients, bass tightening, music width, glue, a vocal rider (±4 dB), ducking in the 250 Hz–5 kHz range and on kick hits, section automation from a novelty curve, reverb and delay sends, mix-bus tone and tape, an optional tonal match to the rough mix (±4 dB), glue, then headroom or a LUFS target.</li>
</ul>
<h3>Surround</h3>
<p>Master upmixes per frequency bin with a primary-plus-ambience model; Mix builds the bed from the processed buses and effect returns. Both are written as WAVE_FORMAT_EXTENSIBLE files at −18 LUFS (BS.1770 channel weights) and −1 dBTP, with a binaural version through the browser's HRTF panner. These are channel-based speaker beds, not Dolby Atmos masters.</p>
</details>
`;
