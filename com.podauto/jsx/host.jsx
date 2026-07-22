/*
 * PodAuto — ExtendScript host (runs inside Premiere Pro)
 *
 * Exposes three entry points called from the panel:
 *   PA_getSetup()          -> JSON describing the active sequence's tracks/clips
 *   PA_applyEdit(payload)  -> razors camera tracks at cut points and disables
 *                             every clip that isn't the chosen angle per segment
 *   PA_resetEdit(payload)  -> re-enables all clips on the camera tracks
 *
 * The edit is non-destructive: nothing is deleted, clips are only split and
 * disabled, so you can still ripple-fix any cut by hand afterwards.
 */

// ---------------------------------------------------------------------------
// Minimal JSON support (Premiere's ExtendScript has no native JSON object)
// ---------------------------------------------------------------------------
function PA_parse(str) {
    return eval('(' + str + ')'); // input comes only from our own panel
}

function PA_stringify(v) {
    var t = typeof v;
    if (v === null || v === undefined) return 'null';
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'string') {
        return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                      .replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
    }
    if (v instanceof Array) {
        var parts = [];
        for (var i = 0; i < v.length; i++) parts.push(PA_stringify(v[i]));
        return '[' + parts.join(',') + ']';
    }
    var props = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) props.push(PA_stringify(k) + ':' + PA_stringify(v[k]));
    }
    return '{' + props.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Sequence helpers
// ---------------------------------------------------------------------------
function PA_getFps(seq) {
    // videoFrameRate is the frame *duration* as a Time object
    var frameDur = seq.getSettings().videoFrameRate.seconds;
    return 1.0 / frameDur;
}

function PA_isDropFrame(seq) {
    // 102 = 29.97 Drop, 106 = 59.94 Drop
    var fmt = seq.getSettings().videoDisplayFormat;
    return (fmt === 102 || fmt === 106);
}

// Convert seconds to a timecode string QE's razor() accepts.
function PA_secondsToTimecode(sec, fps, drop) {
    var fpsInt = Math.round(fps);
    var totalFrames = Math.round(sec * fps);
    if (totalFrames < 0) totalFrames = 0;

    if (drop) {
        // Standard SMPTE drop-frame: re-express real frame count as a
        // drop-frame timecode label.
        var dropPerMin = Math.round(fpsInt / 15);       // 2 @29.97, 4 @59.94
        var framesPer10Min = Math.round(fps * 600);
        var framesPerMinNominal = fpsInt * 60 - dropPerMin;
        var tenMins = Math.floor(totalFrames / framesPer10Min);
        var rem = totalFrames % framesPer10Min;
        if (rem > dropPerMin) {
            totalFrames += dropPerMin * 9 * tenMins +
                           dropPerMin * Math.floor((rem - dropPerMin) / framesPerMinNominal);
        } else {
            totalFrames += dropPerMin * 9 * tenMins;
        }
    }

    var ff = totalFrames % fpsInt;
    var ss = Math.floor(totalFrames / fpsInt) % 60;
    var mm = Math.floor(totalFrames / (fpsInt * 60)) % 60;
    var hh = Math.floor(totalFrames / (fpsInt * 3600));

    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var sep = drop ? ';' : ':';
    return p2(hh) + sep + p2(mm) + sep + p2(ss) + sep + p2(ff);
}

// ---------------------------------------------------------------------------
// PA_getSetup — describe the active sequence for the panel
// ---------------------------------------------------------------------------
function PA_getSetup() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return PA_stringify({ ok: false, error: 'No active sequence. Open your podcast sequence first.' });

        var out = {
            ok: true,
            name: seq.name,
            fps: PA_getFps(seq),
            dropFrame: PA_isDropFrame(seq),
            videoTracks: [],
            audioTracks: []
        };

        var i, j, tr, clip;

        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            tr = seq.videoTracks[i];
            var vClips = [];
            for (j = 0; j < tr.clips.numItems; j++) {
                clip = tr.clips[j];
                vClips.push({
                    name: clip.name,
                    start: clip.start.seconds,
                    end: clip.end.seconds
                });
            }
            out.videoTracks.push({
                index: i,
                name: 'V' + (i + 1) + (tr.name ? ' — ' + tr.name : ''),
                clipCount: tr.clips.numItems,
                firstClip: tr.clips.numItems > 0 ? tr.clips[0].name : '',
                clips: vClips
            });
        }

        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            tr = seq.audioTracks[i];
            var aClips = [];
            for (j = 0; j < tr.clips.numItems; j++) {
                clip = tr.clips[j];
                var mediaPath = '';
                try {
                    if (clip.projectItem) mediaPath = clip.projectItem.getMediaPath();
                } catch (e1) {}
                aClips.push({
                    name: clip.name,
                    path: mediaPath,
                    start: clip.start.seconds,
                    end: clip.end.seconds,
                    inPoint: clip.inPoint.seconds
                });
            }
            out.audioTracks.push({
                index: i,
                name: 'A' + (i + 1) + (tr.name ? ' — ' + tr.name : ''),
                clipCount: tr.clips.numItems,
                firstClip: tr.clips.numItems > 0 ? tr.clips[0].name : '',
                clips: aClips
            });
        }

        return PA_stringify(out);
    } catch (e) {
        return PA_stringify({ ok: false, error: 'getSetup failed: ' + e.toString() });
    }
}

