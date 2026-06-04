const SHEET_ID = '1kl84ossr5SQmDANbjnAWLb0T8q-9CEVmMJY1QJ-Xov8';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CAP_PER_WEEK = 16;
const MIN_MESSAGE_CHARS = 30;

// ── Per-week cache — each entry: { data, prompt, timestamp }
// Keyed by weekNum (0–4) so each week's content is cached independently.
const weekCache = {};

// ── Weekly usage counter — keyed by email, resets on Monday ──
const weeklyUsage = {};

// ── Fetch a single tab from the sheet ──
async function fetchTab(tabName, apiKey, range = 'A:B') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName)}!${range}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch tab: ${tabName}`);
  const data = await res.json();
  return data.values || [];
}

// ── Which tabs to load per week ──
// Week 0 = PFFU week. Weeks 1–3 = Games 1–3. Week 4 = final test (no game hints).
function getTabsForWeek(weekNum) {
  const base = ['PP Rules', 'FAQ', 'Program Info', 'Discord', 'Other'];
  if (weekNum === 0) return [...base, 'PFFU'];
  if (weekNum === 1) return [...base, 'Game 1'];
  if (weekNum === 2) return [...base, 'Game 2'];
  if (weekNum === 3) return [...base, 'Game 3'];
  return base; // Week 4: final test — no game-specific content
}

// ── Get Monday of the current week (midnight UTC) ──
function getCurrentWeekMonday() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// ── Weekly cap ──
function checkAndIncrementCap(email) {
  const weekKey = getCurrentWeekMonday();
  const key = email.toLowerCase().trim();

  if (!weeklyUsage[key] || weeklyUsage[key].week !== weekKey) {
    weeklyUsage[key] = { week: weekKey, count: 0, nudged: false };
  }

  if (weeklyUsage[key].count >= CAP_PER_WEEK) {
    return { allowed: false, remaining: 0, count: weeklyUsage[key].count, showHalfwayNudge: false };
  }

  weeklyUsage[key].count++;
  const count = weeklyUsage[key].count;

  let showHalfwayNudge = false;
  if (!weeklyUsage[key].nudged && count >= Math.ceil(CAP_PER_WEEK / 2)) {
    weeklyUsage[key].nudged = true;
    showHalfwayNudge = true;
  }

  return { allowed: true, remaining: CAP_PER_WEEK - count, count, showHalfwayNudge };
}

const HALFWAY_NUDGE = "\n\n---\n\n_You've used around half of your Coach questions for this week. Worth thinking about what you really need to ask — a lot of answers are already in the Hub, the PP Guide, or Discord, and for anything you're genuinely stuck on, a trainer will often help more than I can._";

// ── Format helpers ──
// 2-column tabs (Section/Content or Question/Answer)
const fmt2col = (rows) =>
  rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => `${r[0]}: ${r[1]}`)
    .join('\n\n');

// PP Rules tab — labelled sections
const fmtRules = (rows) =>
  rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => `SECTION: ${r[0]}\n${r[1]}`)
    .join('\n\n');

// 3-column game Q&A tabs (Play / Question / Answer)
const fmtGame = (rows) =>
  rows.slice(1)
    .filter(r => r[1] && r[2])
    .map(r => `Q: ${r[1]}\nA: ${r[2]}`)
    .join('\n\n');

// ── Fetch and cache sheet data for a given week ──
async function getSheetData(weekNum, apiKey) {
  const now = Date.now();
  const cached = weekCache[weekNum];
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`Cache hit — week ${weekNum}`);
    return cached.data;
  }

  console.log(`Cache miss — fetching week ${weekNum}`);
  const tabs = getTabsForWeek(weekNum);

  // Fetch all tabs in parallel; game tabs use A:C (3 columns), others use A:B
  const gameTabs = new Set(['Game 1', 'Game 2', 'Game 3']);
  const fetches = tabs.map(tab =>
    fetchTab(tab, apiKey, gameTabs.has(tab) ? 'A:C' : 'A:B').then(data => ({ tab, data }))
  );
  const results = await Promise.all(fetches);

  const tabMap = {};
  for (const { tab, data } of results) tabMap[tab] = data;

  if (!weekCache[weekNum]) weekCache[weekNum] = {};
  weekCache[weekNum].data = tabMap;
  weekCache[weekNum].prompt = null; // invalidate cached prompt
  weekCache[weekNum].timestamp = now;

  return tabMap;
}

// ── Build current-week section of the prompt ──
function buildWeekSection(weekNum, tabMap) {
  if (weekNum === 0) {
    return `PFFU — WEEK 1 CONTENT (the trainee is currently completing the PFFU e-learning course):\n${fmt2col(tabMap['PFFU'] || [])}`;
  }
  if (weekNum >= 1 && weekNum <= 3) {
    const gameTab = `Game ${weekNum}`;
    return `GAME ${weekNum} — PLAY-SPECIFIC Q&A (the trainee is currently working on Game ${weekNum}):\n${fmtGame(tabMap[gameTab] || [])}`;
  }
  if (weekNum === 4) {
    return `NOTE: The trainee is on Game 4 — the final test game. Do not provide hints, answers, or guidance about specific plays in their game. Help them with general PP rules and concepts only. Refer them to their trainers or the PP Guide for anything beyond general rules.`;
  }
  return '';
}

// ── Build and cache the system prompt for a given week ──
async function getSystemPrompt(weekNum, apiKey) {
  const cached = weekCache[weekNum];
  if (cached && cached.prompt && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.prompt;
  }

  const tabMap = await getSheetData(weekNum, apiKey);

  const rulesText   = fmtRules(tabMap['PP Rules'] || []);
  const faqText     = fmt2col(tabMap['FAQ'] || []);
  const progText    = fmt2col(tabMap['Program Info'] || []);
  const discordText = fmt2col(tabMap['Discord'] || []);
  const otherText   = fmt2col(tabMap['Other'] || []);
  const weekSection = buildWeekSection(weekNum, tabMap);

  const prompt = `You are Coach, the official PP Training Assistant for PFF Enterprise's Player Participation training program, 2026. You are knowledgeable, direct, honest, and have a dry sense of humor. You take the work seriously but not yourself.

