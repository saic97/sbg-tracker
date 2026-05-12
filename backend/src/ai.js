/* =============================================================================
 * ai.js -- Anthropic Claude integration for the SBG Tracker.
 *
 * Currently exposes two capabilities:
 *   scopeExtractFromPdf(pdfBuffer) -> { project, tasks, milestones, ... }
 *   subBidExtractFromPdf(pdfBuffer, meta) -> { subcontractor, total, exclusions, ... }
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

const SUB_BID_PROMPT = `You are an expert preconstruction estimator reading a subcontractor bid proposal PDF.

Extract the bid into structured data for a GC bid tab. Return ONLY a JSON object matching this schema -- no prose,
no markdown fences, just JSON:

{
  "subcontractor": {
    "name": "company name",
    "contact_name": "person if visible",
    "email": "contact email if visible",
    "phone": "contact phone if visible"
  },
  "trade": {
    "name": "trade/scope name, e.g. Electrical, Concrete, Drywall",
    "csi_division": "best matching CSI number if visible or inferable, e.g. 26 00 00"
  },
  "total": {
    "amount": 123456.78,
    "currency": "USD",
    "confidence": "high | medium | low",
    "label": "Base Bid / Lump Sum / Total Proposal, etc."
  },
  "alternates": [
    { "name": "alternate name/number", "amount": 1234.56, "notes": "" }
  ],
  "unit_prices": [
    { "description": "unit price description", "unit": "SF / LF / EA", "amount": 12.34 }
  ],
  "inclusions": ["included scope item"],
  "exclusions": ["excluded scope item"],
  "qualifications": ["qualification, assumption, condition, clarifier"],
  "addenda_acknowledged": ["Addendum 1", "Addendum 2"],
  "schedule": "duration or schedule note if visible",
  "tax_included": true,
  "bond_included": false,
  "scope_summary": "1-2 sentence summary of the proposal scope",
  "risk_flags": ["anything that needs estimator review"],
  "notes": "anything else important",
  "confidence": "high | medium | low"
}

Rules:
- Prefer the final total/base bid number meant to be carried into the bid tab.
- If there are several totals, choose the most likely base bid total and explain ambiguity in risk_flags.
- Do not add taxes/bonds/alternates into the total unless the proposal clearly says they are included.
- Use null for unknown amounts, empty arrays for missing lists, and never invent a company name.`;

async function scopeExtractFromPdf(pdfBuffer, opts = {}) {
  if (process.env.ANTHROPIC_FAKE === '1') return makeFakeScopeResponse(pdfBuffer.length);
  const client = getClient();
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model, max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: SCOPE_PROMPT }
      ]
    }]
  });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch { return { error: 'Could not parse Claude response as JSON', raw: text }; }
}

async function subBidExtractFromPdf(pdfBuffer, opts = {}) {
  if (process.env.ANTHROPIC_FAKE === '1') return makeFakeSubBidResponse(pdfBuffer.length);
  const client = getClient();
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model, max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: SUB_BID_PROMPT }
      ]
    }]
  });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch { return { error: 'Could not parse Claude response as JSON', raw: text }; }
}

function makeFakeScopeResponse(pdfBytes) {
  return {
    project: { name: 'Stub Project (ANTHROPIC_FAKE=1)', client: 'Test Client', location: 'Anywhere, USA', scope_summary: `Stub scope -- received ${pdfBytes} bytes.` },
    milestones: [{ name: 'Bid Due', date: null, notes: 'placeholder' }],
    trades: [{ csi_division: '03 30 00', name: 'Cast-in-place concrete', scope_notes: '' }],
    tasks: [{ title: 'Stub: Set up estimating folder', stage: 'project-setup', priority: 'high', notes: '' }],
    risks: ['stub risk note'], notes: 'deterministic stub'
  };
}

function makeFakeSubBidResponse(pdfBytes) {
  return {
    sub_name: 'Stub Sub Co.',
    contact_email: 'sub@example.com',
    trade: 'Concrete',
    csi_division: '03 30 00',
    base_bid_total: 123456,
    bid_currency: 'USD',
    proposal_date: null,
    inclusions: ['stub inclusion 1'],
    exclusions: ['stub exclusion 1'],
    qualifications: [],
    alternates: [],
    addenda_acknowledged: [],
    bond_included: false,
    scope_summary: `Stub sub bid (${pdfBytes} bytes)`,
    risk_flags: [],
    notes: 'deterministic stub',
    confidence: 'low'
  };
}

module.exports = { scopeExtractFromPdf, subBidExtractFromPdf, makeFakeScopeResponse, makeFakeSubBidResponse };
