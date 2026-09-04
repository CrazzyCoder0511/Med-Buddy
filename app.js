/* MedBuddy — app shell, schedule engine and alarms.
   State lives in localStorage only. Nothing about your health leaves the device. */

const STORE_KEY = 'dosenote.v1';
const SNOOZE_MINUTES = 10;
const MISSED_AFTER_MINUTES = 60;

const EMPTY_INSURANCE = {
  provider: '', memberId: '', groupNumber: '', planType: '', phone: '', expiryDate: '', notes: '',
};
let state = { meds: [], log: {}, snooze: {}, insurance: { ...EMPTY_INSURANCE } };
let pending = null;          // parse result awaiting confirmation
let readonly = false;
let medSheet = null;         // SheetController for the instruction sheet
let insViewerSheet = null;   // SheetController for the insurance document viewer
const firedThisSession = new Set();

/* --------------------------------------------------------------------- */
/* Storage                                                                */
/* --------------------------------------------------------------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        meds: parsed.meds || [],
        log: parsed.log || {},
        snooze: parsed.snooze || {},
        insurance: { ...EMPTY_INSURANCE, ...(parsed.insurance || {}) },
      };
    }
  } catch (err) {
    console.warn('Could not read saved data, starting fresh.', err);
  }
}

function save() {
  if (readonly) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save.', err);
  }
  if (window.Cloud && Cloud.isSignedIn()) Cloud.pushStateDebounced(state);
}

/* --------------------------------------------------------------------- */
/* Date helpers                                                           */
/* --------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function dateFromISOAndTime(iso, time) {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00');
  const b = new Date(isoB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function doseKey(medId, iso, time) {
  return `${medId}|${iso}|${time}`;
}

function isoPlusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function endDateOf(med) {
  if (!med.durationDays) return null;
  return isoPlusDays(med.startDate, med.durationDays - 1);
}

function isCompleted(med) {
  if (!med.durationDays) return false;
  return daysBetween(med.startDate, todayISO()) >= med.durationDays;
}

/* --------------------------------------------------------------------- */
/* Adherence — what was actually taken, not just what was prescribed      */
/* --------------------------------------------------------------------- */

const MAX_LOOKBACK_DAYS = 180;

function adherenceFor(med) {
  const now = new Date();
  const start = med.startDate || todayISO();
  const elapsed = daysBetween(start, todayISO());
  const complete = isCompleted(med);

  // Last day worth counting: today, or the final day of a finished course.
  const lastDay = med.durationDays ? Math.min(elapsed, med.durationDays - 1) : elapsed;
  const firstDay = Math.max(0, lastDay - MAX_LOOKBACK_DAYS + 1);

  let due = 0;
  let taken = 0;
  const missesByTime = {};

  for (let i = firstDay; i <= lastDay; i++) {
    const iso = isoPlusDays(start, i);

    if (med.asNeeded) {
      // Nothing is "due" for an as-needed medication — only count what was used.
      if (state.log[doseKey(med.id, iso, 'prn')] === 'taken') taken++;
      continue;
    }

    for (const time of med.times) {
      if (dateFromISOAndTime(iso, time) > now) continue; // not due yet
      due++;
      if (state.log[doseKey(med.id, iso, time)] === 'taken') taken++;
      else missesByTime[time] = (missesByTime[time] || 0) + 1;
    }
  }

  const missed = due - taken;
  return {
    due,
    taken,
    missed,
    percent: due ? Math.round((taken / due) * 100) : null,
    dayNumber: Math.min(elapsed + 1, med.durationDays || Infinity),
    totalDays: med.durationDays,
    complete,
    endDate: endDateOf(med),
    missPattern: describeMissPattern(missesByTime, missed, med.times.length),
  };
}

/* If misses cluster at one time of day, say so — that is the part a person
   can actually act on. Pointless for a once-daily medication, where every
   dose is at the same time and the "pattern" is a tautology. */
function describeMissPattern(missesByTime, totalMissed, timesPerDay) {
  if (totalMissed < 2 || timesPerDay < 2) return null;
  const entries = Object.entries(missesByTime).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const [time, count] = entries[0];
  if (count < 2 || count / totalMissed < 0.5) return null;
  return `Missed doses were mostly ${bucketFor(time)}.`;
}

function bucketFor(time) {
  const h = parseInt(time.slice(0, 2), 10);
  if (h < 11) return 'in the morning';
  if (h < 15) return 'around midday';
  if (h < 21) return 'in the evening';
  return 'at night';
}

function computeStreak() {
  const today = todayISO();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const iso = isoPlusDays(today, -i);
    const active = state.meds.filter(m => !m.asNeeded && isActiveOn(m, iso));
    if (!active.length) { if (i === 0) continue; break; }
    const now = new Date();
    let allTaken = true;
    for (const med of active) {
      for (const time of med.times) {
        if (dateFromISOAndTime(iso, time) > now) continue;
        if (state.log[doseKey(med.id, iso, time)] !== 'taken') { allTaken = false; break; }
      }
      if (!allTaken) break;
    }
    if (allTaken) streak++;
    else break;
  }
  return streak;
}

/* --------------------------------------------------------------------- */
/* Schedule                                                               */
/* --------------------------------------------------------------------- */

function isActiveOn(med, iso) {
  const elapsed = daysBetween(med.startDate || iso, iso);
  if (elapsed < 0) return false;
  if (med.durationDays && elapsed >= med.durationDays) return false;
  return true;
}

function dosesFor(iso) {
  const list = [];
  for (const med of state.meds) {
    if (!isActiveOn(med, iso)) continue;
    if (med.asNeeded) {
      list.push({ med, time: 'prn', at: null, key: doseKey(med.id, iso, 'prn') });
      continue;
    }
    for (const time of med.times) {
      list.push({
        med,
        time,
        at: dateFromISOAndTime(iso, time),
        key: doseKey(med.id, iso, time),
      });
    }
  }
  list.sort((a, b) => {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at - b.at;
  });
  return list;
}

function doseStatus(dose, now) {
  if (state.log[dose.key] === 'taken') return 'taken';
  if (!dose.at) return 'upcoming';
  const diffMin = (now - dose.at) / 60000;
  if (diffMin < 0) return 'upcoming';
  if (diffMin <= MISSED_AFTER_MINUTES) return 'now';
  return 'missed';
}

/* --------------------------------------------------------------------- */
/* Rendering — Today                                                      */
/* --------------------------------------------------------------------- */

let lastRenderSig = null;

