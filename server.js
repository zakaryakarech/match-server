const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const admin = require('firebase-admin');

const app = express();

// ========== إعداد Firebase Admin ==========
// نقرأ المفتاح من متغير البيئة SERVICE_ACCOUNT_JSON
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

// ========== الحالة السابقة ==========
let previousMatches = new Map();

// ========== إرسال إشعار FCM ==========
async function sendNotification(title, body) {
  const message = {
    notification: { title, body },
    topic: TOPIC,
  };
  try {
    await admin.messaging().send(message);
    console.log('✅ إشعار:', title);
  } catch (error) {
    console.error('❌ فشل إرسال الإشعار:', error.message);
  }
}

// ========== دالة جلب الصفحة مع ترويسة متصفح حقيقية ==========
async function fetchPage() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  // نجرب 3 مرات
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://jdwel.com/today/', { headers });
      if (response.ok) return response.text();
      console.log(`محاولة ${attempt}: HTTP ${response.status}`);
    } catch (err) {
      console.log(`محاولة ${attempt}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 3000)); // انتظر 3 ثوان قبل إعادة المحاولة
  }
  throw new Error('Failed to fetch after 3 attempts');
}

// ========== الفحص الدوري ==========
async function checkMatches() {
  try {
    console.log('🔍 جلب بيانات الموقع...');
    const html = await fetchPage();
    const matches = parseMatches(html);
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);
      if (!prev) {
        previousMatches.set(id, { isLive: match.isLive, score: match.score });
        continue;
      }
      if (!prev.isLive && match.isLive) {
        await sendNotification(
          `⚽ بداية مباراة`,
          `${match.team1} 🆚 ${match.team2} (${match.league})`
        );
      }
      if (prev.isLive && match.isLive && prev.score !== match.score) {
        await sendNotification(
          `🥅 هدف!`,
          `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`
        );
      }
      previousMatches.set(id, { isLive: match.isLive, score: match.score });
    }
    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
  }
}

// ========== تشغيل الفحص كل 30 ثانية ==========
setInterval(checkMatches, 30_000);
checkMatches();

// ========== مسار صحي ==========
app.get('/', (req, res) => {
  res.send('🟢 خادم مراقبة المباريات يعمل');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
