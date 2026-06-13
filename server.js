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

// ========== تحليل HTML (نفس السابق) ==========
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

// ========== إرسال إشعار ==========
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

// ========== جلب الصفحة عبر وكيل ==========
async function fetchPage() {
  // قائمة بالوكلاء الاحتياطيين
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent('https://jdwel.com/today/')}`,
    `https://corsproxy.io/?${encodeURIComponent('https://jdwel.com/today/')}`,
  ];

  for (let url of proxyUrls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)' }
      });
      if (response.ok) return response.text();
      console.log(`وكيل ${url} أعاد HTTP ${response.status}`);
    } catch (err) {
      console.log(`فشل الوكيل ${url}: ${err.message}`);
    }
  }
  throw new Error('All proxies failed');
}

// ========== الفحص الدوري ==========
async function checkMatches() {
  try {
    console.log('🔍 جلب بيانات الموقع عبر وكيل...');
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
        await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
      }
      if (prev.isLive && match.isLive && prev.score !== match.score) {
        await sendNotification(`🥅 هدف!`, `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`);
      }
      previousMatches.set(id, { isLive: match.isLive, score: match.score });
    }
    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
  }
}

setInterval(checkMatches, 30_000);
checkMatches();

app.get('/', (req, res) => {
  res.send('🟢 خادم مراقبة المباريات يعمل');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