function renderToday() {
  const iso = todayISO();
  const now = new Date();
  const doses = dosesFor(iso);
  const nextDose = doses.find((d) => d.at && doseStatus(d, now) === 'upcoming');

  // The clock ticks every second but the view rarely changes. Rebuilding the
  // list only when something visible moved keeps taps from landing on a
  // element that was just replaced.
  const sig =
    iso +
    '|' +
    doses.map((d) => d.key + ':' + doseStatus(d, now)).join(',') +
    '|' +
    (nextDose ? nextDose.key + relativeTime(nextDose.at, now) : '');
  if (sig === lastRenderSig) return;
  lastRenderSig = sig;

  $('#today-date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const g = greetingForNow(now);
  $('#greeting').textContent = g.icon + ' ' + g.text;

  const taken = doses.filter((d) => state.log[d.key] === 'taken').length;
  const pct = doses.length ? Math.round((taken / doses.length) * 100) : 0;

  $('#today-empty').hidden = doses.length > 0;
  $('#timeline').hidden = doses.length === 0;

  $('#today-summary').textContent = doses.length
    ? `${taken} of ${doses.length} doses taken`
    : 'No medications yet.';

  const streak = computeStreak();
  const streakBadge = $('#streak-badge');
  const todayComplete = pct === 100 && doses.length > 0;
  if (streak > 0) {
    streakBadge.hidden = false;
    $('#streak-count').textContent = streak;
    streakBadge.classList.toggle('is-hot', todayComplete);
  } else {
    streakBadge.hidden = true;
  }
  if (todayComplete) celebrateMilestoneIfNeeded(streak);
  if (window.Cloud && Cloud.isSignedIn()) updateLeaderboardStreak(streak);

  // Dashboard
  const hasMeds = state.meds.length > 0;
  $('#dash').hidden = !hasMeds;
  if (hasMeds) {
    $('#dash-progress').textContent = pct + '%';
    $('#dash-bar-fill').style.width = pct + '%';
    const activeMeds = state.meds.filter(m => isActiveOn(m, iso));
    $('#dash-active').textContent = activeMeds.length;
    let totalDue = 0, totalTaken = 0;
    for (const med of activeMeds) {
      const s = adherenceFor(med);
      totalDue += s.due;
      totalTaken += s.taken;
    }
    $('#dash-adherence').textContent = totalDue ? Math.round((totalTaken / totalDue) * 100) + '%' : '—';
    $('#dash-streak').textContent = streak;
  }

  // Next upcoming dose banner
  const next = nextDose;
  const banner = $('#next-dose');
  if (next) {
    banner.hidden = false;
    $('#next-dose-name').textContent =
      next.med.name + (next.med.dose ? ` · ${next.med.dose}` : '');
    $('#next-dose-when').textContent = `${DoseParser.prettyTime(next.time)} — ${relativeTime(
      next.at,
      now
    )}`;
  } else {
    banner.hidden = true;
  }

  const tl = $('#timeline');
  tl.innerHTML = '';
  for (const dose of doses) {
    const status = doseStatus(dose, now);
    const li = document.createElement('li');
    li.className = 'dose';
    if (status === 'taken') li.classList.add('is-taken');
    if (status === 'missed') li.classList.add('is-missed');
    if (status === 'now') li.classList.add('is-now');

    const timeEl = document.createElement('span');
    timeEl.className = 'dose-time';
    timeEl.textContent = dose.at ? DoseParser.prettyTime(dose.time) : 'As needed';

    const main = document.createElement('div');
    main.className = 'dose-main';
    const name = document.createElement('div');
    name.className = 'dose-name';
    name.textContent = dose.med.name;
    const sub = document.createElement('div');
    sub.className = 'dose-sub';
    sub.textContent = subtitleFor(dose, status);
    main.append(name, sub);

    li.append(timeEl, main);

    if (!readonly) {
      const check = document.createElement('button');
      check.className = 'dose-check';
      check.dataset.key = dose.key;
      check.setAttribute(
        'aria-label',
        status === 'taken' ? `Mark ${dose.med.name} as not taken` : `Mark ${dose.med.name} as taken`
      );
      check.addEventListener('click', () => {
        const rect = check.getBoundingClientRect();
        const justTaken = toggleTaken(dose.key);
        if (justTaken) celebrateDose(rect.left + rect.width / 2, rect.top + rect.height / 2, dose.key);
      });
      li.append(check);
    } else {
      const mark = document.createElement('span');
      mark.className = 'pill';
      mark.textContent = status === 'taken' ? 'Taken' : status === 'missed' ? 'Missed' : 'Pending';
      li.append(mark);
    }

    tl.append(li);
  }
}

function subtitleFor(dose, status) {
  const bits = [];
  if (dose.med.dose) bits.push(dose.med.dose);
  const key = dose.med.instructions.find(
    (i) => i.tag === 'with-food' || i.tag === 'empty-stomach'
  );
  if (key) bits.push(key.tag === 'with-food' ? 'with food' : 'empty stomach');
  if (status === 'missed') bits.push('missed');
  return bits.join(' · ') || dose.med.frequencyLabel;
}

function relativeTime(then, now) {
  const mins = Math.round((then - now) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
}

function toggleTaken(key) {
  const wasTaken = state.log[key] === 'taken';
  if (wasTaken) delete state.log[key];
  else state.log[key] = 'taken';
  save();
  renderToday();
  return !wasTaken; // true when this call just marked it taken
}

function greetingForNow(now) {
  const h = now.getHours();
  if (h < 5) return { icon: '🌙', text: 'Still up?' };
  if (h < 12) return { icon: '☀️', text: 'Good morning' };
  if (h < 17) return { icon: '🌤️', text: 'Good afternoon' };
  if (h < 21) return { icon: '🌇', text: 'Good evening' };
  return { icon: '🌙', text: 'Good night' };
}

/* --------------------------------------------------------------------- */
/* Celebration — confetti burst + checkmark pop on marking a dose taken   */
/* --------------------------------------------------------------------- */

const CONFETTI_COLORS = ['#12805c', '#34caa0', '#e8794a', '#eda253', '#2f7ed8'];

function burstConfetti(x, y, scale) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas || !canvas.getContext) return;
  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  const ctx = canvas.getContext('2d');

  const mult = scale || 1;
  const count = Math.round(22 * mult);
  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = (2 + Math.random() * 3.5) * Math.min(mult, 1.6);
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      size: 3 + Math.random() * 3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 1,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
    });
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 0.12; // gravity
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      p.life -= 0.018;
      ctx.save();
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    if (alive) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(tick);
}

function celebrateDose(x, y, key) {
  burstConfetti(x, y);
  const btn = document.querySelector('.dose-check[data-key="' + CSS.escape(key) + '"]');
  if (btn) {
    btn.classList.add('pop');
    btn.addEventListener('animationend', () => btn.classList.remove('pop'), { once: true });
  }
}

/* Bigger celebration the first time a streak crosses a milestone.
   Purely cosmetic, so it lives in localStorage rather than synced state. */
const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
const LAST_MILESTONE_KEY = 'medbuddy.lastMilestone';

function celebrateMilestoneIfNeeded(streak) {
  if (!STREAK_MILESTONES.includes(streak)) return;
  let last = 0;
  try {
    last = parseInt(localStorage.getItem(LAST_MILESTONE_KEY) || '0', 10) || 0;
  } catch (err) {
    void err;
  }
  if (streak <= last) return;
  try {
    localStorage.setItem(LAST_MILESTONE_KEY, String(streak));
  } catch (err) {
    void err;
  }

  // Three staggered bursts across the top of the screen, bigger than a
  // single-dose celebration.
  const w = window.innerWidth;
  const spots = [w * 0.25, w * 0.5, w * 0.75];
  spots.forEach((x, i) => {
    setTimeout(() => burstConfetti(x, window.innerHeight * 0.28, 1.8), i * 140);
  });
  toast('🔥 ' + streak + '-day streak!');
}

/* --------------------------------------------------------------------- */
/* Leaderboard — opt-in. Only a nickname and streak number ever leave     */
/* the device for this feature; medication data never does.              */
/* --------------------------------------------------------------------- */

let leaderboardSheet = null;
let myLeaderboardEntry = null; // { display_name, streak } once opted in, else null

function initLeaderboard() {
  const badge = $('#streak-badge');
  if (badge) badge.addEventListener('click', openLeaderboard);

  leaderboardSheet = new SheetController(
    $('#leaderboard-sheet'),
    document.querySelector('#leaderboard-sheet .sheet-panel'),
    document.querySelector('#leaderboard-sheet .sheet-handle')
  );
  $('#leaderboard-close').addEventListener('click', () => leaderboardSheet.dismiss());
  $('#leaderboard-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'leaderboard-sheet') leaderboardSheet.dismiss();
  });

  $('#lb-join').addEventListener('click', joinLeaderboardFlow);
  $('#lb-nickname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinLeaderboardFlow();
  });
  $('#lb-leave').addEventListener('click', leaveLeaderboardFlow);
}

function showLbError(msg) {
  const el = $('#lb-error');
  el.textContent = msg;
  el.hidden = false;
}

async function openLeaderboard() {
  if (readonly) return; // a caregiver's read-only link never touches the cloud
  if (!window.Cloud || !Cloud.isSignedIn()) {
    toast('Sign in to use the leaderboard');
    return;
  }
  leaderboardSheet.open();
  await refreshLeaderboardView();
}

async function refreshLeaderboardView() {
  $('#lb-error').hidden = true;
  try {
    myLeaderboardEntry = await Cloud.getMyLeaderboardEntry();
  } catch (err) {
    void err;
    showLbError('Could not reach the leaderboard right now.');
    return;
  }

  $('#lb-joined').hidden = !myLeaderboardEntry;
  $('#lb-join-form').hidden = !!myLeaderboardEntry;

  if (myLeaderboardEntry) {
    $('#lb-my-name').textContent = myLeaderboardEntry.display_name;
    await renderLeaderboardList();
  }
}

async function renderLeaderboardList() {
  let rows = [];
  try {
    rows = await Cloud.fetchLeaderboard(50);
  } catch (err) {
    void err;
  }
  const list = $('#lb-list');
  list.innerHTML = '';
  $('#lb-empty').hidden = rows.length > 0;

  const medals = ['🥇', '🥈', '🥉'];
  const myId = Cloud.userId();
  rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'lb-row' + (row.user_id === myId ? ' is-me' : '');

    const rank = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = medals[i] || String(i + 1);

    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = row.display_name;

    const streakEl = document.createElement('span');
    streakEl.className = 'lb-streak';
    streakEl.textContent = '🔥 ' + row.streak;

    el.append(rank, name, streakEl);
    list.append(el);
  });
}

