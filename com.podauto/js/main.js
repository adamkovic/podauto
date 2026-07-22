/*
 * PodAuto — panel logic
 *
 * Pipeline:
 *   1. Scan the active sequence via ExtendScript (tracks, clips, media paths)
 *   2. User maps: speaker mic (audio track) -> camera (video track)
 *   3. Decode each mic's source file with ffmpeg -> per-50ms RMS envelope
 *   4. Detect who is speaking each frame, build camera segments with
 *      hysteresis, min/max shot rules, group shots and variation
 *   5. Send the segment list back to ExtendScript, which razors the camera
 *      tracks and disables every non-active angle (non-destructive)
 */

'use strict';

// --- CEP bridge -------------------------------------------------------------
function evalJSX(script) {
  return new Promise(function (resolve) {
    window.__adobe_cep__.evalScript(script, resolve);
  });
}

var nodeRequire = (window.cep_node && window.cep_node.require) ? window.cep_node.require : require;
var cp = nodeRequire('child_process');
var fs = nodeRequire('fs');

// --- constants ---------------------------------------------------------------
var HOP = 0.05;              // envelope resolution: 50 ms
var SAMPLE_RATE = 8000;      // decode rate (plenty for level detection)
var FRAME_SAMPLES = SAMPLE_RATE * HOP;
var CONFIRM_SEC = 0.35;      // new speaker must dominate this long before we cut
var GAP_FILL_SEC = 0.30;     // bridge short pauses inside speech
var HANGOVER_SEC = 0.30;     // keep "speaking" flag on briefly after speech ends

// --- state -------------------------------------------------------------------
var state = {
  setup: null,        // result of PA_getSetup
  plan: null,         // computed segments
  camTracks: [],      // video track indices used by the current plan
  envelopeCache: {}   // mediaPath -> Float32Array of dB values
};

// --- tiny DOM helpers ----------------------------------------------------------
function $(id) { return document.getElementById(id); }
function log(msg) {
  var el = $('log');
  el.textContent += '\n' + msg;
  el.scrollTop = el.scrollHeight;
}
function num(id) { return parseFloat($(id).value); }

// --- ffmpeg ------------------------------------------------------------------
function findFfmpeg() {
  var custom = $('ffmpegPath').value.trim();
  var candidates = custom ? [custom] : [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ];
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
  }
  try {
    var p = cp.execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch (e) {}
  return null;
}

// Decode a media file to a mono dB-RMS envelope, one value per HOP seconds.
function decodeEnvelope(ffmpeg, mediaPath) {
  return new Promise(function (resolve, reject) {
    if (state.envelopeCache[mediaPath]) return resolve(state.envelopeCache[mediaPath]);

    var args = ['-v', 'error', '-i', mediaPath,
                '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    var proc = cp.spawn(ffmpeg, args);
    var chunks = [];
    var errBuf = '';
    proc.stdout.on('data', function (d) { chunks.push(d); });
    proc.stderr.on('data', function (d) { errBuf += d; });
    proc.on('error', function (e) { reject(new Error('ffmpeg spawn failed: ' + e.message)); });
    proc.on('close', function (code) {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error('ffmpeg failed on ' + mediaPath + ': ' + errBuf.slice(0, 300)));
      }
      var pcm = Buffer.concat(chunks);
      var nSamples = Math.floor(pcm.length / 2);
      var nFrames = Math.floor(nSamples / FRAME_SAMPLES);
      var env = new Float32Array(nFrames);
      for (var f = 0; f < nFrames; f++) {
        var sum = 0;
        var base = f * FRAME_SAMPLES;
        for (var s = 0; s < FRAME_SAMPLES; s++) {
          var v = pcm.readInt16LE((base + s) * 2) / 32768;
          sum += v * v;
        }
        var rms = Math.sqrt(sum / FRAME_SAMPLES);
        env[f] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
      }
      state.envelopeCache[mediaPath] = env;
      resolve(env);
    });
  });
}

