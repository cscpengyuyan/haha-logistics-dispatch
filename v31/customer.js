/* English customer delivery requirements form */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const token = new URLSearchParams(location.search).get('token');
const draftKey = token ? `haha_v3_delivery_${token}` : '';
let request = null;
let step = 1;
let photoUploads = {};

const labels = {
  CURBSIDE:'Curbside', ENTRANCE:'Building entrance', INSIDE:'Inside the building', ROOM:'Specific room / location',
  YES:'Yes', NO:'No', NOT_SURE:'Not sure'
};

function invalid() {
  $('#loading').classList.add('hidden');
  $('#invalid').classList.remove('hidden');
}

async function main() {
  if (!token) return invalid();
  try {
    const res = await fetch(`/api/public/request/${token}`);
    if (!res.ok) return invalid();
    const data = await res.json();
    request = data.request;
    if (request.status === 'SUBMITTED' || request.status === 'CONVERTED') {
      $('#loading').classList.add('hidden');
      $('#form-wrap').classList.add('hidden');
      $('#done').classList.remove('hidden');
      $('#done-summary').innerHTML = summaryHtml();
      return;
    }
    prefill();
    restoreDraft();
    $('#loading').classList.add('hidden');
    $('#form-wrap').classList.remove('hidden');
    bind();
    updateVisibility();
    renderStep();
  } catch (e) { invalid(); }
}

function prefill() {
  const f = $('#delivery-form');
  const a = request.answers || {};
  const values = {
    customer_name: request.customer_name, contact: request.contact, email: request.email, phone: request.phone,
    address: request.address, city: request.city, state: request.state, zip: request.zip,
    equipment_model: request.equipment_model, qty: request.qty, requested_date: request.requested_date,
    location_type: request.location_type || 'CURBSIDE',
    ...a
  };
  for (const [k, v] of Object.entries(values)) {
    const el = f.elements[k];
    if (el && v != null) el.value = v;
  }
  for (const att of request.attachments || []) {
    const img = document.createElement('a');
    img.href = `/api/attachments/${att.id}?token=${token}`;
    img.target = '_blank';
    img.textContent = att.filename;
    $('#photos').appendChild(img);
  }
}

function bind() {
  $('#next').addEventListener('click', () => {
    if (!validateStep(step)) return;
    if (step < 5) { step++; renderStep(); }
  });
  $('#back').addEventListener('click', () => { if (step > 1) { step--; renderStep(); } });
  $('#delivery-form').addEventListener('submit', submitForm);
  $('#delivery-form').addEventListener('input', () => { updateVisibility(); saveDraft(); updateReview(); });
  $('#delivery-form').addEventListener('change', () => { updateVisibility(); saveDraft(); updateReview(); });
  $$('input[type=file][data-photo]').forEach(el => el.addEventListener('change', () => uploadPhoto(el)));
}

function renderStep() {
  $$('.step').forEach(el => el.classList.toggle('hidden', Number(el.dataset.step) !== step));
  $$('#steps span').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
  $('#progress-bar').style.width = `${step * 20}%`;
  $('#back').classList.toggle('hidden', step === 1);
  $('#next').classList.toggle('hidden', step === 5);
  $('#submit').classList.toggle('hidden', step !== 5);
  if (step === 5) updateReview();
}

function updateVisibility() {
  const f = $('#delivery-form');
  const loc = f.elements.location_type.value;
  $('#inside-fields').classList.toggle('hidden', !['INSIDE','ROOM'].includes(loc));
  const stairs = f.elements.stairs.value;
  $('#stair-fields').classList.toggle('hidden', stairs !== 'YES');
}

function validateStep(n) {
  const f = $('#delivery-form');
  const required = n === 1 ? ['customer_name','contact','email','phone','address','city','state','zip']
    : n === 2 ? ['equipment_model','qty'] : [];
  for (const name of required) {
    const el = f.elements[name];
    if (!el.value.trim()) { el.focus(); alert('Please complete the required fields.'); return false; }
  }
  if (n === 1 && !/^\d{5}(-\d{4})?$/.test(f.elements.zip.value.trim())) {
    f.elements.zip.focus(); alert('Please enter a valid US ZIP code.'); return false;
  }
  if (n === 1 && !/^[A-Za-z]{2}$/.test(f.elements.state.value.trim())) {
    f.elements.state.focus(); alert('Please enter a 2-letter state code.'); return false;
  }
  return true;
}