async function joinLeaderboardFlow() {
  const name = $('#lb-nickname').value.trim();
  if (!name) {
    $('#lb-nickname').focus();
    return;
  }
  const btn = $('#lb-join');
  btn.disabled = true;
  try {
    await Cloud.joinLeaderboard(name, computeStreak());
    $('#lb-nickname').value = '';
    await refreshLeaderboardView();
    toast('Joined the leaderboard ✓');
  } catch (err) {
    showLbError(err.message || 'Could not join right now.');
  } finally {
    btn.disabled = false;
  }
}

async function leaveLeaderboardFlow() {
  try {
    await Cloud.leaveLeaderboard();
    myLeaderboardEntry = null;
    await refreshLeaderboardView();
    toast('Left the leaderboard');
  } catch (err) {
    showLbError(err.message || 'Could not leave right now.');
  }
}

/* Keep the cloud streak current whenever it changes locally, so other
   players see it without the user having to reopen the leaderboard. */
let lastPushedStreak = null;
function updateLeaderboardStreak(streak) {
  if (!myLeaderboardEntry || streak === lastPushedStreak) return;
  lastPushedStreak = streak;
  Cloud.updateMyStreak(streak).catch((err) => console.warn('Streak sync failed:', err));
}

/* --------------------------------------------------------------------- */
/* Rendering — Medications                                                */
/* --------------------------------------------------------------------- */

function renderMeds() {
  const active = $('#med-list');
  const completed = $('#completed-list');
  active.innerHTML = '';
  completed.innerHTML = '';

  const activeMeds = state.meds.filter((m) => !isCompleted(m));
  const doneMeds = state.meds.filter((m) => isCompleted(m));

  for (const med of activeMeds) active.append(medCard(med));
  for (const med of doneMeds) completed.append(medCard(med));

  $('#active-section').hidden = activeMeds.length === 0;
  $('#completed-section').hidden = doneMeds.length === 0;
  $('#meds-empty').hidden = state.meds.length > 0;

  renderRxSummary();
  renderFlags();
}

function medCard(med) {
  const stats = adherenceFor(med);

  const card = document.createElement('div');
  card.className = 'med-card' + (stats.complete ? ' is-complete' : '');
  card.tabIndex = 0;

  const top = document.createElement('div');
  top.className = 'med-top';
  const name = document.createElement('span');
  name.className = 'med-name';
  name.textContent = med.name;
  const dose = document.createElement('span');
  dose.className = 'med-dose';
  dose.textContent = med.dose;
  top.append(name, dose);

  const meta = document.createElement('div');
  meta.className = 'med-meta';
  meta.textContent = metaLine(med);

  card.append(top, meta, progressBlock(med, stats));

  const pills = document.createElement('div');
  pills.className = 'pills';
  for (const ins of med.instructions) {
    const p = document.createElement('span');
    p.className = 'pill' + (isWarnTag(ins.tag) ? ' pill-warn' : '');
    p.textContent = pillLabel(ins.tag);
    pills.append(p);
  }
  if (med.instructions.length) card.append(pills);

  card.addEventListener('click', () => openSheet(med));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSheet(med);
    }
  });
  return card;
}

function progressBlock(med, stats) {
  const wrap = document.createElement('div');
  wrap.className = 'progress-block';

  const label = document.createElement('div');
  label.className = 'progress-label';

  const left = document.createElement('span');
  left.textContent = stageText(med, stats);
  const right = document.createElement('span');
  right.className = 'progress-count';
  right.textContent = countText(med, stats);
  label.append(left, right);

  wrap.append(label);

  // As-needed medications have no denominator, so a bar would be meaningless.
  if (!med.asNeeded && stats.due > 0) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    if (stats.percent !== null && stats.percent < 80) fill.classList.add('is-low');
    fill.style.width = (stats.percent || 0) + '%';
    bar.append(fill);
    wrap.append(bar);
  }

  if (stats.missPattern) {
    const note = document.createElement('div');
    note.className = 'progress-note';
    note.textContent = stats.missPattern;
    wrap.append(note);
  }

  return wrap;
}

