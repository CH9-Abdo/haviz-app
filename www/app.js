// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
const API = 'https://api.alquran.cloud/v1';
const STRICT_MODE_KEY = 'strict_mode';
const WRITE_MODE_KEY = 'write_mode'; // 'ayah' | 'surah'
let allSurahs   = [];
let currentSurah = null;
let currentAyahs = [];
let currentMode  = 'read';
let writeMode    = localStorage.getItem(WRITE_MODE_KEY) || 'ayah';
let score        = { correct: 0, total: 0 };
let surahScorePct = null;
let currentAudio = null;
let isDark = localStorage.getItem('theme') === 'dark';

// Apply saved theme
if (isDark) {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('theme-icon').textContent   = '☀️';
  document.getElementById('theme-icon-2').textContent = '☀️';
}

// ──────────────────────────────────────────────
// ARABIC NORMALIZER  (removes tashkeel, tatweel,
// alef variants, taa marbuta, alef maqsura)
// ──────────────────────────────────────────────
function normalizeArabic(text) {
  if (!text) return '';
  return text
    // Normalize common Arabic ligatures used in some Quran texts
    .replace(/\uFDF2/g, 'الله') // ﷲ
    // Remove all tashkeel / diacritics (harakat, shadda, tanwin…)
    // + Quran annotation/stop marks that appear in some editions
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u06DD-\u06DE\u08D3-\u08FF]/g, '')
    // Remove tatweel   ـ
    .replace(/\u0640/g, '')
    // Remove common punctuation/ornaments (keep letters/numbers/spaces)
    .replace(/[«»"“”'‘’`~!@#$%^&*()_\-+=\[\]{}|\\:;,.?\/،؛؟…]/g, ' ')
    // Unify alef forms  أ إ آ → ا
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    // Unify alef wasla  ٱ → ا
    .replace(/\u0671/g, '\u0627')
    // Unify taa marbuta  ة → ه
    .replace(/\u0629/g, '\u0647')
    // Unify alef maqsura  ى → ي
    .replace(/\u0649/g, '\u064A')
    // Unify waw variants
    .replace(/\u0624/g, '\u0648')
    // Unify yaa with hamza
    .replace(/\u0626/g, '\u064A')
    // Unify Persian yaa  ی → ي (in case user keyboard uses it)
    .replace(/\u06CC/g, '\u064A')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toArabicIndicNumber(n) {
  const digits = '٠١٢٣٤٥٦٧٨٩';
  return String(n).replace(/\d/g, d => digits[Number(d)]);
}

function initMushafAutosize() {
  const inputs = document.querySelectorAll('.mushaf-input');
  inputs.forEach((el) => {
    const resize = () => {
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, 48) + 'px';
    };
    el.addEventListener('input', resize);
    resize();
  });
}

function tokenizeForDiff(text, isStrict) {
  const base = isStrict ? String(text || '').trim() : normalizeArabic(text);
  if (!base) return [];
  return base.split(/\s+/g).filter(Boolean);
}

// Myers diff on word arrays (transforms a -> b)
function diffWords(aWords, bWords) {
  const N = aWords.length;
  const M = bWords.length;
  const max = N + M;
  const offset = max;
  let v = new Array(2 * max + 1).fill(0);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + offset;
      let x;
      if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
        x = v[kIdx + 1]; // insertion
      } else {
        x = v[kIdx - 1] + 1; // deletion
      }
      let y = x - k;
      while (x < N && y < M && aWords[x] === bWords[y]) {
        x++;
        y++;
      }
      v[kIdx] = x;
      if (x >= N && y >= M) {
        return backtrackDiff(trace, aWords, bWords, offset);
      }
    }
  }
  return [];
}

function backtrackDiff(trace, aWords, bWords, offset) {
  let x = aWords.length;
  let y = bWords.length;
  const ops = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const kIdx = k + offset;
    let prevK;

    if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', value: aWords[x - 1] });
      x--;
      y--;
    }

    if (d === 0) break;

    if (x === prevX) {
      ops.push({ type: 'insert', value: bWords[y - 1] });
      y--;
    } else {
      ops.push({ type: 'delete', value: aWords[x - 1] });
      x--;
    }
  }

  ops.reverse();
  return ops;
}

