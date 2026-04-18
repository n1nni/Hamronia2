/* ═══════════════════════════════════════════════════
   Harmonia – Score Editor
   - Image upload + OpenCV staff-line anchor detection
   - OSMD multi-system rendering (respects new-system)
   - Note dots projected from MusicXML onto the original
     image via per-system affine (staff-line anchors)
   - Note editor edits the MusicXML directly
═══════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────
let osmd         = null;
let currentXML   = '';
let originalXML  = '';
let xmlDoc       = null;
let xmlNoteIndex = {};      // "partIdx-measureNum-noteIdx" → <note> DOM
let allNotes     = [];      // [{absX, absY, partIdx, measureNum, noteIdx, sysIdx, staffIdx, isRest}, …]
let currentZoom  = 1.0;
let selectedDot  = null;    // currently selected .ndot element
let selectedNoteIdx = -1;   // index into allNotes

// ── Alignment anchors ─────────────────────────────────
let imgSystems  = [];       // backend: systems[].staves[].{top_y, bot_y, left_x, right_x}
let osmdSystems = [];       // OSMD:    systems[].staves[].{topY,  botY,  leftX,  rightX}
let imgNaturalW = 0;
let imgNaturalH = 0;

// ══════════════════════════════════════════════════════
//  UPLOAD SCREEN
// ══════════════════════════════════════════════════════
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) uploadImage(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadImage(fileInput.files[0]);
});

async function uploadImage(file) {
  toast('Uploading image…');
  const fd = new FormData();
  fd.append('image', file);
  const res  = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.error) { toast('Upload failed: ' + data.error); return; }

  // Switch to main screen
  document.getElementById('upload-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');

  toast('Detecting staff lines…');
  const detRes = await fetch('/api/detect_staves', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename: data.filename }),
  });
  const det = await detRes.json();
  if (det.error) { toast('Staff detection failed: ' + det.error); return; }
  imgSystems  = det.systems       || [];
  imgNaturalW = det.image_width   || 0;
  imgNaturalH = det.image_height  || 0;

  // Display image
  const img = document.getElementById('score-img');
  img.src = data.url;
  img.onload = () => placeDots();

  await initScore();
}

// Reset UI → upload screen (so user can load a different image)
function showUploadScreen() {
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('upload-screen').classList.remove('hidden');
  document.getElementById('file-input').value = '';
  imgSystems = []; osmdSystems = []; allNotes = [];
  const layer = document.getElementById('dot-layer');
  if (layer) layer.innerHTML = '';
  closeEditor();
}

// ══════════════════════════════════════════════════════
//  OSMD INIT & RENDER
// ══════════════════════════════════════════════════════
async function initScore() {
  toast('Loading score…');
  const res = await fetch('/api/score');
  currentXML  = await res.text();
  originalXML = currentXML;
  parseXMLModel();

  osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd-container', {
    autoResize:       false,
    drawTitle:        true,
    drawSubtitle:     false,
    drawCredits:      true,
    pageFormat:       'Endless',    // height shrinks to content — no blank page space
    newSystemFromXML: true,         // respect <print new-system="yes">
    newPageFromXML:   false,
    pageBackgroundColor: '#eeede8',
    renderSingleHorizontalStaffline: false,
  });

  // Do not render time signature — source has senza-misura but OSMD falls back to 4/4
  osmd.EngravingRules.RenderTimeSignatures = false;

  // Both systems get stretched to same width → uniform look
  osmd.EngravingRules.StretchLastSystemLine = true;

  // ── Tight vertical spacing: shrink distances between staves & systems ──
  osmd.EngravingRules.StaffDistance                 = 0.5;   // between staves within an instrument
  osmd.EngravingRules.BetweenStaffDistance          = 0.5;   // between staves in the same system
  osmd.EngravingRules.MinimumStaffLineDistance      = 0.5;
  osmd.EngravingRules.MinSkyBottomDistBetweenStaves = 0.0;
  osmd.EngravingRules.MinSkyBottomDistBetweenSystems = 0.0;
  osmd.EngravingRules.MinimumDistanceBetweenSystems = 0.5;
  osmd.EngravingRules.SystemDistance                = 1.0;   // between the 2 systems
  osmd.EngravingRules.InstrumentLabelTextHeight     = 1.0;

  await renderScore(currentXML);
}

async function renderScore(xmlStr) {
  toast('Rendering…');
  await osmd.load(xmlStr);
  // Tune vertical spacing to mirror the original photo's proportions before render.
  applyPhotoDistancesToOsmd();
  osmd.zoom = currentZoom;
  await osmd.render();
  buildNoteRegistry();
  placeDots();           // re-place whenever score re-renders
  toast('');
}

/* Match OSMD's staff / system gaps to the proportions measured from the photo.
   OSMD works in units where 4 units ≈ one staff height (5 lines).  We express
   the photo's inter-staff and inter-system gaps as multiples of staff-height
   and feed them into EngravingRules. */