function stageText(med, stats) {
  if (stats.complete) {
    const end = new Date(stats.endDate + 'T00:00:00');
    return `Ended ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  if (med.durationDays) return `Day ${stats.dayNumber} of ${med.totalDays}`;
  const start = new Date(med.startDate + 'T00:00:00');
  return `Ongoing since ${start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

function countText(med, stats) {
  if (med.asNeeded) {
    return stats.taken === 1 ? '1 dose logged' : `${stats.taken} doses logged`;
  }
  if (!stats.due) return 'not started';
  return `${stats.taken}/${stats.due} doses${stats.percent !== null ? ` (${stats.percent}%)` : ''}`;
}

function renderRxSummary() {
  const el = $('#rx-summary');
  if (!state.meds.length) {
    el.textContent = 'Tap any medication to see how to take it.';
    return;
  }
  let due = 0;
  let taken = 0;
  for (const med of state.meds) {
    if (med.asNeeded) continue;
    const s = adherenceFor(med);
    due += s.due;
    taken += s.taken;
  }
  if (!due) {
    el.textContent = 'Tap any medication to see how to take it.';
    return;
  }
  const pct = Math.round((taken / due) * 100);
  el.textContent = `${taken} of ${due} scheduled doses taken overall (${pct}%).`;
}

/* Duration is deliberately left out — the progress block below the card
   already states the day count and end date. */
function metaLine(med) {
  const bits = [med.frequencyLabel];
  if (!med.asNeeded) bits.push(med.times.map(DoseParser.prettyTime).join(', '));
  return bits.join(' · ');
}

const PILL_LABELS = {
  'with-food': 'With food',
  'empty-stomach': 'Empty stomach',
  grapefruit: 'No grapefruit',
  dairy: 'No dairy',
  alcohol: 'No alcohol',
  drowsy: 'Causes drowsiness',
  water: 'Full glass of water',
  'swallow-whole': 'Swallow whole',
  'finish-course': 'Finish the course',
  'as-needed': 'As needed',
};

function pillLabel(tag) {
  return PILL_LABELS[tag] || tag;
}

function isWarnTag(tag) {
  return ['grapefruit', 'dairy', 'alcohol', 'drowsy', 'finish-course'].includes(tag);
}

function renderFlags() {
  const wrap = $('#flags');
  wrap.innerHTML = '';
  for (const flag of computeFlags()) {
    const el = document.createElement('div');
    el.className = 'flag flag-' + flag.level;
    const t = document.createElement('strong');
    t.textContent = flag.title;
    const d = document.createElement('p');
    d.textContent = flag.detail;
    el.append(t, d);
    wrap.append(el);
  }
}

/* Flags are recomputed from saved meds so they stay correct after edits. */
function computeFlags() {
  const meds = state.meds;
  const flags = [];

  const byTime = {};
  for (const med of meds) {
    if (med.asNeeded) continue;
    for (const t of med.times) (byTime[t] = byTime[t] || []).push(med.name);
  }
  for (const [time, names] of Object.entries(byTime)) {
    if (names.length > 1) {
      flags.push({
        level: 'check',
        title: `${names.length} medications at ${DoseParser.prettyTime(time)}`,
        detail: `${names.join(
          ' and '
        )} are both scheduled for the same time. Worth asking a pharmacist whether they can be taken together.`,
      });
    }
  }

  for (const med of meds) {
    if (med.doseUnitUnknown && med.dose) {
      flags.push({
        level: 'check',
        title: `Confirm the unit for ${med.name}`,
        detail: `Your note said "${med.dose}" with no unit. Check the label or prescription — it is most likely mg, but do not assume.`,
      });
    }
  }

  const withFood = meds.filter((m) => m.instructions.some((i) => i.tag === 'with-food'));
  const empty = meds.filter((m) => m.instructions.some((i) => i.tag === 'empty-stomach'));
  for (const a of withFood) {
    for (const b of empty) {
      const shared = a.times.filter((t) => b.times.includes(t));
      if (shared.length) {
        flags.push({
          level: 'conflict',
          title: `${a.name} and ${b.name} conflict`,
          detail: `${a.name} needs food and ${b.name} needs an empty stomach, but both sit at ${DoseParser.prettyTime(
            shared[0]
          )}. These need to be spaced apart.`,
        });
      }
    }
  }

  for (const med of meds) {
    if (!med.durationDays) continue;
    const start = new Date(med.startDate + 'T00:00:00');
    const end = new Date(start.getTime() + (med.durationDays - 1) * 86400000);
    const daysLeft = Math.ceil((end - new Date()) / 86400000);
    if (daysLeft >= 0) {
      flags.push({
        level: 'info',
        title: `${med.name}: ${daysLeft === 0 ? 'last day' : `${daysLeft} days left`}`,
        detail: `Course ends ${end.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        })}. ${
          med.instructions.some((i) => i.tag === 'finish-course')
            ? 'Finish every dose even if you feel better.'
            : 'Check whether you need a refill or follow-up.'
        }`,
      });
    }
  }

  return flags;
}

/* --------------------------------------------------------------------- */
/* Instruction sheet                                                      */
/* --------------------------------------------------------------------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalForGCal(d) {
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + pad2(d.getMinutes()) + '00';
}

function formatUTCForGCal(d) {
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T235959Z';
}

function googleCalendarLink(med, time) {
  const start = dateFromISOAndTime(todayISO(), time);
  const end = new Date(start.getTime() + 15 * 60000);

  const title = 'Take ' + med.name + (med.dose ? ' ' + med.dose : '');
  const detailParts = [];
  if (med.frequencyLabel) detailParts.push(med.frequencyLabel);
  if (med.instructions && med.instructions.length) {
    detailParts.push(med.instructions.map((i) => i.text).join(' '));
  }
  detailParts.push('Reminder created by MedBuddy.');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: formatLocalForGCal(start) + '/' + formatLocalForGCal(end),
    details: detailParts.join('\n\n'),
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  let recur = 'RRULE:FREQ=DAILY';
  if (med.durationDays) {
    const lastDay = isoPlusDays(med.startDate || todayISO(), med.durationDays - 1);
    recur += ';UNTIL=' + formatUTCForGCal(dateFromISOAndTime(lastDay, '23:59'));
  }
  params.set('recur', recur);

  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

function openSheet(med) {
  const body = $('#sheet-body');
  body.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = med.name;
  const sub = document.createElement('p');
  sub.className = 'muted';
  sub.textContent = [med.dose, med.frequencyLabel].filter(Boolean).join(' · ');
  body.append(h, sub);

  if (!med.asNeeded) {
    const times = document.createElement('div');
    times.className = 'sheet-times';
    for (const t of med.times) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = DoseParser.prettyTime(t);
      times.append(p);
    }
    body.append(times);

    if (med.times.length) {
      const calTitle = document.createElement('h3');
      calTitle.style.marginTop = '1.4rem';
      calTitle.textContent = 'Add reminders to Google Calendar';
      body.append(calTitle);

      const calLinks = document.createElement('div');
      calLinks.className = 'gcal-links';
      for (const t of med.times) {
        const a = document.createElement('a');
        a.className = 'gcal-link';
        a.href = googleCalendarLink(med, t);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = '&#x1F4C5; ' + DoseParser.prettyTime(t);
        calLinks.append(a);
      }
      body.append(calLinks);
    }
  }

  const howTitle = document.createElement('h3');
  howTitle.style.marginTop = '1.4rem';
  howTitle.textContent = 'How to take it';
  body.append(howTitle);

  const ul = document.createElement('ul');
  ul.className = 'howto';
  const items = med.instructions.length
    ? med.instructions
    : [{ tag: 'plain', text: 'No special instructions were given. Take it at the scheduled times.' }];
  for (const ins of items) {
    const li = document.createElement('li');
    if (isWarnTag(ins.tag)) li.className = 'warn';
    li.textContent = ins.text;
    ul.append(li);
  }
  body.append(ul);

  if (med.raw) {
    const raw = document.createElement('p');
    raw.className = 'muted small';
    raw.style.marginTop = '1.2rem';
    raw.textContent = `From your note: "${med.raw}"`;
    body.append(raw);
  }

  if (!readonly) {
    const del = document.createElement('button');
    del.className = 'danger-link';
    del.textContent = 'Remove this medication';
    del.addEventListener('click', () => {
      state.meds = state.meds.filter((m) => m.id !== med.id);
      save();
      closeSheet();
      renderAll();
    });
    body.append(del);
  }

  medSheet.open();
}

function closeSheet() {
  medSheet.dismiss();
}

/* --------------------------------------------------------------------- */
/* Intake and parse preview                                               */
/* --------------------------------------------------------------------- */

const EXAMPLES = {
  antibiotic:
    'Amoxicillin 500mg three times a day for 10 days, take with food and finish the entire course.',
  chronic:
    'Lisinopril 10mg every morning, avoid grapefruit. Atorvastatin 20mg at bedtime, swallow whole.',
  messy:
    "Doctor said take the amoxicillin 500 three times a day for 10 days with food, and the blood pressure one lisinopril 10mg every morning, don't take it with grapefruit. Also ibuprofen 400mg every 6 hours as needed for the pain, with a full glass of water, may cause drowsiness.",
  label:
    'AMOXICILLIN 500MG CAPSULE. TAKE 1 CAPSULE BY MOUTH 3 TIMES DAILY FOR 10 DAYS. TAKE WITH FOOD. FINISH ALL MEDICATION.',
};

function runParse() {
  const text = $('#orders-input').value.trim();
  if (!text) return;
  const result = DoseParser.parseOrders(text);

  if (!result.meds.length) {
    $('#parse-preview').innerHTML =
      '<p class="muted">I could not find a medication in that. Try including the name and how often to take it — for example "amoxicillin 500mg three times a day".</p>';
    $('#parse-result').hidden = false;
    $('#save-btn').disabled = true;
    pending = null;
    return;
  }

  pending = result.meds;
  $('#save-btn').disabled = false;
  renderPreview();
  $('#parse-result').hidden = false;
  $('#parse-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPreview() {
  const wrap = $('#parse-preview');
  wrap.innerHTML = '';

  pending.forEach((med, idx) => {
    const card = document.createElement('div');
    card.className = 'preview-card';

    card.append(field('Name', med.name, (v) => (pending[idx].name = v)));
    card.append(
      field(
        'Dose',
        med.dose,
        (v) => {
          pending[idx].dose = v;
          // Still incomplete until a unit is actually typed.
          pending[idx].doseUnitUnknown = v.trim() !== '' && !/[a-z]/i.test(v);
        },
        med.doseUnitUnknown ? 'add the unit — mg, ml, tablets…' : ''
      )
    );
    card.append(
      field('Times', med.times.join(', '), (v) => {
        const times = v
          .split(',')
          .map((t) => normalizeTime(t.trim()))
          .filter(Boolean);
        if (times.length) pending[idx].times = times;
      })
    );
    card.append(
      field('Days', med.durationDays ? String(med.durationDays) : '', (v) => {
        const n = parseInt(v, 10);
        pending[idx].durationDays = Number.isFinite(n) && n > 0 ? n : null;
      }, 'blank = ongoing')
    );

    if (med.instructions.length) {
      const pills = document.createElement('div');
      pills.className = 'pills';
      for (const ins of med.instructions) {
        const p = document.createElement('span');
        p.className = 'pill' + (isWarnTag(ins.tag) ? ' pill-warn' : '');
        p.textContent = pillLabel(ins.tag);
        pills.append(p);
      }
      card.append(pills);
    }

    const raw = document.createElement('div');
    raw.className = 'raw';
    raw.textContent = `read from: "${med.raw}"`;
    card.append(raw);

    wrap.append(card);
  });
}

function field(label, value, onChange, placeholder) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  row.append(l, input);
  return row;
}

/* Accepts "8:00", "8am", "20:00", "8" and returns "HH:MM". */
function normalizeTime(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] && m[3].toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function savePending() {
  if (!pending || !pending.length) return;
  state.meds.push(...pending);
  save();
  pending = null;
  $('#orders-input').value = '';
  $('#parse-result').hidden = true;
  renderAll();
  switchView('today');
  toast('Added to your schedule ✓');
}

/* --------------------------------------------------------------------- */
/* Alarms                                                                 */
/* --------------------------------------------------------------------- */

let audioCtx = null;
let beepTimer = null;
let activeAlarm = null;

function alarmsReady() {
  return audioCtx !== null && audioCtx.state === 'running';
}

async function enableAlarms() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch (err) {
    console.warn('Audio unavailable.', err);
  }
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch (err) {
      console.warn('Notification permission failed.', err);
    }
  }
  updateAlarmStatus();
}

function updateAlarmStatus() {
  const ready = alarmsReady();
  $('#alarm-status').hidden = readonly || ready;
}

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  // Three urgent rising tones at full volume.
  [0, 0.2, 0.4].forEach((offset, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime([880, 1100, 1320][i], now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(1.0, now + offset + 0.015);
    gain.gain.setValueAtTime(1.0, now + offset + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.19);
  });
}

function fireAlarm(dose) {
  if (activeAlarm) return;
  activeAlarm = dose;
  firedThisSession.add(dose.key);

  $('#alarm-name').textContent = dose.med.name;
  $('#alarm-dose').textContent = [dose.med.dose, dose.at ? DoseParser.prettyTime(dose.time) : '']
    .filter(Boolean)
    .join(' · ');

  const ins = $('#alarm-instructions');
  ins.innerHTML = '';
  for (const item of dose.med.instructions) {
    const d = document.createElement('div');
    d.textContent = item.text;
    ins.append(d);
  }

  $('#alarm-foot').textContent = dose.isTest
    ? 'This was a test alarm.'
    : 'Snoozing reminds you again in 10 minutes.';

  $('#alarm').hidden = false;

  beep();
  beepTimer = setInterval(beep, 1000);

  if (navigator.vibrate) {
    try {
      navigator.vibrate([500, 250, 500, 250, 500]);
    } catch (err) {
      void err;
    }
  }

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`Time to take ${dose.med.name}`, {
        body: dose.med.dose || 'Tap to open MedBuddy',
        tag: dose.key,
        requireInteraction: true,
      });
    } catch (err) {
      void err;
    }
  }
}