function buildDiffHtml(userText, correctText, isStrict) {
  const correctWords = tokenizeForDiff(correctText, isStrict);
  const userWords = tokenizeForDiff(userText, isStrict);
  const ops = diffWords(correctWords, userWords);

  const correctOut = [];
  const userOut = [];
  let equalCount = 0;

  for (const op of ops) {
    const word = escapeHtml(op.value);
    if (op.type === 'equal') {
      equalCount++;
      correctOut.push(word);
      userOut.push(word);
    } else if (op.type === 'delete') {
      correctOut.push(`<span class="diff diff-del">${word}</span>`);
    } else if (op.type === 'insert') {
      userOut.push(`<span class="diff diff-ins">${word}</span>`);
    }
  }

  const total = Math.max(1, correctWords.length);
  const pct = Math.round((equalCount / total) * 100);

  return {
    pct,
    html: `
      <div class="diff-block">
        <div class="diff-title">نصّك</div>
        <div class="diff-line">${userOut.join(' ') || '—'}</div>
        <div class="diff-title">الصواب${isStrict ? '' : ' (بدون تشكيل)'}</div>
        <div class="diff-line">${correctOut.join(' ') || '—'}</div>
      </div>`
  };
}

// ──────────────────────────────────────────────
// STRICT MODE (persisted; default OFF)
// ──────────────────────────────────────────────
function initStrictModeControl() {
  const el = document.getElementById('strict-mode');
  if (!el) return;

  const saved = localStorage.getItem(STRICT_MODE_KEY);
  el.checked = saved === '1'; // default: false

  el.addEventListener('change', () => {
    localStorage.setItem(STRICT_MODE_KEY, el.checked ? '1' : '0');
  });
}

function initWriteModeControl() {
  const saved = localStorage.getItem(WRITE_MODE_KEY);
  if (saved === 'ayah' || saved === 'surah') writeMode = saved;
  applyWriteModeUI();
}

function setWriteMode(mode) {
  if (mode !== 'ayah' && mode !== 'surah') return;
  writeMode = mode;
  localStorage.setItem(WRITE_MODE_KEY, writeMode);
  surahScorePct = null;
  applyWriteModeUI();

  // Recompute score UI without saving progress
  if (currentMode === 'memorize' && writeMode === 'ayah') {
    recalcScore(false);
  } else {
    updateScoreUI();
  }
}

function applyWriteModeUI() {
  const wrap = document.getElementById('write-mode-wrap');
  const btnAyah = document.getElementById('write-mode-ayah');
  const btnSurah = document.getElementById('write-mode-surah');
  const content = document.getElementById('study-content');
  const surahCard = document.getElementById('surah-write-card');

  if (wrap) wrap.style.display = currentMode === 'memorize' ? 'flex' : 'none';

  if (btnAyah) btnAyah.classList.toggle('active', writeMode === 'ayah');
  if (btnSurah) btnSurah.classList.toggle('active', writeMode === 'surah');

  if (content) content.classList.toggle('surah-write-mode', currentMode === 'memorize' && writeMode === 'surah');

  if (surahCard) {
    surahCard.style.display = currentMode === 'memorize' && writeMode === 'surah' ? 'block' : 'none';
  }
}

// ──────────────────────────────────────────────
// THEME
// ──────────────────────────────────────────────
function toggleTheme() {
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  const icon = isDark ? '☀️' : '🌙';
  document.getElementById('theme-icon').textContent   = icon;
  document.getElementById('theme-icon-2').textContent = icon;
}

// ──────────────────────────────────────────────
// NAVIGATION
// ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function showTab(tab) {
  if (tab === 'home') {
    showScreen('home');
  } else if (tab === 'progress') {
    showScreen('progress');
    renderProgress();
  }
}

function goBack() {
  stopAudio();
  showScreen('home');
}

