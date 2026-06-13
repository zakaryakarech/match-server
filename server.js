const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const admin = require('firebase-admin');

const app = express();

// ========== Firebase Admin ==========
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const TOPIC = 'matches';

// ========== تحليل HTML ==========
function parseMatches(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const competitions = document.querySelectorAll('.comp_matches_list');
  const matches = [];

  if (competitions.length === 0) {
    console.warn('⚠️ لم يتم العثور على أي مسابقة (قد يكون تنسيق الصفحة تغير).');
  }

  competitions.forEach(comp => {
    const leagueEl = comp.querySelector('.comp_separator .main .title') ||
                     comp.querySelector('.comp_separator .main h4.title');
    const league = leagueEl ? leagueEl.textContent.trim() : 'Unknown League';

    const matchElements = comp.querySelectorAll('.single_match');
    matchElements.forEach(matchEl => {
      const dataStatus = matchEl.getAttribute('data-view_status');
      const isLive = dataStatus === 'live';

      const team1 = matchEl.querySelector('.team.hometeam .the_team')?.textContent.trim() || '';
      const team2 = matchEl.querySelector('.team.awayteam .the_team')?.textContent.trim() || '';

      const scoreHome = matchEl.querySelector('.match_score .hometeam')?.textContent.trim() || '0';
      const scoreAway = matchEl.querySelector('.match_score .awayteam')?.textContent.trim() || '0';
      const score = `${scoreHome} - ${scoreAway}`;

      let minute = null;
      const minuteEl = matchEl.querySelector('.match_status .status_box span');
      if (minuteEl) {
        const txt = minuteEl.textContent.replace(/[^0-9]/g, '');
        if (txt) minute = parseInt(txt);
      }

      const linkEl = matchEl.querySelector('a[href]');
      let matchId = null;
      if (linkEl) {
        const href = linkEl.getAttribute('href');
        const m = href.match(/id=(\d+)/);
        if (m) matchId = parseInt(m[1]);
      }

      matches.push({
        league,
        team1,
        team2,
        score,
        isLive,
        minute,
        matchId,
        dataStatus,
      });
    });
  });
  return matches;
}

// ========== الحالة السابقة مع حماية من الفقد المؤقت ==========
let previousMatches = new Map();            // key: matchId => { isLive, score }
let missingCounter = new Map();             // key: matchId => عدد المرات التي اختفت فيها المباراة
const MISSING_THRESHOLD = 3;                // لا نحذف حتى تختفي 3 مرات متتالية (لتجنب الحذف بسبب فشل الجلب)

// ========== آلية قفل لمنع التداخل ==========
let isChecking = false;

// ========== إرسال إشعار مع إعادة محاولة ==========
async function sendNotification(title, body, retry = 2) {
  const message = {
    notification: { title, body },
    topic: TOPIC,
  };
  for (let i = 0; i < retry; i++) {
    try {
      await admin.messaging().send(message);
      console.log('✅ إشعار:', title);
      return;
    } catch (error) {
      console.error(`❌ محاولة ${i+1} فشلت:`, error.message);
      if (i < retry-1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ========== جلب الصفحة عبر وسيط مع مهلة ==========
async function fetchPage() {
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent('https://jdwel.com/today/')}`,
    `https://corsproxy.io/?${encodeURIComponent('https://jdwel.com/today/')}`,
  ];

  for (let url of proxyUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.ok) return response.text();
      console.log(`وكيل ${url} أعاد HTTP ${response.status}`);
    } catch (err) {
      console.log(`فشل الوكيل ${url}: ${err.message}`);
    }
  }
  throw new Error('All proxies failed');
}

// ========== الفحص الرئيسي (كل 15 ثانية) ==========
let firstRun = true; // لتجاهل إشعارات التشغيل الأول

async function checkMatches() {
  if (isChecking) {
    console.log('⏳ الفحص السابق لم ينته بعد، تجاوز هذه الدورة.');
    return;
  }
  isChecking = true;
  try {
    console.log('🔍 جلب بيانات الموقع...');
    const html = await fetchPage();
    const matches = parseMatches(html);
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    // معالجة المباريات الموجودة حاليًا
    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);

      // إعادة تعيين عداد الاختفاء لأن المباراة موجودة
      missingCounter.delete(id);

      // حالة مباراة جديدة (أو عادت بعد اختفاء مؤقت)
      if (!prev) {
        if (!firstRun) {
          // فقط أرسل إشعار إذا لم تكن أول تشغيل
          await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
        }
        previousMatches.set(id, { isLive: true, score: match.score });
        continue;
      }

      if (prev) {
        // بداية المباراة: كانت غير مباشرة ثم أصبحت مباشرة
        if (!prev.isLive && match.isLive) {
          await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
        }
        // هدف: تغير النتيجة
        if (prev.isLive && match.isLive && prev.score !== match.score) {
          await sendNotification(`🥅 هدف!`, `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`);
        }
        // تحديث الحالة المخزنة
        previousMatches.set(id, { isLive: match.isLive, score: match.score });
      }
    }

    // معالجة المباريات التي لم تعد موجودة في الجلب الحالي
    for (const [id, prev] of previousMatches) {
      if (!currentMap.has(id)) {
        const missCount = (missingCounter.get(id) || 0) + 1;
        missingCounter.set(id, missCount);
        if (missCount >= MISSING_THRESHOLD) {
          console.log(`🏁 مباراة ${id} انتهت (اختفت لـ ${missCount} دورة).`);
          previousMatches.delete(id);
          missingCounter.delete(id);
        } else {
          console.log(`❓ مباراة ${id} مختفية (${missCount}/${MISSING_THRESHOLD})، لم نحذف بعد.`);
        }
      }
    }

    // بعد أول تشغيل ناجح، نسمح بالإشعارات
    if (firstRun) {
      firstRun = false;
      console.log('🔕 أول تشغيل اكتمل، تم تجاهل الإشعارات.');
    }

    console.log(`✅ فحص: ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
    // لا نحذف المباريات بسبب خطأ مؤقت (لأننا لا ننشئ currentMap جديداً هنا)
  } finally {
    isChecking = false;
  }
}

// ========== تشغيل الفحص الدوري (كل 15 ثانية) ==========
const CHECK_INTERVAL_MS = 15000; // 15 ثانية – أكثر استقراراً للموقع والوكلاء
setInterval(checkMatches, CHECK_INTERVAL_MS);

// تشغيل أولي فوري
checkMatches();

// ========== خادم Express ==========
app.get('/', (req, res) => {
  res.send('🟢 خادم مراقبة المباريات (فحص كل 15 ثانية)');
});

// نقطة فحص يدوية
app.get('/check', async (req, res) => {
  try {
    const html = await fetchPage();
    const matches = parseMatches(html);
    res.json({ count: matches.length, matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// حالة الخادم
app.get('/status', (req, res) => {
  res.json({
    running: true,
    checking: isChecking,
    liveMatchesStored: previousMatches.size,
    nextCheckIn: CHECK_INTERVAL_MS,
    firstRunCompleted: !firstRun,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