function dismissAlarm(action) {
  if (!activeAlarm) return;
  const dose = activeAlarm;

  clearInterval(beepTimer);
  beepTimer = null;
  if (navigator.vibrate) {
    try {
      navigator.vibrate(0);
    } catch (err) {
      void err;
    }
  }
  $('#alarm').hidden = true;
  activeAlarm = null;

  if (dose.isTest) return;

  if (action === 'taken') {
    state.log[dose.key] = 'taken';
  } else {
    state.snooze[dose.key] = Date.now() + SNOOZE_MINUTES * 60000;
    firedThisSession.delete(dose.key);
  }
  save();
  renderToday();
}

function checkDueDoses() {
  if (readonly || activeAlarm) return;
  const now = new Date();
  const iso = todayISO();

  for (const dose of dosesFor(iso)) {
    if (!dose.at) continue;
    if (state.log[dose.key] === 'taken') continue;
    if (firedThisSession.has(dose.key)) continue;

    const snoozedUntil = state.snooze[dose.key];
    if (snoozedUntil && Date.now() < snoozedUntil) continue;

    const dueAt = snoozedUntil && Date.now() >= snoozedUntil ? snoozedUntil : dose.at.getTime();
    const elapsedMin = (Date.now() - dueAt) / 60000;

    if (elapsedMin >= 0 && elapsedMin <= MISSED_AFTER_MINUTES) {
      fireAlarm(dose);
      return;
    }
  }
}

function testAlarm() {
  enableAlarms().then(() => {
    const med = state.meds[0] || {
      name: 'Test medication',
      dose: '500 mg',
      instructions: [
        { tag: 'with-food', text: 'This is what a real alarm looks like. Take with food.' },
      ],
    };
    $('#test-alarm').textContent = 'Firing in 10s…';
    setTimeout(() => {
      $('#test-alarm').textContent = 'Test alarm (10s)';
      fireAlarm({ med, time: '00:00', at: new Date(), key: 'test', isTest: true });
    }, 10000);
  });
}

/* --------------------------------------------------------------------- */
/* Caregiver share link                                                   */
/* --------------------------------------------------------------------- */

function encodeState() {
  // Only the last week of history travels in the link — a caregiver cares
  // about recent adherence, and it keeps the URL from growing forever.
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const recentLog = {};
  for (const [key, value] of Object.entries(state.log)) {
    const iso = key.split('|')[1];
    if (iso && new Date(iso + 'T00:00:00') >= cutoff) recentLog[key] = value;
  }
  const payload = JSON.stringify({ meds: state.meds, log: recentLog });
  const bytes = new TextEncoder().encode(payload);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function shareWithCaregiver() {
  if (!state.meds.length) {
    alert('Add a medication first.');
    return;
  }
  const url = location.origin + location.pathname + '#view=' + encodeState();
  try {
    await navigator.clipboard.writeText(url);
    const btn = $('#share-btn');
    btn.textContent = 'Link copied';
    setTimeout(() => (btn.textContent = 'Share with caregiver'), 2200);
  } catch (err) {
    void err;
    prompt('Copy this link and send it to your caregiver:', url);
  }
}

function tryReadonlyMode() {
  const hash = location.hash;
  if (!hash.startsWith('#view=')) return false;
  try {
    const data = decodeState(hash.slice(6));
    state = { meds: data.meds || [], log: data.log || {}, snooze: {} };
    readonly = true;
    document.body.classList.add('readonly');
    const banner = document.createElement('div');
    banner.className = 'readonly-banner';
    banner.textContent = 'Caregiver view — read only. This is a shared snapshot of someone’s schedule.';
    document.body.insertBefore(banner, document.body.firstChild);
    return true;
  } catch (err) {
    console.warn('Could not read shared link.', err);
    return false;
  }
}

/* --------------------------------------------------------------------- */
/* Views                                                                  */
/* --------------------------------------------------------------------- */

function positionTabIndicator() {
  const indicator = $('#tab-indicator');
  const active = document.querySelector('.tab.is-active');
  if (!indicator || !active) return;
  indicator.style.width = active.offsetWidth + 'px';
  indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
}

function switchView(name) {
  // Slide the incoming view from the side you're moving toward.
  const prev = document.querySelector('.view.is-active');
  const order = $$('.tab[data-view]').map((t) => t.dataset.view);
  const prevName = prev ? prev.id.replace('view-', '') : null;
  const goingLeft = prevName && order.indexOf(name) < order.indexOf(prevName);

  $$('.view').forEach((v) => {
    v.classList.remove('from-left', 'from-right');
    v.classList.toggle('is-active', v.id === 'view-' + name);
  });
  const active = document.getElementById('view-' + name);
  if (active && prevName && prevName !== name) {
    active.classList.add(goingLeft ? 'from-left' : 'from-right');
  }

  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  positionTabIndicator();
  // Instant, not smooth — a tab switch is a new page, not a scroll.
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderAll() {
  renderToday();
  renderMeds();
  updateAlarmStatus();
}

/* ---------- theme ---------- */

const THEME_KEY = 'medbuddy.theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    void err;
  }
  $('#theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  $('#theme-toggle').textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')
  );
}

/* Small confirmation pill at the bottom of the screen. */
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), 2200);
}

function initScrollFx() {
  // The reveal hidden-state only activates with this class, so content
  // is never invisible if scripts fail.
  document.body.classList.add('js-reveal');

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 }
  );
  $$('.reveal').forEach((el) => io.observe(el));

  const topbar = document.querySelector('.topbar');
  const onScroll = () => topbar.classList.toggle('is-scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* --------------------------------------------------------------------- */
/* Speech input                                                           */
/* --------------------------------------------------------------------- */

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#mic-btn');
  if (!SR) {
    btn.hidden = true;
    return;
  }
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-US';
  let listening = false;

  rec.addEventListener('result', (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
    const box = $('#orders-input');
    box.value = (box.value + ' ' + text).trim();
  });
  rec.addEventListener('end', () => {
    listening = false;
    btn.textContent = 'Speak it';
    btn.classList.remove('is-on');
  });
  rec.addEventListener('error', () => {
    listening = false;
    btn.textContent = 'Speak it';
    btn.classList.remove('is-on');
  });

  btn.addEventListener('click', () => {
    if (listening) {
      rec.stop();
    } else {
      try {
        rec.start();
        listening = true;
        btn.textContent = 'Listening… tap to stop';
        btn.classList.add('is-on');
      } catch (err) {
        void err;
      }
    }
  });
}

/* --------------------------------------------------------------------- */
/* Insurance                                                              */
/* --------------------------------------------------------------------- */

let insuranceDocsCache = [];
let insuranceObjectUrls = [];
let pendingDocName = '';