function collect() {
  const f = $('#delivery-form');
  const answers = {
    location_type: f.elements.location_type.value,
    appointment: f.elements.appointment.value,
    floor: f.elements.floor.value,
    elevator: f.elements.elevator.value,
    door_width: f.elements.door_width.value,
    door_height: f.elements.door_height.value,
    hallway: f.elements.hallway.value,
    stairs: f.elements.stairs.value,
    steps: f.elements.steps.value,
    landing: f.elements.landing.value,
    turning: f.elements.turning.value,
    other_restrictions: f.elements.other_restrictions.value,
    access_notes: f.elements.access_notes.value,
    photos: photoUploads
  };
  return {
    customer_name: f.elements.customer_name.value.trim(),
    contact: f.elements.contact.value.trim(),
    email: f.elements.email.value.trim(),
    phone: f.elements.phone.value.trim(),
    address: f.elements.address.value.trim(),
    city: f.elements.city.value.trim(),
    state: f.elements.state.value.trim().toUpperCase(),
    zip: f.elements.zip.value.trim(),
    equipment_model: f.elements.equipment_model.value,
    qty: Number(f.elements.qty.value || 1),
    location_type: f.elements.location_type.value,
    requested_date: f.elements.requested_date.value,
    answers
  };
}

function summaryHtml() {
  const d = request || collect();
  const a = d.answers || {};
  return `<div><b>Customer</b> ${esc(d.customer_name)} · ${esc(d.contact)}</div>
    <div><b>Address</b> ${esc(d.address)}, ${esc(d.city)} ${esc(d.state)} ${esc(d.zip)}</div>
    <div><b>Equipment</b> ${esc(d.equipment_model)} × ${d.qty || 1}</div>
    <div><b>Delivery location</b> ${labels[d.location_type] || d.location_type}</div>
    <div><b>Appointment</b> ${labels[a.appointment] || a.appointment || '—'}${a.floor ? ` · Floor ${esc(a.floor)}` : ''}${a.elevator ? ` · Elevator: ${labels[a.elevator] || a.elevator}` : ''}</div>
    ${a.stairs === 'YES' ? `<div><b>Stairs</b> ${esc(a.steps || '—')} steps · landing ${esc(a.landing || '—')}</div>` : ''}
    <div><b>Requested date</b> ${esc(d.requested_date || '—')}</div>`;
}

function updateReview() {
  if (step !== 5 || request) return;
  $('#review').innerHTML = summaryHtml();
}

function saveDraft() {
  try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch {}
}
function restoreDraft() {
  try {
    const raw = localStorage.getItem(draftKey);
    if (!raw) return;
    const d = JSON.parse(raw);
    const f = $('#delivery-form');
    for (const [k,v] of Object.entries(d)) {
      if (k === 'answers') continue;
      if (f.elements[k] && v != null) f.elements[k].value = v;
    }
    if (d.answers) for (const [k,v] of Object.entries(d.answers)) {
      if (f.elements[k] && v != null) f.elements[k].value = v;
    }
  } catch {}
}

async function uploadPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  const idx = input.dataset.photo;
  const box = document.querySelector(`[data-thumbs="${idx}"]`);
  box.textContent = 'Uploading…';
  try {
    const res = await fetch(`/api/public/request/${token}/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: {'content-type': file.type}, body: file
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    photoUploads[file.name] = data.attachment;
    box.innerHTML = `<a href="/api/attachments/${data.attachment.id}?token=${token}" target="_blank">View</a>`;
  } catch (e) { box.textContent = e.message; }
}

async function submitForm(e) {
  e.preventDefault();
  if (!validateStep(1) || !validateStep(2)) { step = 1; renderStep(); return; }
  const consent = $('#delivery-form').elements.consent;
  if (!consent.checked) { alert('Please confirm the information is accurate.'); return; }
  const d = collect();
  $('#submit').disabled = true;
  try {
    const res = await fetch(`/api/public/request/${token}/submit`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(d)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');
    localStorage.removeItem(draftKey);
    $('#form-wrap').classList.add('hidden');
    $('#done').classList.remove('hidden');
    $('#done-summary').innerHTML = summaryHtml();
    window.scrollTo({top:0,behavior:'smooth'});
  } catch (err) {
    $('#submit').disabled = false;
    alert(err.message);
  }
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

main();