// ──────────────────────────────────────────────
// FETCH SURAH LIST
// ──────────────────────────────────────────────
async function loadSurahList() {
  const cached = localStorage.getItem('surah_list');
  if (cached) {
    allSurahs = JSON.parse(cached);
    renderList(allSurahs);
    return;
  }
  try {
    const res  = await fetch(API + '/surah');
    const data = await res.json();
    allSurahs  = data.data;
    localStorage.setItem('surah_list', JSON.stringify(allSurahs));
    renderList(allSurahs);
  } catch(e) {
    document.getElementById('surah-list').innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text-muted)">تعذّر الاتصال بالإنترنت.<br>يرجى المحاولة مرة أخرى.</div>';
  }
}

function renderList(list) {
  const container = document.getElementById('surah-list');
  if (!list.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">لا توجد نتائج</div>';
    return;
  }
  container.innerHTML = list.map(s => `
    <div class="surah-item" onclick="openSurah(${s.number})">
      <div class="surah-num">${s.number}</div>
      <div class="surah-info">
        <div class="surah-arabic">${s.name}</div>
        <div class="surah-english">${s.englishName} · ${s.englishNameTranslation}</div>
      </div>
      <div class="surah-meta">
        <div class="surah-count">${s.numberOfAyahs} آية</div>
        <span class="surah-type ${s.revelationType === 'Meccan' ? 'meccan' : 'medinan'}">
          ${s.revelationType === 'Meccan' ? 'مكية' : 'مدنية'}
        </span>
      </div>
    </div>
  `).join('');
}

document.getElementById('surah-search').addEventListener('input', function () {
  const q = this.value.trim();
  if (!q) { renderList(allSurahs); return; }
  const filtered = allSurahs.filter(s =>
    s.name.includes(q) ||
    s.englishName.toLowerCase().includes(q.toLowerCase()) ||
    String(s.number).includes(q)
  );
  renderList(filtered);
});

// ──────────────────────────────────────────────
// OPEN SURAH
// ──────────────────────────────────────────────
async function openSurah(num) {
  currentSurah = allSurahs.find(s => s.number === num);
  document.getElementById('study-title').textContent = currentSurah.name;
  showScreen('study');
  setMode('read');

  document.getElementById('study-content').innerHTML =
    '<div class="loader-wrap"><div class="loader"></div><div class="loader-text">جاري تحميل السورة...</div></div>';

  try {
    const [arAyahs, enAyahs] = await Promise.all([
      fetchSurah(num, 'ar.alafasy'),
      fetchSurah(num, 'en.asad')
    ]);
    
    const BASMALA_TEXT = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
    const BASMALA_NORMALIZED = normalizeArabic(BASMALA_TEXT);

    currentAyahs = arAyahs.map((a, i) => {
      let text = a.text;
      // If it's the first ayah and NOT Surah 1 (Fatiha) and NOT Surah 9 (Tawbah)
      if (num !== 1 && num !== 9 && i === 0) {
        // Remove Basmala if it exists at the start (handling both exact and normalized)
        if (text.startsWith(BASMALA_TEXT)) {
          text = text.substring(BASMALA_TEXT.length).trim();
        } else {
          // Fallback: check normalized version in case of different tashkeel
          const normA = normalizeArabic(text);
          if (normA.startsWith(BASMALA_NORMALIZED)) {
            // This is trickier, we'll try to find the first word after Basmala
            const words = text.split(/\s+/);
            // Basmala usually is 4 words: بسم الله الرحمن الرحيم
            text = words.slice(4).join(' ');
          }
        }
      }
      return {
        ...a,
        text: text,
        translation: enAyahs[i]?.text || ''
      };
    });
    renderStudy();
  } catch(e) {
    document.getElementById('study-content').innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text-muted)">تعذّر تحميل السورة.<br>تحقق من اتصالك بالإنترنت.</div>';
  }
}