// --- sequence scan / mapping UI -------------------------------------------------
function scanSequence() {
  log('Scanning active sequence…');
  evalJSX('PA_getSetup()').then(function (raw) {
    var setup;
    try { setup = JSON.parse(raw); }
    catch (e) { return log('ERROR: could not parse sequence info: ' + raw); }
    if (!setup.ok) return log('ERROR: ' + setup.error);

    state.setup = setup;
    state.plan = null;
    $('btnApply').disabled = true;
    $('seqInfo').textContent = setup.name + ' · ' + setup.fps.toFixed(2) + ' fps';
    log('Found "' + setup.name + '": ' + setup.videoTracks.length + ' video tracks, ' +
        setup.audioTracks.length + ' audio tracks.');

    buildMappingUI(setup);
    $('btnGenerate').disabled = false;
    $('btnReset').disabled = false;
  });
}

function trackOptions(tracks, withNone) {
  var html = withNone ? '<option value="-1">none</option>' : '';
  tracks.forEach(function (t) {
    if (t.clipCount === 0) return;
    var label = t.name + (t.firstClip ? ' (' + t.firstClip + ')' : '');
    html += '<option value="' + t.index + '">' + label + '</option>';
  });
  return html;
}

function addSpeakerRow(preselectAudio, preselectVideo) {
  var body = $('mapBody');
  var n = body.children.length;
  if (n >= 8) return log('Max 8 speakers.');
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td>' + (n + 1) + '</td>' +
    '<td><select class="micSel">' + trackOptions(state.setup.audioTracks, false) + '</select></td>' +
    '<td><select class="camSel">' + trackOptions(state.setup.videoTracks, false) + '</select></td>' +
    '<td><span class="rowdel" title="remove">×</span></td>';
  body.appendChild(tr);
  if (preselectAudio !== undefined) tr.querySelector('.micSel').value = preselectAudio;
  if (preselectVideo !== undefined) tr.querySelector('.camSel').value = preselectVideo;
  tr.querySelector('.rowdel').onclick = function () { tr.remove(); };
}

function buildMappingUI(setup) {
  $('mapBody').innerHTML = '';
  $('mapTable').style.display = '';
  $('btnAddSpeaker').style.display = '';
  $('wideRow').style.display = '';
  $('wideCam').innerHTML = trackOptions(setup.videoTracks, true);

  // Best-guess default: pair audio tracks with video tracks in order.
  var aWith = setup.audioTracks.filter(function (t) { return t.clipCount > 0; });
  var vWith = setup.videoTracks.filter(function (t) { return t.clipCount > 0; });
  var pairs = Math.min(aWith.length, vWith.length, 8);
  for (var i = 0; i < pairs; i++) addSpeakerRow(aWith[i].index, vWith[i].index);

  // If there's one more camera than speakers, guess it's the wide shot (topmost track).
  if (vWith.length === pairs + 1) {
    $('wideCam').value = vWith[vWith.length - 1].index;
    // Re-pair: assume the extra camera is the last one; keep defaults simple.
  }
  log('Mapped ' + pairs + ' speaker(s) by default — check the pairing before analyzing.');
}

function readMappings() {
  var rows = $('mapBody').children;
  var mappings = [];
  var usedCams = {};
  for (var i = 0; i < rows.length; i++) {
    var mic = parseInt(rows[i].querySelector('.micSel').value, 10);
    var cam = parseInt(rows[i].querySelector('.camSel').value, 10);
    if (usedCams[cam]) { log('WARNING: camera V' + (cam + 1) + ' is mapped to more than one speaker.'); }
    usedCams[cam] = true;
    mappings.push({ mic: mic, cam: cam });
  }
  return mappings;
}

// --- analysis ------------------------------------------------------------------
function buildSpeakerTimeline(mapping, seqFrames) {
  // Returns Float32Array of dB across *sequence* time for this speaker's mic,
  // assembled from every clip on that audio track (handles trimmed/moved clips).
  var timeline = new Float32Array(seqFrames).fill(-120);
  var track = state.setup.audioTracks[mapping.mic];
  track.clips.forEach(function (clip) {
    var env = clip.path ? state.envelopeCache[clip.path] : null;
    if (!env) return;
    var f0 = Math.max(0, Math.floor(clip.start / HOP));
    var f1 = Math.min(seqFrames, Math.floor(clip.end / HOP));
    for (var f = f0; f < f1; f++) {
      var mediaT = clip.inPoint + (f * HOP - clip.start);
      var mi = Math.floor(mediaT / HOP);
      if (mi >= 0 && mi < env.length) timeline[f] = env[mi];
    }
  });
  return timeline;
}

