/* =============================================================================
 * ai.js -- Anthropic Claude integration for the SBG Tracker.
 *
 * Currently exposes one capability:
 *   scopeExtractFromPdf(pdfBuffer) -> { project, tasks, milestones, ... }
 *
 * The Claude API supports PDF input natively as a `document` content block --
 * we don't need pdftotext. We send the PDF + a structured-output prompt and
 * parse the JSON the model returns.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY    -- required
 *   ANTHROPIC_MODEL      -- default 'claude-sonnet-4-6'
 *
 * Tests / dev without an API key: if ANTHROPIC_FAKE=1, callers receive a
 * deterministic stub response. Used in node:test runs.
 * =============================================================================
 */
let _anthropic = null;

function getClient() {
  if (_anthropic) return _anthropic;
  if (process.env.ANTHROPIC_FAKE === '1') return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set -- configure it in /etc/sbg-tracker.env or .env');
  }
  // Lazy-require so importing this module doesn't fail when the package isn't installed yet.
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const SCOPE_PROMPT = `You are an expert preconstruction estimator analyzing a project specification or
drawing set on behalf of a general contractor (Source Building Group).

Read the attached PDF carefully. Extract a structured summary that an estimator
would use to set up a bid pursuit. Return ONLY a JSON object matching this schema --
no prose, no markdown fences, just JSON:

{
  "project": {
    "name": "best-guess project name",
    "client": "owner / developer name if visible",
    "location": "city/state if visible",
    "scope_summary": "1-2 sentence summary of the work"
  },
  "milestones": [
    { "name": "Bid Due", "date": "YYYY-MM-DD or null", "notes": "" }
  ],
  "trades": [
    { "csi_division": "03 30 00", "name": "Cast-in-place concrete", "scope_notes": "" }
  ],
  "tasks": [
    {
      "title": "concise action verb + object (e.g., 'Take off concrete quantities')",
      "stage": "one of: project-setup | document-review | trade-solicitation | estimating | scope-leveling | bid-day-prep | bid-day | post-bid",
      "priority": "low | medium | high",
      "notes": "any specific guidance from the spec"
    }
  ],
  "risks": [
    "potential risk or unusual requirement worth flagging"
  ],
  "notes": "anything else important the estimator should know"
}

Guidelines:
- Be specific. If the spec calls out unusual finishes, schedule pressure, or non-standard requirements, surface them as risks.
- Generate 10-30 tasks covering the full bid lifecycle, biased toward what THIS project needs.
- For trades, focus on the major CSI divisions actually present in the spec.
- Use empty strings or null where data isn't available; never invent.`;

async function scopeExtractFromPdf(pdfBuffer, opts = {}) {
  if (process.env.ANTHROPIC_FAKE === '1') {
    return makeFakeResponse(pdfBuffer.length);
  }
  const client = getClient();
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') }
        },
        { type: 'text', text: SCOPE_PROMPT }
      ]
    }]
  });
  // Claude messages content is an array of blocks; the text response comes back as type=text.
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // Strip accidental markdown fences if the model adds them despite our instructions.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { error: 'Could not parse Claude response as JSON', raw: text };
  }
  return parsed;
}

function makeFakeResponse(pdfBytes) {
  return {
    project: {
      name: 'Stub Project (ANTHROPIC_FAKE=1)',
      client: 'Test Client',
      location: 'Anywhere, USA',
      scope_summary: `Stub scope summary -- received ${pdfBytes} bytes of PDF.`
    },
    milestones: [
      { name: 'Bid Due', date: null, notes: 'placeholder milestone' }
    ],
    trades: [
      { csi_division: '03 30 00', name: 'Cast-in-place concrete', scope_notes: '' },
      { csi_division: '06 10 00', name: 'Rough carpentry', scope_notes: '' }
    ],
    tasks: [
      { title: 'Stub: Set up estimating folder', stage: 'project-setup', priority: 'high', notes: '' },
      { title: 'Stub: Send concrete RFQ', stage: 'trade-solicitation', priority: 'medium', notes: '' }
    ],
    risks: ['stub risk note'],
    notes: 'This is a deterministic stub used in tests.'
  };
}

module.exports = { scopeExtractFromPdf, makeFakeResponse };
