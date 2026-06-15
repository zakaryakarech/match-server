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

// ========== جلب الصفحة عبر ScrapingBee ==========
async function fetchPage() {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGBEE_API_KEY غير موجود في المتغيرات البيئية');
  }

  const url = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent('https://jdwel.com/today/')}&render_js=false&premium_proxy=true&country_code=eg`;
  
  try {
    console.log('🔍 جلب البيانات عبر ScrapingBee...');
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`ScrapingBee HTTP ${response.status}`);
    }
    
    const html = await response.text();
    
    // التحقق من أن المحتوى فعلاً HTML وليس صفحة خطأ
    if (html.includes('jdwel.com') || html.includes('single_match')) {
      console.log('✅ تم جلب البيانات بنجاح');
      return html;
    } else {
      throw new Error('المحتوى المستلم ليس HTML صالح');
    }
  } catch (error) {
    console.error('❌ فشل ScrapingBee:', error.message);
    throw error;
  }
}

// ========== الفحص الدوري ==========
async function checkMatches() {
  try {
    const html = await fetchPage();
    const matches = parseMatches(html);
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    // فحص المباريات الجديدة والمحدثة
    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);

      // مباراة جديدة مباشرة
      if (!prev) {
        await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
        previousMatches.set(id, { isLive: true, score: match.score });
        continue;
      }

      // بداية المباراة (كانت غير مباشرة)
      if (!prev.isLive && match.isLive) {
        await sendNotification(`⚽ بداية مباراة`, `${match.team1} 🆚 ${match.team2} (${match.league})`);
      }
      
      // تسجيل هدف
      if (prev.isLive && match.isLive && prev.score !== match.score) {
        await sendNotification(`🥅 هدف!`, `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`);
      }
      
      // تحديث الحالة
      previousMatches.set(id, { isLive: match.isLive, score: match.score });
    }

    // إزالة المباريات المنتهية
    for (const [id, prev] of previousMatches) {
      if (!currentMap.has(id)) {
        console.log(`🏁 مباراة ${id} انتهت.`);
        previousMatches.delete(id);
      }
    }

    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString('ar-EG')}`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
  }
}

// ========== تشغيل الفحص الدوري ==========
setInterval(checkMatches, 30_000); // كل 30 ثانية
checkMatches(); // أول فحص فوري

// ========== خادم Express ==========
app.get('/', (req, res) => {
  res.send('🟢 خادم مراقبة المباريات يعمل مع ScrapingBee');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
