/* ═══════════════════════════════════════════════════
   Harmonia – Score Editor
   - Image upload with confidence-dot overlay
   - OSMD multi-system rendering (respects new-system)
   - Threshold-based dot colouring (blue/red)
   - Note editor (edits reflected in regenerated score)
   - Download saves to project /exports/ folder too
═══════════════════════════════════════════════════ */

// ── MusicXML page dimensions (tenths from the file) ──
const XML_PAGE_W = 1365;   // tenths  →  px at OSMD zoom=1
const XML_PAGE_H = 1922;

// ── State ─────────────────────────────────────────────
let osmd         = null;
let currentXML   = '';
let originalXML  = '';
let xmlDoc       = null;
let xmlNoteIndex = {};      // "partIdx-measureNum-noteIdx" → <note> DOM
let allNotes     = [];      // [{absX, absY, partIdx, measureNum, noteIdx, isRest}, …]
let confidence   = [];      // parallel array, random 0-100 per note
let currentZoom  = 1.0;
let threshold    = 75;
let selectedDot  = null;    // currently selected .ndot element
let selectedNoteIdx = -1;   // index into allNotes

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

  // Display image
  const img = document.getElementById('score-img');
  img.src = data.url;
  img.onload = () => placeDots();

  await initScore();
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
  });

  await renderScore(currentXML);
}

async function renderScore(xmlStr) {
  toast('Rendering…');
  await osmd.load(xmlStr);
  osmd.zoom = currentZoom;
  await osmd.render();
  buildNoteRegistry();
  generateConfidence();
  placeDots();           // re-place whenever score re-renders
  toast('');
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
//  NOTE REGISTRY (OSMD graphic positions)
// ══════════════════════════════════════════════════════
function buildNoteRegistry() {
  allNotes = [];
  const sheet = osmd.GraphicSheet;
  if (!sheet?.MeasureList) return;

  // MeasureList[measureIdx][staffIdx]
  sheet.MeasureList.forEach((staves) => {
    staves.forEach((measure, staffIdx) => {
      if (!measure) return;
      const mn = measure.parentSourceMeasure?.measureNumber ?? 0;
      let ni = 0;
      (measure.staffEntries || []).forEach(se => {
        (se.graphicalVoiceEntries || []).forEach(gve => {
          (gve.notes || []).forEach(gn => {
            const pos = gn.PositionAndShape?.AbsolutePosition;
            if (!pos) { ni++; return; }
            allNotes.push({
              absX:    pos.x,   // OSMD units (1 unit = 10px at zoom=1)
              absY:    pos.y,
              partIdx: staffIdx,
              measureNum: mn,
              noteIdx: ni,
              isRest:  !!gn.sourceNote?.isRest,
            });
            ni++;
          });
        });
      });
    });
  });
}

function generateConfidence() {
  // Keep existing scores if count matches (so edits don't reshuffle colours)
  if (confidence.length !== allNotes.length) {
    confidence = allNotes.map(() => Math.floor(Math.random() * 101));
  }
}

// ══════════════════════════════════════════════════════
//  DOT OVERLAY  (on original image)
// ══════════════════════════════════════════════════════
function placeDots() {
  const img   = document.getElementById('score-img');
  const layer = document.getElementById('dot-layer');
  layer.innerHTML = '';

  // Wait until image is loaded and notes are ready
  if (!img.complete || !img.naturalWidth || allNotes.length === 0) return;

  // img-container CSS (position:relative, display:inline-block) sizes itself
  // to the image, and dot-layer is absolute top:0 left:0 width:100% height:100%.
  // So we just need to map OSMD page coords → image display pixels.
  const dispW = img.offsetWidth;
  const dispH = img.offsetHeight;

  // OSMD AbsolutePosition is in units; 1 unit = 10 px at zoom=1.
  // The original MusicXML page is XML_PAGE_W × XML_PAGE_H tenths,
  // which equals XML_PAGE_W × XML_PAGE_H px at zoom=1 (since 1 tenths = 1 unit/10 = 1px).
  const sx = dispW / XML_PAGE_W;
  const sy = dispH / XML_PAGE_H;

  allNotes.forEach((n, idx) => {
    const x = n.absX * 10 * sx;
    const y = n.absY * 10 * sy;

    const dot = document.createElement('div');
    dot.className = 'ndot ' + dotClass(idx);
    dot.style.left = x + 'px';
    dot.style.top  = y + 'px';
    dot.dataset.idx = idx;
    dot.addEventListener('click', () => onDotClick(dot, idx));
    layer.appendChild(dot);
  });
}

function dotClass(idx) {
  return confidence[idx] >= threshold ? 'above' : 'below';
}

function refreshDotColours() {
  document.querySelectorAll('.ndot').forEach(d => {
    const idx = parseInt(d.dataset.idx, 10);
    d.className = 'ndot ' + dotClass(idx) + (d.classList.contains('selected') ? ' selected' : '');
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
  const conf  = confidence[idx];
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

  const confColor = conf >= threshold ? '#3399ff' : '#ff4444';

  fields.innerHTML = `
    <div class="ef-meta">
      Part ${n.partIdx + 1}<br>Measure ${n.measureNum}
    </div>
    <div class="ef-conf" style="color:${confColor}" title="Confidence score">
      ${conf}%
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

// Threshold slider
const slider = document.getElementById('threshold-slider');
slider.addEventListener('input', () => {
  threshold = parseInt(slider.value, 10);
  document.getElementById('threshold-val').textContent = threshold;
  refreshDotColours();
});

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
