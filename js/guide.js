// Static Guide content: plain language first, technical detail folded away.

export const GUIDE_HTML = `
<h1>How MIXIT works</h1>
<p>MIXIT mixes stems and masters songs right here in your browser. Your audio is read, processed and saved on this computer. Nothing is uploaded, and there are no accounts or limits beyond your computer's memory.</p>

<h2>Easy and Advanced</h2>
<p><b>Easy</b> gives you eight plain sliders (lows, highs, punch, reverb and so on) and always comes out at streaming volume, -12 LUFS. <b>Advanced</b> opens every setting, charts, extra versions and more file types. Switch any time with the button at the top of the Mix and Master pages; each keeps its own settings.</p>
<p><b>Auto mix</b> listens to all your stems played together and scores them against goals taken from what finished songs measure: every part comes through and holds its place, no part swamps the rest, no build-up in one range, a tone within the usual slope, quiet and loud parts kept, and a mix that holds up in mono. It starts from the balance your stems came in at, makes the smallest moves that meet those goals (stem levels, a cut where sound builds up, the sliders), mixes, and shows you the score before and after. Stems that already meet the goals stay where they are, and a goal mixing can't reach is marked Check. Drums keep the dynamics they came in with, so the limiter has less to do; its work is shown as a note, not a goal. With a rough mix loaded, your rough mix decides the balance instead; if it turns out not to belong to these stems, it is set aside and the stems are judged on their own. <b>Auto master</b> measures the song, sets the sliders from what it finds, and tells you why. You can move anything afterwards and render again. Neither turns on echo, tape or hiss; those are your call. <b>Default everything</b> puts every slider back to the middle or off, where it changes nothing, and takes off Auto mix's moves. In Advanced it also turns off the automatic stages, so only the level and peak limit apply.</p>

<h2>Mixing stems</h2>
<ul>
  <li><b>Drop all the stems of one song.</b> They should start at the same point (export them from the top of your session). Names like "kick", "808", "lead vox" or "dbl L" are sorted into vocals, drums, bass, music and FX automatically; fix any that land in the wrong place.</li>
  <li><b>Your rough mix (optional).</b> Add a bounce of the same song from your session, or the finished song. MIXIT reads each stem's level in it, sets that stem to the same level, then nudges the final tone toward it. Parts you did not add don't get in the way. Your own Gain moves stay on top. Levels closer together than about 1.5 dB are left as they came, as a difference that small can't be told apart on a finished song. If the bounce does not line up with the stems, MIXIT says so and uses its own balance instead.</li>
  <li><b>What happens:</b> each stem is cleaned up and evened out, the buses are balanced, the vocal is kept steady over the music, the music makes a little room for the voice and the bass for the kick, then reverb, echo and a gentle glue finish it off. With no drums or vocals (a piece of pads, say), instrument clean-up and glue stay off, so the stems stay closer to how you made them. Music stems keep the levels they came in with.</li>
  <li><b>Pitch correction</b> (Advanced, per vocal stem) pulls sung notes toward the key while keeping the voice natural. <b>Section moves</b> find verses and hooks and add contrast between them.</li>
</ul>

<h2>Videos, ads and podcasts</h2>
<p>On the Mix page, switch <b>Song</b> to <b>Video, ad or podcast</b>. Stems are then sorted into <b>dialogue</b>, <b>music</b>, <b>effects</b> and <b>ambience</b> (names like "VO", "host", "dx", "SFX", "foley" or "room tone" are recognised).</p>
<ul>
  <li><b>Dialogue first.</b> Each voice is cleaned up (hum is found in the pauses and cut), its quiet and loud phrases are evened out, and every speaker is brought to the same level before anything else is added. Song-style warmth, chorus and pitch work are left off.</li>
  <li><b>Two or more voices.</b> The mic being spoken into stays up and the others step back, so bleed and room noise don't pile up. When two people talk at once, each drops a little and the total stays even.</li>
  <li><b>More room for words.</b> Speech peaks are spread out by rotating their phase. It sounds the same, but peaks drop 1 to 3 dB, so the limiter has less to do.</li>
  <li><b>Clean edits.</b> Mouth clicks, ticks and pops are taken out of dialogue, effects and ambience, and every place one of them starts or stops gets a short fade (1 frame unless you change it in Advanced), so no edit clicks. Words and hits keep their attack.</li>
  <li><b>Music, effects and ambience make room.</b> They step back while someone speaks, already down by the first word, and come back up in the pauses; the music also clears the range the words live in.</li>
  <li><b>Made for.</b> Pick where it's going: online video (-14 LUFS), podcast (-16), TV in Europe (EBU R128, -23, peaks -1), TV in the US (ATSC A/85, -24, peaks -2), or a streaming series or film (the dialogue itself at -27, peaks -2). These are common targets; always check the spec from your broadcaster, platform or client.</li>
  <li><b>Your video.</b> Add an MP4 or MOV and you can download it with the finished mix inside. The picture isn't re-encoded, so it stays exactly as it was. The new sound is AAC, and lines up with the picture.</li>
  <li><b>Stems.</b> Dialogue, music, effects and ambience come as separate files, plus music and effects without the dialogue, the usual file for dubbing and re-edits.</li>
  <li><b>Delivery check.</b> The result lists whether loudness and peaks are within the standard, how loud the dialogue itself is, any dead air (silence of 2 seconds or more), and how even the voices are.</li>
  <li>Mastering a finished ad or episode? On the Master page in Advanced, <b>Made for</b> sets the same standards. Drop in the video itself and you get it back with the new sound.</li>
</ul>

<h2>Sound effects and sound design</h2>
<ul>
  <li>A sound effect should keep its shape. On the Master page in Advanced, set <b>Made for</b> to <b>Sound effects and sound design</b>: there's no bus compression or limiting, sounds stay panned where you put them, each edge gets a tiny fade, and the level is set by the peak (-1 dBTP).</li>
  <li>Any file under 6 seconds is treated this way automatically, on Easy too, as a short hit has no meaningful average loudness.</li>
  <li>How loud should it be? In a mix, a sound's level is set against the dialogue, so use the Mix page. Games aim for the whole game's output rather than each file: about -24 LUFS on a TV, -18 on a handheld (ASWG-R001).</li>
</ul>

<h2>Mastering a song</h2>
<ul>
  <li>MIXIT listens to the track first and sets a starting point: brightness, muddiness cleanup, softening of harsh "s" sounds, compression and centred bass. Anything you change by hand is kept.</li>
  <li><b>Sound like this song</b> (optional): drop a finished song you like, ideally in a similar style, and the tone leans toward it. Your own tone moves stay on top. In Advanced you can average up to eight references and save them as a sound profile.</li>
  <li>Repair tools (clicks, hum, clipping, noise) are always off until you turn them on.</li>
  <li><b>Reverb</b> adds a touch of room to the whole song (the bass stays dry). <b>Vintage tape</b> adds warmth and a softer top; <b>tape hiss</b> adds faint tape noise, heard mostly in quiet parts.</li>
</ul>

<h2>Built on proven practice</h2>
<p>MIXIT follows the habits of experienced mix and mastering engineers, so the automatic choices are the ones a careful person would make.</p>
<ul>
  <li><b>Clean low end.</b> Every stem except kick and bass gets a high-pass set just below where its useful sound starts, so the bottom of the mix belongs to the kick and bass.</li>
  <li><b>Cut narrow, boost wide.</b> Problem spots (muddy, boxy, nasal, harsh) get narrow cuts only where they stand out; boosts are broad and gentle. Mastering moves stay small, and anything bigger is flagged as a job for the mix.</li>
  <li><b>The vocal comes first.</b> It is cleaned up, has its loudest peaks caught before a gentle compressor, gets light tape warmth and a faint chorus, and the music, drum snap and kick click step back a little while someone sings.</li>
  <li><b>Kick and bass take turns.</b> The bass dips only its lowest notes on each kick, and gains upper harmonics so it is still heard on phones and laptops.</li>
  <li><b>Compression suits the instrument.</b> Vocals and keys are compressed gently, percussion harder and faster, and the whole mix only lightly. Multiband compression is used only when one range really jumps out.</li>
  <li><b>Depth that stays clear.</b> Reverb and echo are rolled off at both ends, the vocal's reverb sits under its "s" sounds, the echo is de-essed and locked to the tempo, and compressors breathe with the beat.</li>
  <li><b>The song moves.</b> With section moves on, verses are a little narrower, drier and thinner and choruses wide, wet and full range.</li>
  <li><b>Masters that travel.</b> Treble boosts back off when cymbals are already loud, the limiter recovers quickly after hits and slowly on sustained parts, MP3s are made with extra headroom, and vinyl versions keep their transients.</li>
</ul>

<h2>Listening tips</h2>
<ul>
  <li>Compare at the same volume (the player does this for you). Louder nearly always sounds better, even when it isn't.</li>
  <li>Check in mono now and then (Monitor → Mono in Advanced). If something important disappears, it needs fixing.</li>
  <li>Listen on more than one system: speakers, headphones, a phone, the car. Headphones make mixes sound wider than they are.</li>
  <li>Play a song you know well that sounds the way you want, then come back to yours.</li>
  <li>Listen at a moderate level, and check quietly too; very loud or very quiet listening changes how much bass and treble you hear.</li>
  <li>Take breaks, roughly ten minutes every hour. Tired ears push you toward too much treble.</li>
  <li>When you think it's done, sleep on it and listen again in the morning.</li>
</ul>

<h2>Comparing fairly</h2>
<p>Louder nearly always sounds "better", so the player matches every version to the same loudness and keeps your place when you switch. You hear what changed, not just the volume. In Advanced you can also hear how streaming apps would play it, approximate a phone, laptop or car speaker, or play only the difference.</p>

<h2>Files</h2>
<ul>
  <li><b>In:</b> WAV and AIFF (including the uncompressed AIFF that Logic and other Mac apps export) are read directly at their own sample rate. FLAC, MP3, M4A and OGG are decoded by the browser at 48 kHz, and so is the sound in an MP4 or MOV. Surround files (5.1, 7.1) are folded down to stereo, centre included.</li>
  <li><b>Raw master</b> (Advanced): everything except the final limiter, with all its peaks, for hi-fi releases or mastering again elsewhere. Lossless services such as TIDAL play what you deliver, so 24-bit FLAC at your source's own rate is the file to send. A higher rate adds no detail.</li>
  <li><b>Alternate mixes</b> (Advanced, songs): vocal up 1 or 2 dB, bass up 1 dB, instrumental, a cappella, and a version without mix-bus processing for a mastering engineer.</li>
  <li><b>Out:</b> <b>Download all</b> packs everything into one ZIP, or grab each file on its own. A master comes as WAV, an MP3 for sharing, CD-quality WAV and FLAC with a quality report; a mix comes as WAV and MP3 with its stems (vocals, drums, bass, music, FX; or dialogue, music, effects and ambience for a video). The MP3 is 320 kbps, or a little lower for long songs so it stays under 10 MB. Advanced adds other bit depths and sample rates, versions for each platform, mono, vinyl, loops, frequency layers and 5.1 / 7.1.4 surround with a headphone version.</li>
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
  <li><b>Reference match.</b> Both spectra are compared an octave at a time, before your EQ, so your own moves stay on top. A soft-limited curve, ±3 dB at most (±2.1 dB at the default strength), is applied in the frequency domain. A steep wall in either song's highs is ignored. Width can be matched per band, up to ±2 dB of side level.</li>
  <li><b>2× processing (optional).</b> The chain and limiter run at twice the rate through a 143-tap linear-phase half-band filter, with a final limiter pass at the source rate.</li>
  <li><b>Dynamics.</b> Resonance control, dynamic low-mid de-box, de-esser, attack/sustain shaping, bass de-bloom, three-band Linkwitz-Riley compression, glue, and section-aware outlier control.</li>
  <li><b>Character and width.</b> An optional plate reverb on the whole song (high-passed at 300 Hz, level set against the song's loudness), 2× oversampled tape, tube or soft-clip saturation, seeded and shaped tape hiss, per-band width with correlation protection and mono bass.</li>
  <li><b>High-frequency peak reserve and limiting.</b> Peaks driven by the band above 5 kHz are reduced in that band only, then a look-ahead true-peak limiter reaches the loudness target.</li>
</ol>
<h3>Mixing engine</h3>
<ul>
  <li><b>Per stem:</b> polarity, gain, high-pass, 3-band EQ, de-esser, smooth or punch compression, width, mono bass and pan; optional YIN pitch tracking with TD-PSOLA correction.</li>
  <li><b>Balance:</b> each bus is set toward a standard loudness relationship (scaled by "How much to even out"). With a rough mix and two or more stems, each stem's level is read from it, once the two are lined up in time. A plain bounce lines up sample for sample, so the waveforms give the levels exactly: in seven bands, the complex gains that best rebuild it (least squares, ignoring phase, so a master's EQ does not count as a change of balance). A finished song's stems usually do not line up that closely and would read too low that way, so their levels come from how each stem's energy rises and falls with the song, in third-octave bands from 60 Hz to 5 kHz. When the stems are only part of the song, the energy cannot account for the rest, and the waveforms are used, as they ignore whatever lines up with no stem. If nothing lines up, or there is only one stem, the unprocessed buses are fitted to it frame by frame in three bands instead (non-negative least squares on energy, with per-band tone factors). Each processed bus is then set to its loudness in the rough mix. After Auto mix, each bus instead goes back to the loudness it came in at, plus the plan's moves. A slow gain over 3-second windows then puts back the rise and fall between sections that compression took out, by 6 dB at most, and the overall tone is eased back toward the stems' own, before the Lows and Highs sliders, so your moves stay on top.</li>
  <li><b>Bus and mix:</b> vocal presence, drum transients, bass tightening, music width, a broad clean-up of instrument build-up (judged an octave at a time, 1.5 dB at most, only when drums or vocals are present), glue, a vocal rider (±4 dB), ducking in the 250 Hz–5 kHz range and on kick hits, section automation from a novelty curve, reverb and delay sends, mix-bus tone and tape, an optional tonal match to the rough mix (±4 dB), glue, then headroom or a LUFS target.</li>
</ul>
<h3>Surround</h3>
<p>Master upmixes per frequency bin with a primary-plus-ambience model; Mix builds the bed from the processed buses and effect returns. Both are written as WAVE_FORMAT_EXTENSIBLE files at −18 LUFS (BS.1770 channel weights) and −1 dBTP, with a binaural version through the browser's HRTF panner. These are channel-based speaker beds, not Dolby Atmos masters.</p>
</details>
`;