YOUR JOB:
Answer questions about PP rules and concepts, help trainees understand their feedback data, explain how the program works, and point them to the right resources. You are available any time a trainee needs help.

TONE AND STYLE:
- Direct, honest, and respectful. Treat trainees as equals.
- No corporate waffle. No excessive praise or sycophancy.
- American English spelling (program not programme, analyze not analyse).
- Be concise — trainees are often on their phones. Keep answers under 150 words unless the question genuinely requires more.
- Dry wit is appropriate. Do not be harsh.
- When trainees are anxious about their error counts, reassure them with facts not platitudes.

ERROR HIERARCHY — apply this whenever discussing performance or feedback:
1. Player Errors — always the top priority. Wrong player identified is the most fundamental failure.
2. Role Errors on clear-cut plays — missed blitzes, missed pass protection. These indicate concept gaps, laziness, or overwhelm.
3. Position Errors (high severity) — errors crossing positional group boundaries: SSR vs SCBR, NLT vs FS, TE vs WR. These reveal conceptual misunderstandings.
4. Position Errors (low severity) — adjacent positions: NLT vs DLT, TE-iR vs TE-R. Marginal broadcast angle calls. ACTIVELY tell trainees not to worry about these. Advanced PP cleans them up with all-22 footage.

IMPORTANT: You cannot be perfect at PP from broadcast footage. Nobody is. If a trainee is fixating on their total position error count when their Player Errors and Role Errors are under control, reframe this clearly and honestly.

WHEN YOU CANNOT ANSWER:
If a question falls outside your knowledge base, say so honestly. Direct the trainee to submit it via the unanswered question form. Tell them: the team will review it, email them an answer, and add it to the knowledge base so future trainees benefit too. Never make up rules. Never guess. If something is genuinely ambiguous, say so and direct them to a trainer or the form.

PP RULES AND CONCEPTS:
${rulesText}

FREQUENTLY ASKED QUESTIONS:
${faqText}

${weekSection}

PROGRAM INFO AND LOGISTICS:
${progText}

DISCORD AND NAVIGATION:
${discordText}

ADDITIONAL GUIDANCE — red flags, care, personality, contacts, and escalation:
${otherText}

FORMATTING:
Keep responses focused and readable. Short paragraphs. Only use lists when they genuinely help. American English throughout. Under 150 words unless the question genuinely requires more.`;

  if (!weekCache[weekNum]) weekCache[weekNum] = {};
  weekCache[weekNum].prompt = prompt;

  return prompt;
}

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const action = body.action;
    const apiKey = process.env.SHEETS_API_KEY;

    // ── EMAIL LOOKUP ──
    if (action === 'lookup') {
      const email = (body.email || '').toLowerCase().trim();
      const rows = await fetchTab('Login', apiKey, 'A:E');

      for (let i = 1; i < rows.length; i++) {
        const rowEmail = (rows[i][0] || '').toLowerCase().trim();
        if (rowEmail === email) {
          const active = (rows[i][3] || '').toString().trim().toLowerCase() === 'active';
          if (!active) {
            return { statusCode: 200, headers, body: JSON.stringify({ status: 'inactive' }) };
          }
          const weekMatch = String(rows[i][4] == null ? '' : rows[i][4]).match(/(\d+)/);
          const weekNum = weekMatch ? parseInt(weekMatch[1], 10) : 0;
          const weekAccess = (weekNum >= 0 && weekNum <= 4) ? weekNum : 0;
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              status: 'found',
              firstName: rows[i][1] || '',
              lastName: rows[i][2] || '',
              weekAccess
            })
          };
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_found' }) };
    }

    // ── CHAT ──
    if (action === 'chat') {
      const { messages, email, weekAccess } = body;
      const traineeEmail = (email || '').toLowerCase().trim();

      // Resolve weekNum — default to 0 if not provided or out of range
      const weekNum = (typeof weekAccess === 'number' && weekAccess >= 0 && weekAccess <= 4)
        ? weekAccess
        : 0;

      // Quality gate
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.content && lastMessage.content.trim().length < MIN_MESSAGE_CHARS) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ reply: "Could you give me a bit more context? A complete question helps me give you a useful answer." })
        };
      }

      // Weekly cap check
      let capResult = { allowed: true, showHalfwayNudge: false };
      if (traineeEmail) {
        capResult = checkAndIncrementCap(traineeEmail);
        if (!capResult.allowed) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              reply: `You've reached your ${CAP_PER_WEEK} question limit for this week. Your allowance resets on Monday. In the meantime, post your question in the #pp-training channel on Discord — the trainers are there to help.`,
              capExceeded: true
            })
          };
        }
      }

      // Build (or retrieve cached) system prompt for this trainee's week
      const system = await getSystemPrompt(weekNum, apiKey);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31;extended-cache-ttl-2025-02-19'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: 3600 } }],
          messages
        })
      });

      const data = await response.json();

      if (!response.ok) {
        return { statusCode: response.status, headers, body: JSON.stringify({ error: data }) };
      }

      let replyText = data.content[0].text;
      if (capResult.showHalfwayNudge) {
        replyText += HALFWAY_NUDGE;
      }

      return { statusCode: 200, headers, body: JSON.stringify({ reply: replyText }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