async function fetchSurah(num, edition) {
  const key    = `surah_${num}_${edition}`;
  const cached = localStorage.getItem(key);
  if (cached) return JSON.parse(cached);
  const res  = await fetch(`${API}/surah/${num}/${edition}`);
  const data = await res.json();
  const ayahs = data.data.ayahs;
  localStorage.setItem(key, JSON.stringify(ayahs));
  return ayahs;
}

// ──────────────────────────────────────────────
// RENDER AYAHS
// ──────────────────────────────────────────────
function renderStudy() {
  let html = '';

  // Full-surah write card (shown only when "السورة كاملة" is active)
  const basmala = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ';
  html += `
    <div class="ayah-card surah-write-card" id="surah-write-card" style="display:none">
      <div class="surah-write-title">📝 اكتب السورة كاملة</div>
      <div class="surah-write-hint">اكتب النص كما في صفحة مصحف، وستظهر أرقام الآيات في نهاية كل آية. (Enter للانتقال للآية التالية، Ctrl+Enter للتحقق)</div>
      <div class="mushaf-page" id="surah-mushaf-page">
        ${(currentSurah.number !== 9 && currentSurah.number !== 1) ? `
          <div class="mushaf-line mushaf-basmala static-basmala">
            <div class="basmala-text-static">${basmala}</div>
          </div>
        ` : ''}
        ${currentAyahs.map((a, i) => `
          <div class="mushaf-line" data-ayah-idx="${i}">
            <textarea class="mushaf-input" id="surah-ayah-input-${i}" rows="1"
              placeholder="${i === 0 && currentSurah.number === 1 ? basmala : 'اكتب الآية...'}"
              onkeydown="handleSurahKey(event, ${i})"></textarea>
            <span class="mushaf-num" aria-hidden="true">﴿${toArabicIndicNumber(a.numberInSurah)}﴾</span>
            <div class="feedback-wrap" id="surah-ayah-feedback-${i}"></div>
          </div>
        `).join('')}
      </div>
      <button class="check-btn" onclick="checkSurahFull()">تحقق ✓</button>
      <div class="feedback-wrap" id="surah-write-feedback"></div>
    </div>`;

  // Basmala (except surah 9 Al-Tawbah)
  if (currentSurah.number !== 9) {
    html += `<div class="basmala">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>`;
  }

  currentAyahs.forEach((ayah, idx) => {
    html += `
      <div class="ayah-card" id="ayah-card-${idx}">
        <div class="ayah-header">
          <div class="ayah-num">${ayah.numberInSurah}</div>
          <div class="ayah-actions">
            <button class="ayah-btn audio-btn" id="audio-btn-${idx}"
              onclick="playAudio(${ayah.number}, ${idx})" title="استمع">🔊</button>
            <button class="ayah-btn" id="eye-btn-${idx}"
              onclick="toggleAyah(${idx})" title="إخفاء / إظهار">👁</button>
          </div>
        </div>
        <div class="ayah-text" id="ayah-text-${idx}">${ayah.text}</div>
        <div class="ayah-blank" id="ayah-blank-${idx}"></div>
        <div class="ayah-translation" id="ayah-trans-${idx}">${ayah.translation}</div>
        <div class="ayah-input-wrap" id="ayah-input-wrap-${idx}">
          <textarea class="ayah-input" id="ayah-input-${idx}"
            placeholder="اكتب الآية هنا..." rows="2"
            onkeydown="handleInputKey(event, ${idx})"></textarea>
          <button class="check-btn" onclick="checkAyah(${idx})">تحقق ✓</button>
          <div class="feedback-wrap" id="feedback-${idx}"></div>
        </div>
      </div>`;
  });

  document.getElementById('study-content').innerHTML = html;
  score = { correct: 0, total: currentAyahs.length };
  updateScoreUI();
  applyWriteModeUI();
  initMushafAutosize();
}