function initInsurance() {
  renderInsuranceInfo();
  renderInsuranceExpiryBanner();
  loadInsuranceDocs();

  $('#ins-save').addEventListener('click', saveInsuranceInfo);

  $('#ins-add-doc-btn').addEventListener('click', () => {
    $('#ins-doc-form').hidden = false;
    $('#ins-doc-name').value = '';
    $('#ins-doc-name').focus();
  });
  $('#ins-doc-cancel').addEventListener('click', closeInsuranceDocForm);

  $$('.ins-doc-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#ins-doc-name').value = chip.dataset.docName;
    });
  });

  $('#ins-doc-choose-file').addEventListener('click', () => {
    const name = $('#ins-doc-name').value.trim();
    if (!name) {
      $('#ins-doc-name').focus();
      return;
    }
    pendingDocName = name;
    $('#ins-doc-file').click();
  });

  $('#ins-doc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !pendingDocName) return;
    await InsuranceStore.replaceDocument(pendingDocName, file.type, file);
    pendingDocName = '';
    closeInsuranceDocForm();
    await loadInsuranceDocs();
    toast('Document saved ✓');
  });

  $('#ins-show-card-btn').addEventListener('click', () => {
    const doc =
      insuranceDocsCache.find((d) => d.name === 'Insurance Card (Front)') || insuranceDocsCache[0];
    if (doc) viewInsuranceDoc(doc);
  });

  insViewerSheet = new SheetController(
    $('#ins-viewer'),
    document.querySelector('#ins-viewer .sheet-panel'),
    document.querySelector('#ins-viewer .sheet-handle')
  );
  $('#ins-viewer-close').addEventListener('click', closeInsuranceViewer);
  $('#ins-viewer').addEventListener('click', (e) => {
    if (e.target.id === 'ins-viewer') closeInsuranceViewer();
  });
}

function closeInsuranceDocForm() {
  $('#ins-doc-form').hidden = true;
  pendingDocName = '';
}

function renderInsuranceInfo() {
  $('#ins-provider').value = state.insurance.provider || '';
  $('#ins-member-id').value = state.insurance.memberId || '';
  $('#ins-group').value = state.insurance.groupNumber || '';
  $('#ins-plan').value = state.insurance.planType || '';
  $('#ins-phone').value = state.insurance.phone || '';
  $('#ins-expiry').value = state.insurance.expiryDate || '';
  $('#ins-notes').value = state.insurance.notes || '';
}

function saveInsuranceInfo() {
  state.insurance = {
    provider: $('#ins-provider').value.trim(),
    memberId: $('#ins-member-id').value.trim(),
    groupNumber: $('#ins-group').value.trim(),
    planType: $('#ins-plan').value.trim(),
    phone: $('#ins-phone').value.trim(),
    expiryDate: $('#ins-expiry').value,
    notes: $('#ins-notes').value.trim(),
  };
  save();
  renderInsuranceExpiryBanner();
  const note = $('#ins-saved-note');
  note.hidden = false;
  clearTimeout(saveInsuranceInfo._t);
  saveInsuranceInfo._t = setTimeout(() => (note.hidden = true), 2000);
}

function renderInsuranceExpiryBanner() {
  const banner = $('#ins-expiry-banner');
  if (!banner) return;
  const iso = state.insurance.expiryDate;
  if (!iso || readonly) {
    banner.hidden = true;
    return;
  }

  const days = daysBetween(todayISO(), iso);
  const dateLabel = new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  banner.classList.remove('notice-warn', 'notice-danger', 'notice-info');
  const title = $('#ins-expiry-title');
  const detail = $('#ins-expiry-detail');

  if (days < 0) {
    banner.classList.add('notice-danger');
    title.textContent = 'Insurance expired.';
    detail.textContent = `Expired ${dateLabel} (${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago). Renew it and update your card.`;
  } else if (days <= 30) {
    banner.classList.add('notice-warn');
    title.textContent = 'Insurance expiring soon.';
    detail.textContent = days === 0
      ? `Expires today, ${dateLabel}.`
      : `Expires ${dateLabel} — ${days} day${days === 1 ? '' : 's'} left.`;
  } else {
    banner.classList.add('notice-info');
    title.textContent = 'Insurance';
    detail.textContent = `Valid through ${dateLabel}.`;
  }

  banner.hidden = false;
}

async function loadInsuranceDocs() {
  insuranceDocsCache = await InsuranceStore.getAllDocuments();
  renderInsuranceDocs();
}

function renderInsuranceDocs() {
  insuranceObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  insuranceObjectUrls = [];

  const list = $('#ins-doc-list');
  list.innerHTML = '';

  $('#ins-doc-empty').hidden = insuranceDocsCache.length > 0;
  $('#ins-show-card-btn').hidden = insuranceDocsCache.length === 0;

  for (const doc of insuranceDocsCache) {
    const card = document.createElement('div');
    card.className = 'ins-doc-card';

    const thumb = document.createElement('div');
    thumb.className = 'ins-doc-thumb';
    if (doc.mimeType && doc.mimeType.startsWith('image/')) {
      const url = URL.createObjectURL(doc.blob);
      insuranceObjectUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = doc.name;
      thumb.append(img);
    } else {
      thumb.textContent = '\u{1F4C4}';
    }
    thumb.addEventListener('click', () => viewInsuranceDoc(doc));

    const body = document.createElement('div');
    body.className = 'ins-doc-body';
    const name = document.createElement('strong');
    name.textContent = doc.name;
    const date = document.createElement('span');
    date.className = 'muted small';
    date.textContent = 'Added ' + new Date(doc.addedAt).toLocaleDateString();
    body.append(name, date);

    const actions = document.createElement('div');
    actions.className = 'ins-doc-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-ghost small';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => viewInsuranceDoc(doc));

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'btn btn-ghost small';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', () => {
      pendingDocName = doc.name;
      $('#ins-doc-file').click();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger-link small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await InsuranceStore.deleteDocument(doc.id);
      await loadInsuranceDocs();
    });

    actions.append(viewBtn, replaceBtn, deleteBtn);
    card.append(thumb, body, actions);
    list.append(card);
  }
}

function viewInsuranceDoc(doc) {
  const body = $('#ins-viewer-body');
  body.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = doc.name;
  body.append(h);

  if (doc.mimeType && doc.mimeType.startsWith('image/')) {
    const url = URL.createObjectURL(doc.blob);
    insuranceObjectUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.className = 'ins-viewer-img';
    img.alt = doc.name;
    body.append(img);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'This document is a PDF. Open it in a new tab to view it.';
    const url = URL.createObjectURL(doc.blob);
    insuranceObjectUrls.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'btn btn-primary';
    link.textContent = 'Open PDF';
    body.append(p, link);
  }

  insViewerSheet.open();
}

function closeInsuranceViewer() {
  insViewerSheet.dismiss();
}

/* --------------------------------------------------------------------- */
/* Wiring                                                                 */
/* --------------------------------------------------------------------- */

/* --------------------------------------------------------------------- */
/* Find Care                                                              */
/* --------------------------------------------------------------------- */

/* --------------------------------------------------------------------- */
/* Scanner                                                                */
/* --------------------------------------------------------------------- */

/* --------------------------------------------------------------------- */
/* PWA install prompt                                                    */
/* --------------------------------------------------------------------- */

let deferredInstallPrompt = null;

function initInstallPrompt() {
  const btn = $('#install-btn');
  if (!btn) return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isStandalone) return; // already installed — nothing to offer

  if (isIOS) {
    // iOS Safari never fires beforeinstallprompt; show manual instructions instead.
    const hint = $('#ios-install-hint');
    if (hint) hint.hidden = false;
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    deferredInstallPrompt = null;
  });
}

let scanParsedMeds = null;

function initScanner() {
  $('#scan-btn').addEventListener('click', () => $('#scan-file').click());
  $('#dash-scan').addEventListener('click', () => { switchView('meds'); $('#scan-file').click(); });
  if ($('#home-learn-more')) {
    $('#home-learn-more').addEventListener('click', () => {
      $('.home-problem').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  if ($('#qs-scan')) $('#qs-scan').addEventListener('click', () => { switchView('meds'); $('#scan-file').click(); });
  $('#scan-file').addEventListener('change', handleScanFile);
  $('#scan-close').addEventListener('click', closeScan);
  $('#scan-lookup').addEventListener('click', () => {
    const name = $('#scan-name').value.trim();
    if (name) runFDALookup(name);
  });
  $('#scan-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const name = $('#scan-name').value.trim();
      if (name) runFDALookup(name);
    }
  });
  $('#scan-save').addEventListener('click', saveScanResult);
  $('#scan-retry').addEventListener('click', () => {
    closeScan();
    $('#scan-file').click();
  });
}

async function handleScanFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  // Show scan result card with loading
  $('#scan-result').hidden = false;
  $('#scan-loading').hidden = false;
  $('#scan-detected').hidden = true;
  $('#scan-error').hidden = true;
  $('#scan-preview').hidden = true;
  $('#scan-progress').textContent = 'Loading OCR engine…';

  // Show image preview
  const imgUrl = URL.createObjectURL(file);
  $('#scan-img').src = imgUrl;
  $('#scan-preview').hidden = false;

  try {
    const ocrText = await MedScanner.recognizeImage(file);

    if (!ocrText || ocrText.trim().length < 3) {
      $('#scan-loading').hidden = true;
      $('#scan-error').textContent = 'Could not read any text from that image. Try a clearer photo of the label.';
      $('#scan-error').hidden = false;
      return;
    }

    // Extract medicine name
    const name = MedScanner.extractMedicineFromOCR(ocrText);
    $('#scan-name').value = name || '';
    $('#scan-loading').hidden = true;
    $('#scan-detected').hidden = false;

    // Parse the OCR text for schedule info
    const parsed = DoseParser.parseOrders(ocrText);
    scanParsedMeds = parsed.meds;
    renderScanParsed(parsed.meds);

    // Auto-lookup if we found a name
    if (name) runFDALookup(name);

  } catch (err) {
    $('#scan-loading').hidden = true;
    $('#scan-error').textContent = err.message || 'Scan failed. Try again.';
    $('#scan-error').hidden = false;
    console.warn('Scan error:', err);
  }

  // Reset file input so the same file can be re-selected
  e.target.value = '';
}