// ---------------------------------------------------------------------------
// PA_applyEdit — razor + disable
// payload: { camTracks: [videoTrackIdx...], segments: [{s, e, cam}...] }
//   cam is a video track index; segments are contiguous, in seconds.
// ---------------------------------------------------------------------------
function PA_applyEdit(payloadStr) {
    try {
        var payload = PA_parse(payloadStr);
        var seq = app.project.activeSequence;
        if (!seq) return PA_stringify({ ok: false, error: 'No active sequence.' });

        var fps = PA_getFps(seq);
        var drop = PA_isDropFrame(seq);

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return PA_stringify({ ok: false, error: 'QE could not access the sequence.' });

        var camTracks = payload.camTracks;
        var segments = payload.segments;
        var i, t;

        // 1) Collect unique cut times (segment boundaries, excluding 0 and the tail)
        var cutTimes = [];
        var seen = {};
        for (i = 1; i < segments.length; i++) {
            var key = Math.round(segments[i].s * fps); // frame-quantised
            if (!seen[key]) { seen[key] = true; cutTimes.push(segments[i].s); }
        }

        // 2) Razor every mapped camera track at every cut point
        var razorCount = 0;
        for (t = 0; t < camTracks.length; t++) {
            var qeTrack = qeSeq.getVideoTrackAt(camTracks[t]);
            if (!qeTrack) continue;
            for (i = 0; i < cutTimes.length; i++) {
                try {
                    qeTrack.razor(PA_secondsToTimecode(cutTimes[i], fps, drop));
                    razorCount++;
                } catch (eR) { /* no clip under this time on this track — fine */ }
            }
        }

        // 3) Walk fresh DOM clips and disable everything that isn't the
        //    chosen angle for its segment.
        var half = 0.5 / fps; // half a frame of tolerance
        var disabled = 0, enabled = 0;
        for (t = 0; t < camTracks.length; t++) {
            var trIdx = camTracks[t];
            var tr = seq.videoTracks[trIdx];
            for (i = 0; i < tr.clips.numItems; i++) {
                var clip = tr.clips[i];
                var mid = (clip.start.seconds + clip.end.seconds) / 2;
                var segCam = -1;
                for (var s = 0; s < segments.length; s++) {
                    if (mid >= segments[s].s - half && mid < segments[s].e + half) {
                        segCam = segments[s].cam;
                        break;
                    }
                }
                var shouldDisable = (segCam !== -1 && segCam !== trIdx);
                try {
                    clip.disabled = shouldDisable;
                    if (shouldDisable) disabled++; else enabled++;
                } catch (eD) {}
            }
        }

        return PA_stringify({ ok: true, razors: razorCount, disabled: disabled, enabled: enabled });
    } catch (e) {
        return PA_stringify({ ok: false, error: 'applyEdit failed: ' + e.toString() });
    }
}

// ---------------------------------------------------------------------------
// PA_resetEdit — re-enable every clip on the given video tracks
// payload: { camTracks: [videoTrackIdx...] }
// ---------------------------------------------------------------------------
function PA_resetEdit(payloadStr) {
    try {
        var payload = PA_parse(payloadStr);
        var seq = app.project.activeSequence;
        if (!seq) return PA_stringify({ ok: false, error: 'No active sequence.' });

        var count = 0;
        for (var t = 0; t < payload.camTracks.length; t++) {
            var tr = seq.videoTracks[payload.camTracks[t]];
            if (!tr) continue;
            for (var i = 0; i < tr.clips.numItems; i++) {
                try { tr.clips[i].disabled = false; count++; } catch (e1) {}
            }
        }
        return PA_stringify({ ok: true, reEnabled: count });
    } catch (e) {
        return PA_stringify({ ok: false, error: 'resetEdit failed: ' + e.toString() });
    }
}