// ──────────────────────────────────────────────
// MODE
// ──────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  document.getElementById('btn-read').classList.toggle('active', mode === 'read');
  document.getElementById('btn-memorize').classList.toggle('active', mode === 'memorize');

  const content    = document.getElementById('study-content');
  const scoreBar   = document.getElementById('score-bar-wrap');
  const memCtrl    = document.getElementById('mem-controls');
  const strictWrap = document.getElementById('strict-toggle-wrap');
  const writeWrap  = document.getElementById('write-mode-wrap');

  if (mode === 'memorize') {
    content.classList.add('memorize-mode');
    scoreBar.style.display   = 'flex';
    memCtrl.style.display    = 'flex';
    strictWrap.style.display = 'flex';
    if (writeWrap) writeWrap.style.display = 'flex';
    currentAyahs.forEach((_, i) => hideAyah(i));
    score = { correct: 0, total: currentAyahs.length };
    updateScoreUI();
  } else {
    content.classList.remove('memorize-mode');
    scoreBar.style.display   = 'none';
    memCtrl.style.display    = 'none';
    strictWrap.style.display = 'none';
    if (writeWrap) writeWrap.style.display = 'none';
    currentAyahs.forEach((_, i) => {
      document.getElementById('ayah-card-' + i).classList.remove('ayah-hidden');
      document.getElementById('eye-btn-' + i).textContent = '👁';
      clearFeedback(i);
    });
  }
  applyWriteModeUI();
}

// ──────────────────────────────────────────────
// HIDE / REVEAL
// ──────────────────────────────────────────────
function toggleAyah(idx) {
  const card = document.getElementById('ayah-card-' + idx);
  if (card.classList.contains('ayah-hidden')) {
    card.classList.remove('ayah-hidden');
    document.getElementById('eye-btn-' + idx).textContent = '👁';
  } else {
    hideAyah(idx);
  }
}

function hideAyah(idx) {
  document.getElementById('ayah-card-' + idx).classList.add('ayah-hidden');
  document.getElementById('eye-btn-' + idx).textContent = '🙈';
}

function revealAll() {
  currentAyahs.forEach((_, i) => {
    document.getElementById('ayah-card-' + i).classList.remove('ayah-hidden');
    document.getElementById('eye-btn-' + i).textContent = '👁';
  });
  showToast('👁 تم كشف جميع الآيات');
}

function resetAll() {
  currentAyahs.forEach((_, i) => {
    hideAyah(i);
    clearFeedback(i);
  });
  score = { correct: 0, total: currentAyahs.length };
  surahScorePct = null;
  updateScoreUI();
  const surahFb  = document.getElementById('surah-write-feedback');
  if (surahFb) { surahFb.className = 'feedback-wrap'; surahFb.innerHTML = ''; }
  const basmalaInp = document.getElementById('surah-basmala-input');
  const basmalaFb  = document.getElementById('surah-basmala-feedback');
  if (basmalaInp) basmalaInp.value = '';
  if (basmalaFb)  { basmalaFb.className = 'feedback-wrap'; basmalaFb.innerHTML = ''; }
  currentAyahs.forEach((_, i) => {
    const inp = document.getElementById('surah-ayah-input-' + i);
    const fb  = document.getElementById('surah-ayah-feedback-' + i);
    if (inp) { inp.className = 'mushaf-input'; inp.value = ''; }
    if (fb)  { fb.className = 'feedback-wrap'; fb.innerHTML = ''; }
  });
  showToast('↺ تمت إعادة التعيين');
}