async function runFDALookup(name) {
  const infoEl = $('#scan-info');
  infoEl.innerHTML = '<div class="loading"><div class="spinner"></div><span>Looking up ' + name + '…</span></div>';
  infoEl.hidden = false;

  const info = await MedScanner.lookupDrug(name);
  infoEl.innerHTML = '';

  if (!info) {
    infoEl.innerHTML = '<p class="muted">No FDA data found for "' + name + '". You can still save it to your schedule.</p>';
    return;
  }

  const card = document.createElement('div');
  card.className = 'scan-info-card';

  const title = document.createElement('h4');
  title.textContent = info.displayName;
  card.append(title);

  if (info.drugClass) {
    const cls = document.createElement('div');
    cls.className = 'drug-class';
    cls.textContent = info.drugClass;
    card.append(cls);
  }

  if (info.purpose) addInfoItem(card, 'What it’s for', info.purpose);
  if (info.sideEffects) addInfoItem(card, 'Common side effects', info.sideEffects);
  if (info.warnings) addInfoItem(card, 'Warnings', info.warnings);

  infoEl.append(card);

  // Only fill in the name if the field is empty (manual lookup)
  if (info.displayName && !$('#scan-name').value.trim()) {
    $('#scan-name').value = info.displayName;
  }
}

function addInfoItem(parent, label, text) {
  const item = document.createElement('div');
  item.className = 'scan-info-item';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const p = document.createElement('p');
  p.textContent = text;
  item.append(strong, p);
  parent.append(item);
}

function renderScanParsed(meds) {
  const body = $('#scan-parsed-body');
  body.innerHTML = '';
  if (!meds.length) { $('#scan-parsed').hidden = true; return; }

  for (const med of meds) {
    const bits = [];
    if (med.dose) bits.push(med.dose);
    bits.push(med.frequencyLabel);
    if (med.durationDays) bits.push(med.durationDays + ' days');
    med.instructions.forEach((ins) => bits.push(ins.text));

    const div = document.createElement('div');
    div.className = 'pill';
    div.style.display = 'block';
    div.style.marginBottom = '0.3rem';
    div.textContent = bits.join(' · ');
    body.append(div);
  }
  $('#scan-parsed').hidden = false;
}

function saveScanResult() {
  const name = $('#scan-name').value.trim();
  if (!name) { $('#scan-name').focus(); return; }

  if (scanParsedMeds && scanParsedMeds.length) {
    // Use parsed meds but update the name from the scan
    scanParsedMeds[0].name = name;
    state.meds.push(...scanParsedMeds);
  } else {
    // No schedule parsed — create a basic entry
    state.meds.push({
      id: 'm' + Math.random().toString(36).slice(2, 9),
      name,
      dose: '',
      times: ['09:00'],
      frequencyLabel: 'Once daily, morning',
      durationDays: null,
      asNeeded: false,
      instructions: [],
      raw: 'Added from scan',
      startDate: DoseParser.todayISO(),
    });
  }

  save();
  closeScan();
  renderAll();
  switchView('today');
  toast('Saved to your schedule ✓');
}

function closeScan() {
  $('#scan-result').hidden = true;
  scanParsedMeds = null;
  $('#scan-info').innerHTML = '';
  $('#scan-parsed-body').innerHTML = '';
}

let selectedTaxonomy = null;
let selectedOsmTag = null;
let userCoords = null;       // { lat, lon }
let userGeo = null;          // { countryCode, postcode, displayName, ... }

function initFindCare() {
  const chipsWrap = $('#specialty-chips');
  for (const spec of DoctorFinder.SPECIALTIES) {
    const btn = document.createElement('button');
    btn.className = 'spec-chip';
    btn.innerHTML =
      '<span class="spec-chip-icon">' + spec.icon + '</span><span class="spec-chip-name">' + spec.name + '</span>';
    btn.addEventListener('click', () => {
      $$('.spec-chip').forEach((c) => c.classList.remove('is-active'));
      btn.classList.add('is-active');
      selectedTaxonomy = spec.taxonomy;
      selectedOsmTag = spec.osm;
      $('#symptom-input').value = '';
      $('#matched-specialties').hidden = true;
      updateFindButton();
    });
    chipsWrap.append(btn);
  }

  $('#symptom-input').addEventListener('input', debounce(() => {
    const text = $('#symptom-input').value.trim();
    if (!text) {
      $('#matched-specialties').hidden = true;
      return;
    }
    const matches = DoctorFinder.matchSpecialties(text);
    renderMatches(matches);
    if (matches.length) {
      selectedTaxonomy = matches[0].taxonomy;
      selectedOsmTag = matches[0].osm;
      $$('.spec-chip').forEach((c) => c.classList.remove('is-active'));
    }
  }, 300));

  $('#locate-btn').addEventListener('click', doGeolocate);
  $('#location-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doManualLocation();
  });
  $('#location-clear').addEventListener('click', clearLocation);
  $('#find-btn').addEventListener('click', runDoctorSearch);
}

async function doGeolocate() {
  const btn = $('#locate-btn');
  btn.textContent = 'Detecting…';
  btn.disabled = true;

  try {
    userCoords = await DoctorFinder.getUserLocation();
    userGeo = await DoctorFinder.reverseGeocode(userCoords.lat, userCoords.lon);
    showLocation(userGeo ? userGeo.displayName : `${userCoords.lat.toFixed(2)}, ${userCoords.lon.toFixed(2)}`);
  } catch (err) {
    btn.textContent = '\u{1F4CD} Use my location';
    btn.disabled = false;
    $('#location-input').placeholder = err.message || 'Type a city or address';
    $('#location-input').focus();
  }
}

async function doManualLocation() {
  const query = $('#location-input').value.trim();
  if (!query) return;

  $('#locate-btn').disabled = true;
  $('#location-input').disabled = true;

  try {
    const geo = await DoctorFinder.geocodeAddress(query);
    userCoords = { lat: geo.lat, lon: geo.lon };
    userGeo = await DoctorFinder.reverseGeocode(geo.lat, geo.lon);
    showLocation(userGeo ? userGeo.displayName : query);
  } catch (err) {
    $('#location-input').disabled = false;
    $('#locate-btn').disabled = false;
    alert(err.message || 'Could not find that location.');
  }
}

function showLocation(name) {
  $('#location-status').hidden = false;
  $('#location-name').textContent = '\u{1F4CD} Near ' + name;
  $('.location-row').style.display = 'none';
  updateFindButton();
}

function clearLocation() {
  userCoords = null;
  userGeo = null;
  $('#location-status').hidden = true;
  const row = document.querySelector('.location-row');
  row.style.display = '';
  const btn = $('#locate-btn');
  btn.textContent = '\u{1F4CD} Use my location';
  btn.disabled = false;
  $('#location-input').disabled = false;
  $('#location-input').value = '';
  updateFindButton();
}

function updateFindButton() {
  $('#find-btn').disabled = !userCoords;
}

function renderMatches(matches) {
  const wrap = $('#matched-specialties');
  wrap.innerHTML = '';
  if (!matches.length) { wrap.hidden = true; return; }

  const label = document.createElement('div');
  label.className = 'match-label';
  label.textContent = 'Recommended specialists';
  wrap.append(label);

  for (const spec of matches) {
    const card = document.createElement('div');
    card.className = 'match-card';

    const icon = document.createElement('span');
    icon.className = 'match-icon';
    icon.textContent = spec.icon;

    const body = document.createElement('div');
    body.className = 'match-body';
    const name = document.createElement('div');
    name.className = 'match-name';
    name.textContent = spec.name;
    const desc = document.createElement('div');
    desc.className = 'match-desc';
    desc.textContent = spec.desc;
    body.append(name, desc);

    card.append(icon, body);
    card.addEventListener('click', () => {
      selectedTaxonomy = spec.taxonomy;
      selectedOsmTag = spec.osm;
      $$('.spec-chip').forEach((c) => c.classList.remove('is-active'));
      wrap.querySelectorAll('.match-card').forEach((c) =>
        c.style.outline = c === card ? '2px solid var(--accent)' : 'none'
      );
      if (userCoords) runDoctorSearch();
    });
    wrap.append(card);
  }
  wrap.hidden = false;
}

