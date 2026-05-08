#!/usr/bin/env node
/* Seed the database with the same defaults the frontend uses (stages,
   ball-in-court options, milestone types). Idempotent: skips entities that
   already have rows. */
require('dotenv').config();
const { getDb, runMigrations } = require('./db');
const m = require('./models');

const DEFAULT_STAGES = [
  { id: 'project-setup', name: 'Project Setup', icon: '📋', description: 'Bid/no-bid decision, document intake, estimating system setup, team assignments' },
  { id: 'special-project-task', name: 'Special Project Task', icon: '🌟', description: 'Non-standard or unique tasks specific to this project' },
  { id: 'document-review', name: 'Document Review', icon: '🔍', description: 'Drawings, specs, addenda, site walkthrough, pre-bid meeting, RFIs' },
  { id: 'trade-solicitation', name: 'Trade Solicitation', icon: '📨', description: 'Sub/vendor outreach, RFQ packages, coverage tracking, follow-ups' },
  { id: 'estimating', name: 'Estimating & Takeoffs', icon: '📐', description: 'Quantity takeoffs by division, self-perform pricing, unit costs, GCs' },
  { id: 'scope-leveling', name: 'Scope Review & Leveling', icon: '⚖️', description: 'Sub bid leveling, scope gap analysis, inclusions/exclusions, qualifications' },
  { id: 'bid-day-prep', name: 'Bid Day Prep', icon: '🎯', description: 'Final review, escalation/contingency, bid forms, proposal assembly, submission' },
  { id: 'bid-day', name: 'Bid Day', icon: '🏁', description: 'Day-of-bid activities -- final number lock, sub call-ins, quote chasing' },
  { id: 'post-bid', name: 'Post Bid', icon: '📊', description: 'Debrief, lessons learned, award tracking, buyout prep, handoff' }
];

const DEFAULT_BIC_OPTIONS = [
  'Estimator', 'Project Manager', 'Preconstruction Lead', 'VP Preconstruction',
  'Architect', 'Owner', 'Subcontractor'
].map(name => ({ name }));

const DEFAULT_MILESTONE_TYPES = [
  { id: 'trade-partner-bids', name: 'Trade Partner Bids Due', icon: '💼', color: '#c8322b', default_days_before_bid: 1 },
  { id: 'rfi-trade', name: 'RFIs Due (Trade)', icon: '❓', color: '#2563a8', default_days_before_bid: 7 },
  { id: 'rfi-client', name: 'RFIs Due (Client)', icon: '❔', color: '#7b4397', default_days_before_bid: 5 },
  { id: 'bid-leveling', name: 'Bid Leveling', icon: '⚖️', color: '#d4a017', default_days_before_bid: 0 },
  { id: 'exec-review', name: 'Executive Review', icon: '🧐', color: '#0a2540', default_days_before_bid: 2 },
];

function seed() {
  runMigrations(getDb());
  if (m.stages.list().length === 0) {
    console.log('[seed] inserting default stages…');
    m.stages.replaceAll(DEFAULT_STAGES.map((s, i) => ({ ...s, position: i })));
  }
  if (m.ballInCourtOptions.list().length === 0) {
    console.log('[seed] inserting default ball-in-court options…');
    m.ballInCourtOptions.replaceAll(DEFAULT_BIC_OPTIONS.map((o, i) => ({ ...o, position: i })));
  }
  if (m.milestoneTypes.list().length === 0) {
    console.log('[seed] inserting default milestone types…');
    m.milestoneTypes.replaceAll(DEFAULT_MILESTONE_TYPES.map((s, i) => ({ ...s, position: i })));
  }
  console.log('[seed] done');
}

if (require.main === module) {
  try { seed(); } catch (e) { console.error('[seed] failed:', e); process.exit(1); }
}

module.exports = { seed };