function percentile(arr, p) {
  var vals = Array.prototype.filter.call(arr, function (v) { return v > -100; }).sort(function (a, b) { return a - b; });
  if (!vals.length) return -120;
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
}

function computeSpeechFlags(timeline, sensitivityDb) {
  var floor = percentile(timeline, 0.15);
  var thr = Math.max(floor + sensitivityDb, -55);
  var n = timeline.length;
  var flags = new Uint8Array(n);
  for (var i = 0; i < n; i++) flags[i] = timeline[i] > thr ? 1 : 0;

  // Fill short gaps (pauses mid-sentence)
  var gapFrames = Math.round(GAP_FILL_SEC / HOP);
  var i0 = -1;
  for (var i = 0; i < n; i++) {
    if (flags[i]) {
      if (i0 >= 0 && i - i0 <= gapFrames) for (var j = i0; j < i; j++) flags[j] = 1;
      i0 = i + 1;
    }
  }
  // Hangover: extend speech tails
  var hang = Math.round(HANGOVER_SEC / HOP);
  var carry = 0;
  for (var i = 0; i < n; i++) {
    if (flags[i]) carry = hang;
    else if (carry > 0) { flags[i] = 1; carry--; }
  }
  return { flags: flags, threshold: thr, floor: floor };
}

function generatePlan() {
  var setup = state.setup;
  if (!setup) return log('Scan the sequence first.');
  var mappings = readMappings();
  if (mappings.length < 2) return log('ERROR: map at least 2 speakers (mic + camera each).');

  var ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return log('ERROR: ffmpeg not found. Install it with:  brew install ffmpeg\n' +
               'or type its full path into the ffmpeg path field.');
  }
  log('Using ffmpeg: ' + ffmpeg);

  // Collect unique media paths for all mapped mic tracks
  var paths = {};
  mappings.forEach(function (m) {
    setup.audioTracks[m.mic].clips.forEach(function (c) { if (c.path) paths[c.path] = true; });
  });
  var pathList = Object.keys(paths);
  if (!pathList.length) return log('ERROR: mapped audio tracks have no readable media files.');

  $('btnGenerate').disabled = true;
  log('Decoding ' + pathList.length + ' audio file(s)…');

  var decodeAll = pathList.reduce(function (chain, p) {
    return chain.then(function () {
      log('  · ' + p.split('/').pop());
      return decodeEnvelope(ffmpeg, p);
    });
  }, Promise.resolve());

  decodeAll.then(function () {
    log('Analyzing speakers…');
    var plan = computeSegments(mappings);
    state.plan = plan.segments;
    state.camTracks = plan.camTracks;
    renderPreview(plan);
    $('btnApply').disabled = false;
    $('btnGenerate').disabled = false;
  }).catch(function (e) {
    log('ERROR: ' + e.message);
    $('btnGenerate').disabled = false;
  });
}

