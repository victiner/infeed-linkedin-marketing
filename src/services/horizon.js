// src/services/horizon.js
// Horizon-expansion adjacency rules. NOT hardcoded — reads from workspace.horizon_axes
// so they're editable from the dashboard. Each adjacency is a fixed fact (intern→analyst,
// Munich↔Frankfurt) but you can refine them per workspace as your business evolves.
//
// Three independent graphs:
//   - experience: upward-only (intern → analyst, never the reverse)
//   - industry:   bidirectional pivots (IB ↔ PE)
//   - geography:  bidirectional finance hubs (Munich ↔ Frankfurt)
//
// Used by the smart job-list matcher to find horizon-expanding alternates when
// an exact match isn't available.

const workspace = require('./workspace');

// Lightweight aliases — kept here, not in workspace, since they're orthogonal to adjacency.
const INDUSTRY_ALIASES = {
  ib: 'investment_banking',
  pe: 'private_equity',
  am: 'asset_management',
  vc: 'venture_capital',
  hf: 'hedge_fund',
  consulting_firm: 'consulting',
  mgmt_consulting: 'consulting',
};
const GEOGRAPHY_ALIASES = {
  ny: 'nyc',
  new_york: 'nyc',
  new_york_city: 'nyc',
  sf: 'san_francisco',
  uk: 'london',
};

function normalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function canonicalIndustry(s)   { const n = normalize(s); return INDUSTRY_ALIASES[n]   || n; }
function canonicalGeography(s)  { const n = normalize(s); return GEOGRAPHY_ALIASES[n]  || n; }
function canonicalExperience(s) { return normalize(s); }

function axes() { return workspace.getHorizonAxes(); }

function adjacentExperience(level)  { return (axes().experience || {})[canonicalExperience(level)] || []; }
function adjacentIndustry(industry) { return (axes().industry   || {})[canonicalIndustry(industry)]  || []; }
function adjacentGeography(geo)     { return (axes().geography  || {})[canonicalGeography(geo)]      || []; }

function isAdjacentExperience(a, b) { return adjacentExperience(a).includes(canonicalExperience(b)); }
function isAdjacentIndustry(a, b)   { return adjacentIndustry(a).includes(canonicalIndustry(b)); }
function isAdjacentGeography(a, b)  { return adjacentGeography(a).includes(canonicalGeography(b)); }

module.exports = {
  axes,
  INDUSTRY_ALIASES, GEOGRAPHY_ALIASES,
  normalize, canonicalIndustry, canonicalGeography, canonicalExperience,
  adjacentExperience, adjacentIndustry, adjacentGeography,
  isAdjacentExperience, isAdjacentIndustry, isAdjacentGeography,
};
