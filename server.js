const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const admin = require('firebase-admin');

const app = express();

// Firebase Admin
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const TOPIC = 'matches';

// تحليل HTML
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
        league, team1, team2, score, isLive, minute, matchId, dataStatus,
      });
    });
  });
  return matches;
}

// تخزين الحالة السابقة
let previousMatches = new Map();

// إرسال إشعار مع إعادة محاولة
async function sendNotification(title, body, retry = 2) {
  const message = { notification: { title, body }, topic: TOPIC };
  for (let i = 0; i < retry; i++) {
    try {
      await admin.messaging().send(message);
      console.log(`✅ إشعار: ${title}`);
      return;
    } catch (error) {
      console.error(`❌ محاولة ${i+1} فشلت:`, error.message);
      if (i < retry-1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// جلب الصفحة عبر proxy مع fallback
async function fetchPage() {
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent('https://jdwel.com/today/')}`,
    `https://corsproxy.io/?${encodeURIComponent('https://jdwel.com/today/')}`,
  ];
  for (let url of proxyUrls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)' },
        timeout: 10000,
      });
      if (response.ok) return await response.text();
      console.log(`وكيل ${url} أعاد HTTP ${response.status}`);
    } catch (err) {
      console.log(`فشل الوكيل ${url}: ${err.message}`);
    }
  }
  throw new Error('All proxies failed');
}

// الفحص الدوري
async function checkMatches() {
  try {
    console.log('🔍 جلب البيانات...');
    const html = await fetchPage();
    const matches = parseMatches(html);
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);
      if (!prev && match.isLive) {
        await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
        previousMatches.set(id, { isLive: true, score: match.score, minute: match.minute });
        continue;
      }
      if (prev) {
        if (!prev.isLive && match.isLive) {
          await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
        }
        if (prev.isLive && match.isLive && prev.score !== match.score) {
          await sendNotification(`🥅 هدف!`, `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`);
        }
        previousMatches.set(id, { isLive: match.isLive, score: match.score, minute: match.minute });
      }
    }
    // إزالة المنتهية
    for (const [id, prev] of previousMatches) {
      if (!currentMap.has(id) && prev.isLive) {
        console.log(`🏁 مباراة ${id} انتهت.`);
        previousMatches.delete(id);
      }
    }
    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ خطأ:', error.message);
  }
}

// فاصل زمني ديناميكي (10-12 ثانية)
setInterval(() => {
  checkMatches().catch(console.error);
}, 10000 + Math.random() * 2000);

checkMatches();

app.get('/', (req, res) => res.send('🟢 خادم مراقبة المباريات يعمل'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 الخادم على المنفذ ${PORT}`));