async function runDoctorSearch() {
  if (!userCoords) {
    $('#locate-btn').focus();
    return;
  }

  if (!selectedTaxonomy) {
    const text = $('#symptom-input').value.trim();
    if (text) {
      const m = DoctorFinder.matchSpecialties(text);
      if (m.length) {
        selectedTaxonomy = m[0].taxonomy;
        selectedOsmTag = m[0].osm;
      }
    }
    if (!selectedTaxonomy) {
      selectedTaxonomy = 'Family Medicine';
      selectedOsmTag = 'general';
    }
  }

  $('#doctors-loading').hidden = false;
  $('#loading-text').textContent = 'Searching for doctors nearby…';
  $('#doctors-list').innerHTML = '';
  $('#doctors-empty').hidden = true;
  $('#data-credit').hidden = true;

  try {
    const countryCode = userGeo ? userGeo.countryCode : '';
    const postcode = userGeo ? userGeo.postcode : '';
    const result = await DoctorFinder.searchNearby(
      userCoords.lat, userCoords.lon,
      countryCode, selectedTaxonomy, selectedOsmTag, postcode
    );
    $('#doctors-loading').hidden = true;

    if (!result.results.length) {
      $('#doctors-empty').hidden = false;
      return;
    }

    renderDoctors(result.results);

    const credit = $('#data-credit');
    if (result.source === 'npi') {
      credit.innerHTML = 'Data from the <a href="https://npiregistry.cms.hhs.gov/" target="_blank" rel="noopener">CMS National Provider Identifier Registry</a>, a free public database of US healthcare providers.';
    } else {
      credit.innerHTML = 'Data from <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">OpenStreetMap</a> contributors.' +
        (result.widened ? ' Search widened to 25 km — few results nearby.' : '');
    }
    credit.hidden = false;
  } catch (err) {
    $('#doctors-loading').hidden = true;
    $('#doctors-list').innerHTML =
      '<p class="muted">Could not search for doctors. Check your connection and try again.</p>';
    console.warn('Doctor search error:', err);
  }
}

function renderDoctors(docs) {
  const list = $('#doctors-list');
  list.innerHTML = '';

  for (const doc of docs) {
    const card = document.createElement('div');
    card.className = 'doc-card';

    const top = document.createElement('div');
    top.className = 'doc-top';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = doc.name;
    const cred = document.createElement('span');
    cred.className = 'doc-cred';
    cred.textContent = doc.credential;
    top.append(name, cred);

    const spec = document.createElement('div');
    spec.className = 'doc-specialty';
    spec.textContent = doc.specialty;

    const dist = DoctorFinder.formatDistance(doc.distanceKm);
    if (dist) {
      const distEl = document.createElement('div');
      distEl.className = 'doc-distance';
      distEl.textContent = dist;
      card.append(top, spec, distEl);
    } else {
      card.append(top, spec);
    }

    const addr = document.createElement('div');
    addr.className = 'doc-address';
    addr.textContent = doc.address;
    card.append(addr);

    const actions = document.createElement('div');
    actions.className = 'doc-actions';

    if (doc.phone) {
      const call = document.createElement('a');
      call.className = 'call-link';
      call.href = 'tel:' + doc.phone;
      call.textContent = '\u{1F4DE} ' + doc.phoneDisplay;
      actions.append(call);
    }

    const dirs = document.createElement('a');
    dirs.href = DoctorFinder.mapsLink(doc);
    dirs.target = '_blank';
    dirs.rel = 'noopener';
    dirs.textContent = '\u{1F4CD} Directions';
    actions.append(dirs);

    if (doc.website) {
      const web = document.createElement('a');
      web.className = 'doc-website';
      web.href = doc.website;
      web.target = '_blank';
      web.rel = 'noopener';
      web.textContent = '\u{1F310} Website';
      actions.append(web);
    }

    card.append(actions);
    list.append(card);
  }
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function init() {
  /* State is already in place by the time this runs — boot() handles
     readonly links, sign-in, and cloud hydration first. */
  $$('.tab[data-view]').forEach((tab) =>
    tab.addEventListener('click', () => switchView(tab.dataset.view))
  );
  $('#signout-btn').addEventListener('click', () => Cloud.signOut());
  $$('[data-goto]').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.goto))
  );

  $('#parse-btn').addEventListener('click', runParse);
  $('#save-btn').addEventListener('click', savePending);
  $('#discard-btn').addEventListener('click', () => {
    pending = null;
    $('#parse-result').hidden = true;
  });
  $('#clear-btn').addEventListener('click', () => {
    $('#orders-input').value = '';
    $('#parse-result').hidden = true;
    pending = null;
  });

  $$('[data-example]').forEach((chip) =>
    chip.addEventListener('click', () => {
      $('#orders-input').value = EXAMPLES[chip.dataset.example];
      runParse();
    })
  );

  $$('.enable-alarms-btn').forEach((btn) => btn.addEventListener('click', enableAlarms));
  $('#test-alarm').addEventListener('click', testAlarm);
  $('#alarm-taken').addEventListener('click', () => dismissAlarm('taken'));
  $('#alarm-snooze').addEventListener('click', () => dismissAlarm('snooze'));
  $('#share-btn').addEventListener('click', shareWithCaregiver);

  medSheet = new SheetController(
    $('#sheet'),
    document.querySelector('#sheet .sheet-panel'),
    document.querySelector('#sheet .sheet-handle')
  );
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.id === 'sheet') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  setupMic();
  initFindCare();
  initScanner();
  initInstallPrompt();
  initInsurance();
  initLeaderboard();
  initScrollFx();
  positionTabIndicator();
  window.addEventListener('resize', positionTabIndicator);
  renderAll();

  setInterval(() => {
    renderToday();
    checkDueDoses();
  }, 1000);

  // Re-check immediately when the tab comes back into focus.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      renderToday();
      checkDueDoses();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW failed', err));
  }
}

/* --------------------------------------------------------------------- */
/* Boot — decide between readonly link, sign-in, and offline fallback     */
/* --------------------------------------------------------------------- */

const OWNER_KEY = 'dosenote.owner';

async function hydrateFromCloud() {
  const uid = Cloud.userId();

  /* A different account signed in on this device — never let the previous
     user's cached data leak into (or get pushed up to) this account. */
  const prevOwner = localStorage.getItem(OWNER_KEY);
  if (prevOwner && prevOwner !== uid) {
    localStorage.removeItem(STORE_KEY);
    try {
      indexedDB.deleteDatabase('medbuddy-insurance');
    } catch (err) {
      void err;
    }
  }
  localStorage.setItem(OWNER_KEY, uid);

  load();
  try {
    const remote = await Cloud.fetchState();
    if (remote) {
      state = {
        meds: remote.meds || [],
        log: remote.log || {},
        snooze: remote.snooze || {},
        insurance: { ...EMPTY_INSURANCE, ...(remote.insurance || {}) },
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } else {
      // First sign-in for this account: seed the cloud from this device.
      Cloud.pushState(state);
    }
  } catch (err) {
    console.warn('Could not reach the cloud — using the local copy.', err);
  }

  // Quietly check leaderboard membership so streak updates sync in the
  // background without the user needing to open the sheet first.
  try {
    myLeaderboardEntry = await Cloud.getMyLeaderboardEntry();
  } catch (err) {
    void err; // leaderboard table may not exist yet — never blocks boot
  }
}

async function boot() {
  // Theme toggle works everywhere, including the sign-in screen.
  initTheme();

  // Caregiver links stay account-free: the data travels in the URL itself.
  if (tryReadonlyMode()) {
    document.body.classList.remove('booting');
    init();
    return;
  }

  // Offline and the auth library never loaded: run from the local cache.
  if (!Cloud.available()) {
    document.body.classList.remove('booting');
    load();
    init();
    return;
  }

  const session = await Cloud.getSession();
  document.body.classList.remove('booting');

  if (session) {
    await hydrateFromCloud();
    $('#signout-btn').hidden = false;
    init();
  } else {
    Cloud.showAuthScreen(async () => {
      await hydrateFromCloud();
      $('#signout-btn').hidden = false;
      init();
    });
  }
}

document.addEventListener('DOMContentLoaded', boot);
