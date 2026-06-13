const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const admin = require('firebase-admin');

const app = express();

// ========== إعداد Firebase Admin ==========
// ضع ملف serviceAccountKey.json في نفس المجلد
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// الموضوع الذي سنرسل إليه الإشعارات (FCM Topic)
const TOPIC = 'matches';

// ========== تحليل HTML الخاص بالموقع ==========
function parseMatches(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const competitions = document.querySelectorAll('.comp_matches_list');
  const matches = [];

  competitions.forEach(comp => {
    // اسم الدوري
    const leagueEl = comp.querySelector('.comp_separator .main .title') ||
                     comp.querySelector('.comp_separator .main h4.title');
    const league = leagueEl ? leagueEl.textContent.trim() : 'Unknown League';

    // جميع المباريات داخل الدوري
    const matchElements = comp.querySelectorAll('.single_match');
    matchElements.forEach(matchEl => {
      const dataStatus = matchEl.getAttribute('data-view_status');
      const isLive = dataStatus === 'live';

      // أسماء الفرق
      const team1 = matchEl.querySelector('.team.hometeam .the_team')?.textContent.trim() || '';
      const team2 = matchEl.querySelector('.team.awayteam .the_team')?.textContent.trim() || '';

      // النتيجة
      const scoreHome = matchEl.querySelector('.match_score .hometeam')?.textContent.trim() || '0';
      const scoreAway = matchEl.querySelector('.match_score .awayteam')?.textContent.trim() || '0';
      const score = `${scoreHome} - ${scoreAway}`;

      // الدقيقة (إن وجدت)
      let minute = null;
      const minuteEl = matchEl.querySelector('.match_status .status_box span');
      if (minuteEl) {
        const txt = minuteEl.textContent.replace(/[^0-9]/g, '');
        if (txt) minute = parseInt(txt);
      }

      // رابط المباراة لاستخراج ID
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

// ========== الحالة السابقة للمباريات (للمقارنة) ==========
let previousMatches = new Map(); // key: matchId, value: { isLive, score }

// ========== إرسال إشعار FCM إلى الموضوع ==========
async function sendNotification(title, body) {
  const message = {
    notification: {
      title,
      body,
    },
    topic: TOPIC,
  };

  try {
    await admin.messaging().send(message);
    console.log('✅ إشعار:', title);
  } catch (error) {
    console.error('❌ فشل إرسال الإشعار:', error.message);
  }
}

// ========== دالة الفحص الدورية ==========
async function checkMatches() {
  try {
    console.log('🔍 جلب بيانات الموقع...');
    const response = await fetch('https://jdwel.com/today/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const matches = parseMatches(html);

    // المباريات المباشرة فقط
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    // مقارنة بالحالة السابقة
    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);

      if (!prev) {
        // مباراة جديدة لم نكن نتابعها
        previousMatches.set(id, { isLive: match.isLive, score: match.score });
        continue;
      }

      // بداية المباراة (لم تكن مباشرة سابقاً)
      if (!prev.isLive && match.isLive) {
        await sendNotification(
          `⚽ بداية مباراة`,
          `${match.team1} 🆚 ${match.team2} (${match.league})`
        );
      }

      // تغير النتيجة (هدف)
      if (prev.isLive && match.isLive && prev.score !== match.score) {
        await sendNotification(
          `🥅 هدف!`,
          `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`
        );
      }

      // تحديث الحالة السابقة
      previousMatches.set(id, { isLive: match.isLive, score: match.score });
    }

    console.log(`✅ تم فحص ${liveMatches.length} مباراة مباشرة - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
  }
}

// ========== تشغيل الفحص كل 30 ثانية ==========
setInterval(checkMatches, 30_000);
checkMatches(); // تشغيل أولي

// ========== مسار صحي لـ Render ==========
app.get('/', (req, res) => {
  res.send('🟢 خادم مراقبة المباريات يعمل');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