// ──────────────────────────────────────────────
// CHECK AYAH  ← FIXED: strict mode OFF by default
// ──────────────────────────────────────────────
function checkAyah(idx) {
  const input    = document.getElementById('ayah-input-' + idx);
  const feedback = document.getElementById('feedback-' + idx);
  const userText = input.value.trim();

  if (!userText) { showToast('يرجى كتابة الآية أولاً'); return; }

  const original  = currentAyahs[idx].text;
  const isStrict  = document.getElementById('strict-mode').checked;

  // Compare
  const strictCorrect = userText === original.trim();
  const looseCorrect  = normalizeArabic(userText) === normalizeArabic(original);
  const isCorrect = isStrict ? strictCorrect : looseCorrect;

  input.className = 'ayah-input ' + (isCorrect ? 'correct' : 'wrong');
  feedback.className = 'feedback-wrap show ' + (isCorrect ? 'feedback-correct' : 'feedback-wrong');

  // Reveal the ayah text regardless
  document.getElementById('ayah-card-' + idx).classList.remove('ayah-hidden');
  document.getElementById('eye-btn-' + idx).textContent = '👁';

  if (isCorrect) {
    feedback.innerHTML = '✓ أحسنت! الإجابة صحيحة';
  } else {
    const diff = buildDiffHtml(userText, original, isStrict);
    feedback.innerHTML = `
      <div class="feedback-label">✗ الإجابة غير صحيحة. الصواب:</div>
      ${diff.html}
      <div class="feedback-correct-text">${original}</div>`;
    if (isStrict && !strictCorrect && looseCorrect) {
      showToast('ملاحظة: أوقف "المقارنة الصارمة" لتجاهل التشكيل وعلامات الوقف');
    }
  }

  recalcScore();
}

function clearFeedback(idx) {
  const fb = document.getElementById('feedback-' + idx);
  if (fb)  { fb.className = 'feedback-wrap'; fb.innerHTML = ''; }
  const inp = document.getElementById('ayah-input-' + idx);
  if (inp) { inp.className = 'ayah-input'; inp.value = ''; }
}

function handleInputKey(e, idx) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    checkAyah(idx);
    
    // Move to next ayah input if it exists
    const nextInp = document.getElementById(`ayah-input-${idx + 1}`);
    if (nextInp) {
      setTimeout(() => {
        nextInp.focus();
        nextInp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300); // Small delay to allow user to see feedback briefly
    }
  }
}

// ──────────────────────────────────────────────
// SCORE
// ──────────────────────────────────────────────
function recalcScore(shouldSave = true) {
  if (writeMode === 'surah') return;
  let correct = 0;
  currentAyahs.forEach((_, i) => {
    const inp = document.getElementById('ayah-input-' + i);
    if (inp && inp.classList.contains('correct')) correct++;
  });
  score.correct = correct;
  updateScoreUI();

  if (shouldSave) {
    const pct = Math.round((correct / score.total) * 100);
    saveProgress(currentSurah.number, currentSurah.name, pct);
  }

  if (correct === score.total) {
    showToast('🌟 ممتاز! أتقنت السورة كاملة');
  }
}

function updateScoreUI() {
  if (writeMode === 'surah') {
    const pct = surahScorePct ?? 0;
    document.getElementById('score-display').textContent = `${pct}%`;
    document.getElementById('score-progress').style.width = pct + '%';
    return;
  }
  const pct = score.total ? Math.round((score.correct / score.total) * 100) : 0;
  document.getElementById('score-display').textContent = `${score.correct}/${score.total}`;
  document.getElementById('score-progress').style.width = pct + '%';
}

function handleSurahKey(e, idx) {
  if (e.key === 'Enter') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      checkSurahFull();
    } else {
      e.preventDefault();
      const nextId = (idx === -1) 
        ? 'surah-ayah-input-0' 
        : `surah-ayah-input-${idx + 1}`;
      const nextEl = document.getElementById(nextId);
      if (nextEl) {
        nextEl.focus();
        nextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        // If no more ayahs, maybe check the whole surah?
        checkSurahFull();
      }
    }
  }
}

