// =======================================================
// server.js - مراقب مباريات مباشر (يعمل على Render مع تجاوز Cloudflare)
// =======================================================

const express = require('express');
const admin = require('firebase-admin');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();

// ========== Firebase Admin ==========
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const TOPIC = 'matches';

// ========== إعدادات الفحص الذكي ==========
let CHECK_INTERVAL = 45_000;   // يبدأ بـ 45 ثانية
let intervalId = null;
let liveCount = 0;

// ========== مسار Chromium المثبت بواسطة Render ==========
const CHROMIUM_PATH = puppeteer.executablePath();
console.log('📍 مسار Chromium:', CHROMIUM_PATH);

// ========== جلب الصفحة باستخدام متصفح حقيقي (Puppeteer + Stealth) ==========
async function fetchPage() {
  const targetUrl = 'https://jdwel.com/today/';

  console.log('🚀 [Puppeteer] تشغيل المتصفح...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    // تمويه ليبدو كمتصفح طبيعي
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    console.log('🌐 [Puppeteer] التوجه إلى الصفحة...');
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 40_000,
    });

    await page.waitForTimeout(3000);

    // انتظار ظهور قائمة المباريات للتأكد من تحميل المحتوى
    try {
      await page.waitForSelector('.comp_matches_list', { timeout: 10_000 });
      console.log('✅ [Puppeteer] ظهرت قائمة المباريات');
    } catch (e) {
      console.warn('⚠️ [Puppeteer] لم تظهر .comp_matches_list، قد يكون الهيكل تغير.');
    }

    const html = await page.content();
    console.log('✅ [Puppeteer] تم جلب HTML بنجاح');
    return html;
  } catch (error) {
    console.error('❌ [Puppeteer] فشل:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('🧹 [Puppeteer] تم إغلاق المتصفح');
  }
}

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
        const raw = minuteEl.textContent.trim();
        const m = raw.match(/(\d+)(?:\+(\d+))?/);
        if (m) minute = m[0]; // تحتفظ بصيغة "45+2"
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
        homeScore: parseInt(scoreHome) || 0,
        awayScore: parseInt(scoreAway) || 0,
        isLive,
        minute,
        matchId,
        dataStatus,
      });
    });
  });
  return matches;
}

// ========== إرسال إشعار ==========
async function sendNotification(title, body, retry = 2) {
  const message = {
    notification: { title, body },
    topic: TOPIC,
  };
  for (let i = 0; i < retry; i++) {
    try {
      await admin.messaging().send(message);
      console.log(`✅ إشعار: ${title}`);
      return;
    } catch (error) {
      console.error(`❌ محاولة ${i + 1} فشلت:`, error.message);
      if (i < retry - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ========== الحالة السابقة ==========
let previousMatches = new Map();

// ========== دورة الفحص الرئيسية ==========
async function checkMatches() {
  try {
    console.log('\n🔍 بدء دورة فحص جديدة...');
    const html = await fetchPage();
    const matches = parseMatches(html);
    const liveMatches = matches.filter(m => m.isLive && m.matchId);
    liveCount = liveMatches.length;

    const currentMap = new Map();
    liveMatches.forEach(m => currentMap.set(m.matchId, m));

    for (const [id, match] of currentMap) {
      const prev = previousMatches.get(id);

      // حالة 1: مباراة جديدة مباشرة
      if (!prev) {
        if (match.isLive) {
          await sendNotification(
            `⚽ بداية مباراة`,
            `${match.team1} 🆚 ${match.team2} (${match.league})`
          );
        }
        previousMatches.set(id, {
          isLive: match.isLive,
          homeScore: match.homeScore,
          awayScore: match.awayScore,
          startNotified: true,
        });
        continue;
      }

      // حالة 2: تغيرت الحالة إلى مباشرة
      if (!prev.isLive && match.isLive) {
        await sendNotification(
          `⚽ بداية مباراة`,
          `${match.team1} 🆚 ${match.team2} (${match.league})`
        );
        previousMatches.set(id, {
          isLive: true,
          homeScore: match.homeScore,
          awayScore: match.awayScore,
          startNotified: true,
        });
        continue;
      }

      // حالة 3: هدف (تغيرت النتيجة)
      if (
        prev.isLive &&
        match.isLive &&
        (prev.homeScore !== match.homeScore || prev.awayScore !== match.awayScore)
      ) {
        await sendNotification(
          `🥅 هدف!`,
          `${match.team1} ${match.score} ${match.team2} | الدقيقة ${match.minute || '?'}`
        );
        // تحديث الحالة المخزنة
        previousMatches.set(id, {
          isLive: true,
          homeScore: match.homeScore,
          awayScore: match.awayScore,
          startNotified: true,
        });
      }
    }

    // إزالة المباريات التي لم تعد مباشرة (انتهت)
    for (const [id, prev] of previousMatches) {
      if (!currentMap.has(id) && prev.isLive) {
        console.log(`🏁 مباراة ${id} انتهت.`);
        previousMatches.delete(id);
      }
    }

    CHECK_INTERVAL = liveCount > 0 ? 45_000 : 180_000;
    console.log(`📊 مباريات مباشرة: ${liveCount} | الفحص القادم بعد ${CHECK_INTERVAL / 1000} ث`);
  } catch (error) {
    console.error('❌ خطأ في checkMatches:', error.message);
    CHECK_INTERVAL = Math.min(CHECK_INTERVAL * 1.5, 300_000);
  }

  // إعادة جدولة المؤقت
  clearInterval(intervalId);
  intervalId = setInterval(checkMatches, CHECK_INTERVAL);
}

// ========== تشغيل أولي ==========
checkMatches();

// ========== نقطة فحص الصحة ==========
app.get('/', (req, res) => {
  res.json({
    status: '🟢 الخادم يعمل',
    liveMatches: liveCount,
    nextCheckInSeconds: CHECK_INTERVAL / 1000,
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 الخادم يستمع على المنفذ ${PORT}`);
});
