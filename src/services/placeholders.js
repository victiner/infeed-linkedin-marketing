// src/services/placeholders.js
// Pure-JS placeholder rendering. NO LLM. NO Airtable round-trip.
// Substitutes {lead.field} and {notes.field} tokens in canonical example text
// with values from the active lead profile + extracted conversation notes.
//
// Syntax:
//   {lead.first_name}                  → required, throws if missing
//   {notes.interest_track}             → required, returns null result if missing (caller can skip example)
//   {notes.target_geography | London}  → optional with fallback string
//
// Returns { text, missingRequired: [...] } so callers can decide whether to
// skip an example whose required placeholders couldn't be filled.

const TOKEN_RE = /\{(lead|notes|asset)\.([a-z_][a-z0-9_]*)\s*(?:\|\s*([^}]+))?\}/gi;

function getLeadValue(lead, field) {
  if (!lead) return undefined;
  switch (field) {
    case 'name':        return lead.name;
    case 'first_name':  return (lead.name || '').split(/\s+/)[0] || lead.name;
    case 'last_name':   {
      const parts = (lead.name || '').split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    case 'firm':        return lead.company || lead.firm;
    case 'company':     return lead.company || lead.firm;
    case 'role':        return lead.role;
    case 'location':    return lead.location;
    case 'seniority':   return lead.seniority;
    default:            return lead[field];
  }
}

function getNotesValue(notes, field) {
  if (!notes || typeof notes !== 'object') return undefined;
  return notes[field];
}

// Asset values resolved at draft time. The asset object is whatever the smart matcher
// selected; alternates is a list of horizon-expanded fallbacks (also from matcher).
//
// Available fields:
//   {asset.url}                  → primary URL
//   {asset.name}                 → asset name (e.g. "London IB Analyst Roles")
//   {asset.type}                 → 'job_list' | 'booking_link' | 'onboarding_link' | etc.
//   {asset.description}          → asset description
//   {asset.industry}             → e.g. 'investment_banking'
//   {asset.geography}            → first geography (e.g. 'london')
//   {asset.experience}           → first experience level (e.g. 'analyst')
//   {asset.alternate_urls}       → comma-separated alternate URLs (horizon expansion)
//   {asset.alternate_count}      → number of alternates
//   {asset.alternate_summary}    → natural-language summary like "I also have a Frankfurt PE list"
function getAssetValue(asset, field, alternates) {
  if (field === 'alternate_urls') {
    return Array.isArray(alternates) && alternates.length
      ? alternates.map(a => a.url).filter(Boolean).join(', ')
      : '';
  }
  if (field === 'alternate_count') {
    return Array.isArray(alternates) ? String(alternates.length) : '0';
  }
  if (field === 'alternate_summary') {
    if (!Array.isArray(alternates) || alternates.length === 0) return '';
    const parts = alternates.slice(0, 3).map(a => {
      const tag = a.industry ? a.industry.replace(/_/g, ' ') : (a.name || a.type || 'list');
      const geo = (a.geographies && a.geographies[0]) ? a.geographies[0] : '';
      return geo ? `a ${geo} ${tag} list` : `a ${tag} list`;
    });
    return parts.length === 1 ? `I also have ${parts[0]}` :
      `I also have ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }
  if (!asset || typeof asset !== 'object') return undefined;
  switch (field) {
    case 'url':         return asset.url;
    case 'name':        return asset.name;
    case 'type':        return asset.type;
    case 'description': return asset.description;
    case 'industry':    return asset.industry || asset.segment;
    case 'geography':   return Array.isArray(asset.geographies) ? asset.geographies[0] : asset.geography;
    case 'experience':  return Array.isArray(asset.experience_levels) ? asset.experience_levels[0] : asset.experience;
    default:            return asset[field];
  }
}

// Render a single string. Returns { text, missingRequired }.
function render(text, { lead = {}, notes = {}, asset = null, alternates = [] } = {}) {
  if (!text || typeof text !== 'string') return { text: text || '', missingRequired: [] };
  const missingRequired = [];
  const out = text.replace(TOKEN_RE, (match, ns, field, fallback) => {
    let value;
    if      (ns === 'lead')   value = getLeadValue(lead, field);
    else if (ns === 'notes')  value = getNotesValue(notes, field);
    else if (ns === 'asset')  value = getAssetValue(asset, field, alternates);
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
    if (fallback !== undefined) return String(fallback).trim();
    // Required (no fallback) and missing — surface for caller decision
    missingRequired.push(`${ns}.${field}`);
    // Substitute with a readable placeholder so caller can decide to skip
    return ns === 'lead' ? '[name]' : ns === 'asset' ? '[link]' : '[…]';
  });
  return { text: out, missingRequired };
}

// Render a batch of examples. Skips any example whose required placeholders
// couldn't be filled (so Claude never sees broken text).
// ctx supports { lead, notes, asset, alternates }.
// Each example is { text, ...other fields kept verbatim }.
function renderExamples(examples, ctx, { skipOnMissing = true } = {}) {
  const kept = [];
  const skipped = [];
  for (const ex of (examples || [])) {
    const result = render(ex.text || ex.chosen || '', ctx);
    if (skipOnMissing && result.missingRequired.length > 0) {
      skipped.push({ ...ex, missingRequired: result.missingRequired });
      continue;
    }
    kept.push({ ...ex, text: result.text, _missingRequired: result.missingRequired });
  }
  return { kept, skipped };
}

// Convenience: scan text and return the list of placeholders found (used by the UI hint panel)
function listPlaceholders(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    found.push({ ns: m[1].toLowerCase(), field: m[2], fallback: m[3] || null, raw: m[0] });
  }
  return found;
}

module.exports = { render, renderExamples, listPlaceholders };
