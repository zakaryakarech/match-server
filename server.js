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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// قائمة وكلاء احتياطيين (جرب كل واحد)
const PROXIES = [
  null, // طلب مباشر أولاً
  'https://cors-anywhere.herokuapp.com/',
  'https://proxy.cors.sh/',
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?'  // نفس القديم لكن قد ينجح أحياناً
];

async function fetchWithProxy(url, proxyUrl) {
  const fullUrl = proxyUrl ? `${proxyUrl}${encodeURIComponent(url)}` : url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.9',
        'Referer': 'https://www.google.com/',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      const html = await response.text();
      return html;
    }
    console.log(`❌ ${proxyUrl || 'direct'} => HTTP ${response.status}`);
    return null;
  } catch (err) {
    clearTimeout(timeout);
    console.log(`❌ ${proxyUrl || 'direct'} => ${err.message}`);
    return null;
  }
}

async function fetchPage() {
  for (const proxy of PROXIES) {
    const html = await fetchWithProxy('https://jdwel.com/today/', proxy);
    if (html) return html;
    await delay(1000);
  }
  throw new Error('All proxies failed');
}

// تحليل HTML (بدون تغيير)
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

let previousMatches = new Map();

async function sendNotification(title, body, retry = 2) {
  const message = { notification: { title, body }, topic: TOPIC };
  for (let i = 0; i < retry; i++) {
    try {
      await admin.messaging().send(message);
      console.log(`✅ إشعار: ${title}`);
      return;
    } catch (error) {
      console.error(`❌ محاولة ${i+1} فشلت:`, error.message);
      if (i < retry-1) await delay(2000);
    }
  }
}

let consecutiveFailures = 0;

async function checkMatches() {
  try {
    console.log('🔍 جلب البيانات...');
    const html = await fetchPage();
    consecutiveFailures = 0;
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
    for (const [id, prev] of previousMatches) {
      if (!currentMap.has(id) && prev.isLive) {
        console.log(`🏁 مباراة ${id} انتهت.`);
        previousMatches.delete(id);
      }
    }
    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    consecutiveFailures++;
    console.error(`❌ خطأ (${consecutiveFailures}):`, error.message);
  }
}

// الفاصل الزمني: 15 ثانية عادة، لكن يزيد تدريجياً عند الفشل
async function scheduler() {
  let interval = 15000;
  while (true) {
    await checkMatches();
    if (consecutiveFailures > 3) {
      interval = 60000; // بعد 3 فشل متتالي، انتظر دقيقة
    } else {
      interval = 15000 + Math.random() * 5000;
    }
    await delay(interval);
  }
}

scheduler();

app.get('/', (req, res) => res.send('🟢 خادم مراقبة المباريات يعمل (محسن)'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 الخادم على المنفذ ${PORT}`));