function checkSurahFull() {
  const feedback = document.getElementById('surah-write-feedback');
  if (!feedback) return;

  const isStrict  = document.getElementById('strict-mode').checked;

  const isEqual = (correct, user) => isStrict
    ? (String(user || '').trim() === String(correct || '').trim())
    : (normalizeArabic(user) === normalizeArabic(correct));

  let correctAyahs = 0;
  let anyText = false;

  currentAyahs.forEach((a, i) => {
    const inp = document.getElementById('surah-ayah-input-' + i);
    const fb  = document.getElementById('surah-ayah-feedback-' + i);
    if (!inp || !fb) return;

    const userText = inp.value.trim();
    const original = String(a.text || '').trim();
    if (userText) anyText = true;

    const ok = isEqual(original, userText);
    inp.className = 'mushaf-input ' + (ok ? 'correct' : 'wrong');
    fb.className = 'feedback-wrap show ' + (ok ? 'feedback-correct' : 'feedback-wrong');

    if (ok) {
      correctAyahs++;
      fb.innerHTML = '✓ صحيحة';
    } else {
      const diff = buildDiffHtml(userText, original, isStrict);
      fb.innerHTML = `
        <div class="feedback-label">✗ راجع الكلمات المظللة:</div>
        ${diff.html}
        <div class="feedback-correct-text">${original}</div>`;
    }
  });

  if (!anyText) { showToast('يرجى كتابة السورة أولاً'); return; }

  surahScorePct = Math.round((correctAyahs / Math.max(1, currentAyahs.length)) * 100);
  const okAll = correctAyahs === currentAyahs.length;

  feedback.className = 'feedback-wrap show ' + (okAll ? 'feedback-correct' : 'feedback-wrong');
  feedback.innerHTML = okAll
    ? '✓ أحسنت! السورة صحيحة بالكامل'
    : `✗ لديك أخطاء: ${correctAyahs}/${currentAyahs.length} آية صحيحة`;

  updateScoreUI();
  saveProgress(currentSurah.number, currentSurah.name, surahScorePct);
}

// ──────────────────────────────────────────────
// AUDIO
// ──────────────────────────────────────────────
function playAudio(globalNum, idx) {
  stopAudio();
  const btn = document.getElementById('audio-btn-' + idx);
  const url = `https://cdn.islamic.network/quran/audio/128/ar.alafasy/${globalNum}.mp3`;
  currentAudio = new Audio(url);
  btn.classList.add('playing');
  currentAudio.play().catch(() => showToast('تعذّر تشغيل الصوت'));
  currentAudio.onended = () => {
    btn.classList.remove('playing');
    currentAudio = null;
  };
}

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  document.querySelectorAll('.audio-btn').forEach(b => b.classList.remove('playing'));
}

// ──────────────────────────────────────────────
// PROGRESS
// ──────────────────────────────────────────────
function saveProgress(num, name, pct) {
  const data = JSON.parse(localStorage.getItem('progress') || '{}');
  data[num] = { name, pct, date: new Date().toLocaleDateString('ar-SA') };
  localStorage.setItem('progress', JSON.stringify(data));
}

function clearProgress() {
  if (confirm('هل تريد مسح كل سجلات التقدم؟')) {
    localStorage.removeItem('progress');
    renderProgress();
    showToast('تم مسح السجلات');
  }
}

function renderProgress() {
  const data    = JSON.parse(localStorage.getItem('progress') || '{}');
  const entries = Object.entries(data);
  const container = document.getElementById('progress-content');

  if (!entries.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📖</div>
        <div class="empty-text">لم تبدأ بعد في الحفظ.<br>اختر سورة وابدأ!</div>
      </div>`;
    return;
  }

  const total = entries.length;
  const avg   = Math.round(entries.reduce((a, [, v]) => a + v.pct, 0) / total);

  container.innerHTML = `
    <div class="progress-hero">
      <div class="progress-big">${avg}%</div>
      <div class="progress-sub">متوسط نتائجك من ${total} سورة</div>
    </div>
    ${entries
      .sort((a, b) => b[1].pct - a[1].pct)
      .map(([num, v]) => `
        <div class="progress-item">
          <div class="surah-num">${num}</div>
          <div class="pi-name">
            <div class="pi-arabic">${v.name}</div>
            <div class="pi-date">${v.date}</div>
          </div>
          <div class="pi-score">
            <div class="pi-pct ${v.pct >= 80 ? 'good' : v.pct >= 50 ? 'mid' : 'bad'}">${v.pct}%</div>
          </div>
        </div>`)
      .join('')}`;
}

// ──────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
initStrictModeControl();
initWriteModeControl();
loadSurahList();