function computeSegments(mappings) {
  var setup = state.setup;
  var fps = setup.fps;

  // Sequence extent = end of the last mapped video/audio clip
  var seqEnd = 0;
  mappings.forEach(function (m) {
    setup.videoTracks[m.cam].clips.forEach(function (c) { seqEnd = Math.max(seqEnd, c.end); });
    setup.audioTracks[m.mic].clips.forEach(function (c) { seqEnd = Math.max(seqEnd, c.end); });
  });
  var nFrames = Math.ceil(seqEnd / HOP);

  var sensitivity = num('sensitivity');
  var minShot = num('minShot');
  var maxShot = num('maxShot');
  var variation = num('variation') / 100;
  var groupTrigger = num('groupTrigger');
  var groupDur = num('groupDur');
  var frameOffset = num('frameOffset') / fps;
  var wideCam = parseInt($('wideCam').value, 10); // -1 = none

  // Per-speaker envelopes + speech flags across sequence time
  var speakers = mappings.map(function (m) {
    var tl = buildSpeakerTimeline(m, nFrames);
    var sp = computeSpeechFlags(tl, sensitivity);
    log('  · mic A' + (m.mic + 1) + ': noise floor ' + sp.floor.toFixed(1) +
        ' dB, speech threshold ' + sp.threshold.toFixed(1) + ' dB');
    return { cam: m.cam, timeline: tl, flags: sp.flags };
  });

  var WIDE = -2;
  var confirmFrames = Math.round(CONFIRM_SEC / HOP);
  var groupFrames = Math.round(groupTrigger / HOP);

  // Frame-by-frame desired target (speaker index, or WIDE)
  var desired = new Int8Array(nFrames);
  var crosstalkRun = 0;
  var last = 0;
  for (var f = 0; f < nFrames; f++) {
    var active = [];
    for (var s = 0; s < speakers.length; s++) if (speakers[s].flags[f]) active.push(s);
    if (active.length >= 2) crosstalkRun++; else crosstalkRun = 0;

    var d;
    if (wideCam >= 0 && crosstalkRun >= groupFrames) {
      d = WIDE;
    } else if (active.length === 0) {
      d = last; // silence: hold the current shot
    } else {
      var best = active[0];
      for (var a = 1; a < active.length; a++) {
        if (speakers[active[a]].timeline[f] > speakers[best].timeline[f]) best = active[a];
      }
      d = best;
    }
    desired[f] = d;
    last = d;
  }

  // Hysteresis state machine -> raw segments
  var segments = [];
  var cur = desired[0];
  var segStart = 0;
  var pending = null, pendCount = 0, pendStart = 0;
  var minFrames = Math.round(minShot / HOP);

  for (var f = 1; f < nFrames; f++) {
    var d = desired[f];
    if (d === cur) { pending = null; pendCount = 0; continue; }
    if (d !== pending) { pending = d; pendCount = 1; pendStart = f; }
    else pendCount++;

    var needed = (d === WIDE) ? 1 : confirmFrames; // group shots trigger immediately
    if (pendCount >= needed && (pendStart - segStart) >= minFrames) {
      segments.push({ s: segStart * HOP, e: pendStart * HOP, cam: cur });
      cur = d;
      segStart = pendStart;
      pending = null; pendCount = 0;
    }
  }
  segments.push({ s: segStart * HOP, e: nFrames * HOP, cam: cur });

  // Enforce group shot duration: extend WIDE segments to at least groupDur
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].cam !== WIDE) continue;
    var need = groupDur - (segments[i].e - segments[i].s);
    if (need > 0 && i + 1 < segments.length) {
      var take = Math.min(need, segments[i + 1].e - segments[i + 1].s - minShot);
      if (take > 0) { segments[i].e += take; segments[i + 1].s += take; }
    }
  }
  // Drop segments that collapsed
  segments = segments.filter(function (g) { return g.e - g.s > 0.01; });

  // Max shot length: split long segments with a cutaway (wide if available,
  // otherwise the most energetic *other* speaker — a listener reaction shot).
  var out = [];
  segments.forEach(function (seg) {
    var remainStart = seg.s;
    while (seg.e - remainStart > maxShot * (1 + variation)) {
      var jitter = 1 + (Math.random() * 2 - 1) * variation;
      var cutAt = remainStart + maxShot * jitter;
      var cutawayLen = Math.max(minShot, 2.0);
      if (cutAt + cutawayLen + minShot > seg.e) break;

      var cutawayCam;
      if (wideCam >= 0 && seg.cam !== WIDE) {
        cutawayCam = WIDE;
      } else {
        cutawayCam = pickReactionCam(speakers, seg.cam, cutAt, cutawayLen);
        if (cutawayCam === null) break;
      }
      out.push({ s: remainStart, e: cutAt, cam: seg.cam });
      out.push({ s: cutAt, e: cutAt + cutawayLen, cam: cutawayCam });
      remainStart = cutAt + cutawayLen;
    }
    out.push({ s: remainStart, e: seg.e, cam: seg.cam });
  });

  // Resolve WIDE + speaker indices to actual video track indices,
  // merge consecutive same-camera segments, apply frame offset + snapping.
  var final = [];
  out.forEach(function (seg) {
    var camTrack = seg.cam === WIDE ? wideCam : speakers[seg.cam].cam;
    if (final.length && final[final.length - 1].cam === camTrack) {
      final[final.length - 1].e = seg.e;
    } else {
      final.push({ s: seg.s, e: seg.e, cam: camTrack });
    }
  });
  final.forEach(function (seg, i) {
    if (i > 0) {
      var t = Math.round((seg.s + frameOffset) * fps) / fps;
      seg.s = t;
      final[i - 1].e = t;
    }
  });

  var camTracks = mappings.map(function (m) { return m.cam; });
  if (wideCam >= 0 && camTracks.indexOf(wideCam) === -1) camTracks.push(wideCam);

  return { segments: final, camTracks: camTracks, duration: seqEnd };
}

