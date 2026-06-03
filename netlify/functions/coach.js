const SHEET_ID = '1kl84ossr5SQmDANbjnAWLb0T8q-9CEVmMJY1QJ-Xov8';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CAP_PER_WEEK = 20;
const MIN_MESSAGE_CHARS = 30; // quality gate — enforced client-side but double-checked here

// ── Module-level caches — persist across warm invocations ──
let cachedSheetData = null;
let cachedSystemPrompt = null;
let cacheTimestamp = 0;

// ── Weekly usage counter — keyed by email, resets on Monday ──
// Note: resets on cold start (function spin-down). Acceptable for this use case.
const weeklyUsage = {};

// ── Fetch a single tab from the sheet ──
async function fetchTab(tabName, apiKey, range = 'A:B') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName)}!${range}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch tab: ${tabName}`);
  const data = await res.json();
  return data.values || [];
}

// ── Get Monday of the current week (midnight UTC) ──
function getCurrentWeekMonday() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

// ── Check weekly cap and increment counter ──
// Returns { allowed: true/false, remaining: n }
function checkAndIncrementCap(email) {
  const weekKey = getCurrentWeekMonday();
  const key = email.toLowerCase().trim();

  if (!weeklyUsage[key] || weeklyUsage[key].week !== weekKey) {
    weeklyUsage[key] = { week: weekKey, count: 0 };
  }

  if (weeklyUsage[key].count >= CAP_PER_WEEK) {
    return { allowed: false, remaining: 0 };
  }

  weeklyUsage[key].count++;
  return { allowed: true, remaining: CAP_PER_WEEK - weeklyUsage[key].count };
}

// ── Fetch and cache the four content tabs ──
async function getSheetData(apiKey) {
  const now = Date.now();
  if (cachedSheetData && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log('Cache hit — skipping sheet fetch');
    return cachedSheetData;
  }

  console.log('Cache miss — fetching sheet');
  const [rules, faq, pffu, other] = await Promise.all([
    fetchTab('PP Rules', apiKey),
    fetchTab('FAQ', apiKey),
    fetchTab('PFFU', apiKey),
    fetchTab('Other', apiKey),
  ]);

  cachedSheetData = { rules, faq, pffu, other };
  cachedSystemPrompt = null; // invalidate formatted prompt when data refreshes
  cacheTimestamp = now;
  return cachedSheetData;
}

// ── Format helpers ──
const fmt2col = (rows) =>
  rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => `${r[0]}: ${r[1]}`)
    .join('\n\n');

const fmtRules = (rows) =>
  rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => `SECTION: ${r[0]}\n${r[1]}`)
    .join('\n\n');

// ── Build and cache the formatted system prompt ──
async function getSystemPrompt(apiKey) {
  // Return cached prompt string if still valid
  if (cachedSystemPrompt && cachedSheetData && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedSystemPrompt;
  }

  const { rules, faq, pffu, other } = await getSheetData(apiKey);

  const rulesText = fmtRules(rules);
  const faqText   = fmt2col(faq);
  const pffuText  = fmt2col(pffu);
  const otherText = fmt2col(other);

  cachedSystemPrompt = `You are Coach, the official PP Training Assistant for PFF Enterprise's Player Participation training program, 2026. You are knowledgeable, direct, honest, and have a dry sense of humor. You take the work seriously but not yourself.

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
If a question falls outside your knowledge base, say so honestly. Direct the trainee to submit it via the unanswered question form in the Other section below. Tell them: the team will review it, email them an answer, and add it to the knowledge base so future trainees benefit too. Never make up rules. Never guess. If something is genuinely ambiguous, say so and direct them to a trainer or the form.

PP RULES AND CONCEPTS:
${rulesText}

FREQUENTLY ASKED QUESTIONS:
${faqText}

PFFU — E-LEARNING QUESTIONS:
${pffuText}

ADDITIONAL GUIDANCE — red flags, care, personality, contacts, and escalation:
${otherText}

FORMATTING:
Keep responses focused and readable. Short paragraphs. Only use lists when they genuinely help. American English throughout. Under 150 words unless the question genuinely requires more.`;

  return cachedSystemPrompt;
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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'not_found' })
      };
    }

    // ── CHAT ──
    if (action === 'chat') {
      const { messages, email } = body;
      const traineeEmail = (email || '').toLowerCase().trim();

      // Quality gate — server-side double-check
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.content && lastMessage.content.trim().length < MIN_MESSAGE_CHARS) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            reply: "Could you give me a bit more context? A complete question helps me give you a useful answer."
          })
        };
      }

      // Weekly cap check
      if (traineeEmail) {
        const capResult = checkAndIncrementCap(traineeEmail);
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

      // Build (or retrieve cached) system prompt
      const system = await getSystemPrompt(apiKey);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system,
          messages
        })
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: data.content[0].text })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown action' })
    };

  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