function applyPhotoDistancesToOsmd() {
  if (!osmd || !imgSystems.length) return;

  const staffHeights   = [];
  const interStaffGaps = [];
  const interSysGaps   = [];

  imgSystems.forEach(sys => {
    sys.staves.forEach(st => staffHeights.push(st.bot_y - st.top_y));
    for (let i = 0; i < sys.staves.length - 1; i++) {
      interStaffGaps.push(sys.staves[i + 1].top_y - sys.staves[i].bot_y);
    }
  });
  for (let i = 0; i < imgSystems.length - 1; i++) {
    const prev = imgSystems[i].staves.at(-1);
    const next = imgSystems[i + 1].staves[0];
    interSysGaps.push(next.top_y - prev.bot_y);
  }

  const med = a => { if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  const staffH = med(staffHeights);
  if (staffH < 1) return;

  const UNITS_PER_STAFF = 4;
  const betweenStaff = interStaffGaps.length
    ? (med(interStaffGaps) / staffH) * UNITS_PER_STAFF
    : 4;
  const systemDist = interSysGaps.length
    ? (med(interSysGaps) / staffH) * UNITS_PER_STAFF
    : 8;

  const er = osmd.EngravingRules;
  er.StaffDistance                   = betweenStaff;
  er.BetweenStaffDistance            = betweenStaff;
  er.MinimumStaffLineDistance        = betweenStaff;
  er.MinSkyBottomDistBetweenStaves   = betweenStaff * 0.1;
  er.SystemDistance                  = systemDist;
  er.MinimumDistanceBetweenSystems   = systemDist * 0.7;
  er.MinSkyBottomDistBetweenSystems  = 0;
}

// ══════════════════════════════════════════════════════
//  XML MODEL
// ══════════════════════════════════════════════════════
function parseXMLModel() {
  const parser = new DOMParser();
  xmlDoc = parser.parseFromString(currentXML, 'application/xml');
  xmlNoteIndex = {};
  xmlDoc.querySelectorAll('score-partwise > part').forEach((part, pi) => {
    part.querySelectorAll('measure').forEach(meas => {
      const mn = parseInt(meas.getAttribute('number'), 10);
      meas.querySelectorAll('note').forEach((note, ni) => {
        xmlNoteIndex[`${pi}-${mn}-${ni}`] = note;
      });
    });
  });
}

function getXMLNote(pi, mn, ni) {
  return xmlNoteIndex[`${pi}-${mn}-${ni}`] || null;
}

// ══════════════════════════════════════════════════════
//  NOTE REGISTRY + OSMD SYSTEM/STAFF ANCHORS
// ══════════════════════════════════════════════════════
function buildNoteRegistry() {
  allNotes    = [];
  osmdSystems = [];
  const page  = osmd?.GraphicSheet?.MusicPages?.[0];
  if (!page?.MusicSystems) return;

  page.MusicSystems.forEach((sys, sysIdx) => {
    // Per-staff bounding boxes for this system (OSMD units).
    const staves = (sys.StaffLines || []).map(sl => {
      const p  = sl.PositionAndShape.AbsolutePosition;
      const sz = sl.PositionAndShape.Size;
      return {
        leftX:  p.x,
        topY:   p.y,
        rightX: p.x + sz.width,
        botY:   p.y + sz.height,
      };
    });
    osmdSystems.push({ staves });

    // Walk measures *within this system* so we can tag every note with sysIdx.
    (sys.GraphicalMeasures || []).forEach(measuresAcrossStaves => {
      measuresAcrossStaves.forEach((measure, staffIdx) => {
        if (!measure) return;
        const mn = measure.parentSourceMeasure?.measureNumber ?? 0;
        let ni = 0;
        (measure.staffEntries || []).forEach(se => {
          (se.graphicalVoiceEntries || []).forEach(gve => {
            (gve.notes || []).forEach(gn => {
              const pos = gn.PositionAndShape?.AbsolutePosition;
              if (!pos) { ni++; return; }
              allNotes.push({
                absX:       pos.x,
                absY:       pos.y,
                partIdx:    staffIdx,
                measureNum: mn,
                noteIdx:    ni,
                sysIdx:     sysIdx,
                staffIdx:   staffIdx,
                isRest:     !!gn.sourceNote?.isRest,
              });
              ni++;
            });
          });
        });
      });
    });
  });
}

// ══════════════════════════════════════════════════════
//  DOT OVERLAY  (on original image, via staff-anchor affine)
// ══════════════════════════════════════════════════════

/* Project one OSMD-unit (x,y) onto the uploaded image's natural pixels.
   Per-system horizontal scale + per-staff vertical scale derived from the
   matched staff-line bounding boxes. */
function projectOsmdToImage(note) {
  const osmdSys = osmdSystems[note.sysIdx];
  const imgSys  = imgSystems[note.sysIdx];
  if (!osmdSys || !imgSys) return null;

  const osmdSt = osmdSys.staves[note.staffIdx];
  const imgSt  = imgSys.staves[note.staffIdx];
  if (!osmdSt || !imgSt) return null;

  // System-wide horizontal extent
  const oL = Math.min(...osmdSys.staves.map(s => s.leftX));
  const oR = Math.max(...osmdSys.staves.map(s => s.rightX));
  const iL = Math.min(...imgSys.staves.map(s => s.left_x));
  const iR = Math.max(...imgSys.staves.map(s => s.right_x));
  if (oR - oL < 1e-3) return null;

  const xRatio = (note.absX - oL) / (oR - oL);
  const imgX   = iL + xRatio * (iR - iL);

  // Per-staff vertical extent (handles page skew between staves)
  const oH = osmdSt.botY - osmdSt.topY;
  const iH = imgSt.bot_y - imgSt.top_y;
  if (oH < 1e-3) return null;
  const yRatio = (note.absY - osmdSt.topY) / oH;
  const imgY   = imgSt.top_y + yRatio * iH;

  return { x: imgX, y: imgY };
}

function placeDots() {
  const img   = document.getElementById('score-img');
  const layer = document.getElementById('dot-layer');
  layer.innerHTML = '';

  if (!img.complete || !img.naturalWidth) return;
  if (allNotes.length === 0 || imgSystems.length === 0) return;

  // Scale from image's natural px (what the backend returned) to the rendered size.
  const dispW  = img.offsetWidth;
  const dispH  = img.offsetHeight;
  const scaleX = dispW / img.naturalWidth;
  const scaleY = dispH / img.naturalHeight;

  allNotes.forEach((n, idx) => {
    const p = projectOsmdToImage(n);
    if (!p) return;

    const dot = document.createElement('div');
    dot.className   = 'ndot above';     // single color — projected, no confidence
    dot.style.left  = (p.x * scaleX) + 'px';
    dot.style.top   = (p.y * scaleY) + 'px';
    dot.dataset.idx = idx;
    dot.addEventListener('click', () => onDotClick(dot, idx));
    layer.appendChild(dot);
  });
}

// ══════════════════════════════════════════════════════
//  NOTE SELECTION & EDITOR
// ══════════════════════════════════════════════════════
function onDotClick(dot, idx) {
  if (selectedDot) selectedDot.classList.remove('selected');
  selectedDot      = dot;
  selectedNoteIdx  = idx;
  dot.classList.add('selected');
  openEditor(idx);
}

function openEditor(idx) {
  const n     = allNotes[idx];
  const xmlN  = getXMLNote(n.partIdx, n.measureNum, n.noteIdx);
  const edEl  = document.getElementById('note-editor');
  const fields = document.getElementById('editor-fields');

  if (!xmlN) { toast('Note not found in XML'); return; }

  const isRest = !!xmlN.querySelector('rest');
  const step   = xmlN.querySelector('pitch > step')?.textContent  || 'C';
  const octave = xmlN.querySelector('pitch > octave')?.textContent || '4';
  const type   = xmlN.querySelector('type')?.textContent           || 'quarter';
  const alter  = xmlN.querySelector('pitch > alter')?.textContent;
  const acc    = alter === '1' ? 'sharp' : alter === '-1' ? 'flat' : alter === '0' ? 'natural' : 'none';
  const stem   = xmlN.querySelector('stem')?.textContent || '';
  const lyric  = xmlN.querySelector('lyric > text')?.textContent ?? null;

  document.getElementById('editor-title').textContent =
    `Editing: ${isRest ? 'Rest' : step + octave} (${type})  ·  Part ${n.partIdx + 1}  ·  Measure ${n.measureNum}`;

  fields.innerHTML = `
    <div class="ef-meta">
      Part ${n.partIdx + 1}<br>Measure ${n.measureNum}
    </div>

    ${!isRest ? `
    <div class="ef-group">
      <label>Note</label>
      <select id="ed-step">
        ${['C','D','E','F','G','A','B'].map(s=>`<option${s===step?' selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="ef-group">
      <label>Accidental</label>
      <select id="ed-acc">
        <option value="none"   ${acc==='none'   ?'selected':''}>None</option>
        <option value="sharp"  ${acc==='sharp'  ?'selected':''}>♯ Sharp</option>
        <option value="flat"   ${acc==='flat'   ?'selected':''}>♭ Flat</option>
        <option value="natural"${acc==='natural'?'selected':''}>♮ Natural</option>
      </select>
    </div>
    <div class="ef-group">
      <label>Octave</label>
      <select id="ed-oct">
        ${['2','3','4','5','6'].map(o=>`<option${o===octave?' selected':''}>${o}</option>`).join('')}
      </select>
    </div>` : '<span style="color:#446;font-style:italic;font-size:13px">Rest note</span>'}

    <div class="ef-group">
      <label>Duration</label>
      <select id="ed-type">
        ${['whole','half','quarter','eighth','16th','32nd'].map(t=>`<option${t===type?' selected':''}>${t}</option>`).join('')}
      </select>
    </div>

    ${stem ? `
    <div class="ef-group">
      <label>Stem</label>
      <select id="ed-stem">
        <option value="up"   ${stem==='up'  ?'selected':''}>Up</option>
        <option value="down" ${stem==='down'?'selected':''}>Down</option>
      </select>
    </div>` : ''}

    ${lyric !== null ? `
    <div class="ef-group">
      <label>Lyric</label>
      <input type="text" id="ed-lyric" value="${esc(lyric)}" style="width:110px">
    </div>` : ''}

    <div class="editor-actions">
      <button id="apply-btn"  onclick="applyEdit()">Apply</button>
      <button id="cancel-btn" onclick="closeEditor()">Cancel</button>
    </div>
  `;

  edEl.classList.remove('hidden');
}

function closeEditor() {
  if (selectedDot) { selectedDot.classList.remove('selected'); selectedDot = null; }
  selectedNoteIdx = -1;
  document.getElementById('note-editor').classList.add('hidden');
}

// ══════════════════════════════════════════════════════
//  APPLY EDITS  → update XML + re-render score
// ══════════════════════════════════════════════════════
function applyEdit() {
  if (selectedNoteIdx < 0) return;
  const n    = allNotes[selectedNoteIdx];
  const xmlN = getXMLNote(n.partIdx, n.measureNum, n.noteIdx);
  if (!xmlN) return;

  const isRest = !!xmlN.querySelector('rest');
  const newType = document.getElementById('ed-type')?.value;
  const newStem = document.getElementById('ed-stem')?.value;

  // Duration + type
  if (newType) {
    const divEl = xmlDoc.querySelector('score-partwise > part > measure > attributes > divisions');
    const div   = divEl ? parseInt(divEl.textContent, 10) : 4;
    const durMap = { whole: div*4, half: div*2, quarter: div, eighth: div/2, '16th': div/4, '32nd': div/8 };
    const durEl  = xmlN.querySelector('duration');
    if (durEl) durEl.textContent = Math.round(durMap[newType] ?? div);
    const typeEl = xmlN.querySelector('type');
    if (typeEl) typeEl.textContent = newType;
  }

  if (newStem) {
    const stemEl = xmlN.querySelector('stem');
    if (stemEl) stemEl.textContent = newStem;
  }

  if (!isRest) {
    const newStep = document.getElementById('ed-step')?.value;
    const newOct  = document.getElementById('ed-oct')?.value;
    const newAcc  = document.getElementById('ed-acc')?.value;

    if (newStep) { const e = xmlN.querySelector('pitch > step');   if (e) e.textContent = newStep; }
    if (newOct)  { const e = xmlN.querySelector('pitch > octave'); if (e) e.textContent = newOct; }

    // alter + accidental element
    const pitchEl = xmlN.querySelector('pitch');
    let alterEl   = xmlN.querySelector('pitch > alter');
    let accEl     = xmlN.querySelector('accidental');

    if (newAcc === 'none') {
      alterEl?.remove(); accEl?.remove();
    } else {
      const val = newAcc === 'sharp' ? '1' : newAcc === 'flat' ? '-1' : '0';
      if (alterEl) { alterEl.textContent = val; }
      else if (pitchEl) {
        alterEl = xmlDoc.createElement('alter');
        alterEl.textContent = val;
        pitchEl.insertBefore(alterEl, pitchEl.querySelector('octave'));
      }
      if (!accEl) {
        accEl = xmlDoc.createElement('accidental');
        xmlN.insertBefore(accEl, xmlN.querySelector('notations') || null);
      }
      accEl.textContent = newAcc;
    }
  }

  const lyricEl = document.getElementById('ed-lyric');
  if (lyricEl) {
    const te = xmlN.querySelector('lyric > text');
    if (te) te.textContent = lyricEl.value;
  }

  currentXML = new XMLSerializer().serializeToString(xmlDoc);
  closeEditor();
  renderScore(currentXML).then(() => toast('Note updated'));
}

// ══════════════════════════════════════════════════════
//  CONTROLS
// ══════════════════════════════════════════════════════

// Zoom
document.getElementById('zoom-in').addEventListener('click', () => {
  currentZoom = Math.min(currentZoom + 0.15, 3.0);
  document.getElementById('zoom-label').textContent = Math.round(currentZoom * 100) + '%';
  if (osmd) osmd.zoom = currentZoom, osmd.render().then(() => { buildNoteRegistry(); placeDots(); });
});
document.getElementById('zoom-out').addEventListener('click', () => {
  currentZoom = Math.max(currentZoom - 0.15, 0.3);
  document.getElementById('zoom-label').textContent = Math.round(currentZoom * 100) + '%';
  if (osmd) osmd.zoom = currentZoom, osmd.render().then(() => { buildNoteRegistry(); placeDots(); });
});

// Reset
document.getElementById('reset-btn').addEventListener('click', () => {
  if (!confirm('Reset all edits and restore original score?')) return;
  currentXML = originalXML;
  parseXMLModel();
  renderScore(currentXML).then(() => toast('Score reset'));
});

// Load a different image → go back to upload screen
document.getElementById('new-image-btn').addEventListener('click', () => {
  showUploadScreen();
});

// Download — also auto-saves to /exports/ via backend
document.getElementById('download-btn').addEventListener('click', async () => {
  toast('Saving…');
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: currentXML,
  });
  if (!res.ok) { toast('Download failed'); return; }
  const blob = await res.blob();
  const cd   = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || 'score_edited.musicxml';
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  toast('Saved to exports/ and downloaded');
});

// Re-place dots if window resizes
window.addEventListener('resize', () => {
  if (document.getElementById('score-img').src) placeDots();
});

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
  if (msg) setTimeout(() => el.classList.add('hidden'), 2200);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