function pickReactionCam(speakers, excludeSpeaker, t0, dur) {
  var f0 = Math.floor(t0 / HOP), f1 = Math.floor((t0 + dur) / HOP);
  var best = null, bestE = -Infinity;
  for (var s = 0; s < speakers.length; s++) {
    if (s === excludeSpeaker) continue;
    var e = 0, n = 0;
    for (var f = f0; f < f1 && f < speakers[s].timeline.length; f++) { e += speakers[s].timeline[f]; n++; }
    if (n && e / n > bestE) { bestE = e / n; best = s; }
  }
  return best;
}

// --- preview / apply / reset ------------------------------------------------------
function fmtT(sec) {
  var m = Math.floor(sec / 60), s = (sec % 60).toFixed(1);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function renderPreview(plan) {
  var segs = plan.segments;
  var totalDur = plan.duration;
  var avg = totalDur / segs.length;
  $('preview').innerHTML =
    '<b>' + segs.length + '</b> shots over <b>' + fmtT(totalDur) + '</b> · avg shot <b>' +
    avg.toFixed(1) + 's</b> · ' + (segs.length - 1) + ' cuts';
  log('Plan: ' + segs.length + ' shots, avg ' + avg.toFixed(1) + 's. First cuts:');
  segs.slice(0, 8).forEach(function (g) {
    log('  ' + fmtT(g.s) + ' – ' + fmtT(g.e) + '  →  V' + (g.cam + 1));
  });
  if (segs.length > 8) log('  … (' + (segs.length - 8) + ' more)');
  log('Review settings, then hit “Apply Edit”.');
}

function applyEdit() {
  if (!state.plan) return;
  $('btnApply').disabled = true;
  log('Applying edit to timeline (razor + disable)…');
  var payload = JSON.stringify({ camTracks: state.camTracks, segments: state.plan });
  evalJSX('PA_applyEdit(' + JSON.stringify(payload) + ')').then(function (raw) {
    var res;
    try { res = JSON.parse(raw); } catch (e) { return log('ERROR: ' + raw); }
    if (!res.ok) return log('ERROR: ' + res.error);
    log('Done ✂  ' + res.razors + ' razor cuts, ' + res.disabled + ' clips hidden, ' +
        res.enabled + ' clips active.');
    log('The edit is non-destructive — disabled clips are still there. Use “Reset Edit” to undo.');
    $('btnApply').disabled = false;
  });
}

function resetEdit() {
  var camTracks = state.camTracks.length ? state.camTracks :
    (state.setup ? state.setup.videoTracks.map(function (t) { return t.index; }) : []);
  if (!camTracks.length) return;
  var payload = JSON.stringify({ camTracks: camTracks });
  evalJSX('PA_resetEdit(' + JSON.stringify(payload) + ')').then(function (raw) {
    var res;
    try { res = JSON.parse(raw); } catch (e) { return log('ERROR: ' + raw); }
    if (!res.ok) return log('ERROR: ' + res.error);
    log('Re-enabled ' + res.reEnabled + ' clips. (Razor cuts remain — undo in Premiere or ignore them.)');
  });
}

// --- wire up -----------------------------------------------------------------
$('btnScan').onclick = scanSequence;
$('btnAddSpeaker').onclick = function () { addSpeakerRow(); };
$('btnGenerate').onclick = generatePlan;
$('btnApply').onclick = applyEdit;
$('btnReset').onclick = resetEdit;
