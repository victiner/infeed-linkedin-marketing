// src/services/heyreach.js
// All HeyReach API interactions
// Docs: https://documenter.getpostman.com/view/23808049/2sA2xb5F75

const axios = require('axios');

const BASE_URL = 'https://api.heyreach.io/api/public';

function headers() {
  return {
    'X-API-KEY': process.env.HEYREACH_API_KEY,
    'Content-Type': 'application/json'
  };
}

// Verify the API key is working
async function checkApiKey() {
  const res = await axios.get(`${BASE_URL}/auth/CheckApiKey`, { headers: headers() });
  return res.status === 200;
}

// Get all LinkedIn accounts (senders) connected to HeyReach
async function getLinkedInAccounts() {
  const res = await axios.post(`${BASE_URL}/linkedin-account/GetAll`, {
    offset: 0, limit: 50
  }, { headers: headers() });
  return res.data;
}

// Get all campaigns with pagination
async function getCampaigns(page = 1, limit = 50) {
  const res = await axios.post(`${BASE_URL}/campaign/GetAll`, {
    offset: (page - 1) * limit, limit
  }, { headers: headers() });
  return res.data;
}

// Get conversations (inbox) — optionally filter by sender or status
// status: ALL | UNREAD | REPLIED | NEEDS_REPLY
async function getConversations({ page = 1, limit = 20, status = 'ALL', senderId = null } = {}) {
  const body = { offset: (page - 1) * limit, limit, status };
  if (senderId) body.linkedInAccountId = senderId;

  const res = await axios.post(`${BASE_URL}/inbox/GetConversationsV2`, body, {
    headers: headers()
  });
  return res.data;
}

// Get a single conversation thread by conversation ID
async function getConversationById(conversationId) {
  const res = await axios.get(`${BASE_URL}/conversations/GetById`, {
    headers: headers(),
    params: { conversationId }
  });
  return res.data;
}

// Get detailed lead profile info
async function getLeadDetails(linkedInProfileUrl) {
  const res = await axios.post(`${BASE_URL}/leads/GetByLinkedInUrl`, {
    linkedInProfileUrl
  }, { headers: headers() });
  return res.data;
}

// Send a message to a lead via a specific LinkedIn sender account
async function sendMessage({ senderId, conversationId, message }) {
  const res = await axios.post(`${BASE_URL}/inbox/SendMessage`, {
    linkedInAccountId: senderId,
    conversationId,
    message
  }, { headers: headers() });
  return res.data;
}

// Queue a lead in a HeyReach campaign by adding to the lead list bound to it.
// VERIFIED via direct API probes against HeyReach 2026-05-15.
//
// HeyReach data model:
//   Lead List (id 608000, "Test")  ← leads live here
//        ↑ bound to ↓
//   Campaign (id 431707, "Test V1") ← processes leads from its list
//
// Adding via campaign/AddLeadsToCampaign returned "0" (silent reject).
// The working path is list/AddLeadsToList:
//   - field name is `profileUrl` (not linkedInProfileUrl — silent reject)
//   - customUserFields: [{name, value}] is supported and substituted in the
//     campaign's message template via {{name}} placeholders.
//
// `listId` should match the lead list bound to the campaign you want to use.
// In env: set HEYREACH_DEFAULT_LIST_ID to that list's numeric ID.
async function addLeadToList({ listId, profileUrl, firstName, lastName, companyName, customFields = {} }) {
  const customUserFields = Object.entries(customFields || {})
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([name, value]) => ({ name, value: String(value) }));

  const lead = {
    profileUrl,
    ...(firstName   ? { firstName }   : {}),
    ...(lastName    ? { lastName }    : {}),
    ...(companyName ? { companyName } : {}),
    ...(customUserFields.length ? { customUserFields } : {}),
  };

  const body = {
    listId: parseInt(listId, 10) || listId,
    leads: [lead],
  };

  const res = await axios.post(`${BASE_URL}/list/AddLeadsToList`, body, { headers: headers() });
  // HeyReach returns the count of leads added (e.g. 1). 0 means silent
  // rejection — usually because the lead is already in the list (dedup) or
  // the URL is malformed.
  if (res.data === 0 || res.data === '0') {
    const err = new Error('HeyReach silently rejected lead (returned count=0). Likely already in list, dedup, or invalid URL.');
    err.heyReachCount = 0;
    throw err;
  }
  return { added: typeof res.data === 'number' ? res.data : 1, raw: res.data };
}

// Backwards-compat alias — routes/leads.js still calls addLeadToCampaign.
// Maps the campaign-style invocation onto the list-based reality.
async function addLeadToCampaign({ campaignId, listId, accountIds = [], linkedInProfileUrl, customFields = {} }) {
  // listId param wins; otherwise fall back to env var.
  const targetListId = listId || process.env.HEYREACH_DEFAULT_LIST_ID;
  if (!targetListId) {
    throw new Error('HEYREACH_DEFAULT_LIST_ID env var not set (the lead list ID bound to your HeyReach campaign).');
  }
  return addLeadToList({
    listId: targetListId,
    profileUrl: linkedInProfileUrl,
    customFields,
  });
}

// Update tags on a lead
async function updateLeadTags({ senderId, linkedInProfileUrl, tags }) {
  const res = await axios.post(`${BASE_URL}/leads/UpdateTags`, {
    linkedInAccountId: senderId,
    linkedInProfileUrl,
    tags
  }, { headers: headers() });
  return res.data;
}

// Get overall account stats
async function getOverallStats() {
  const res = await axios.get(`${BASE_URL}/statistics/GetOverall`, {
    headers: headers()
  });
  return res.data;
}

// Get conversations that need a reply (smart inbox filter)
async function getConversationsNeedingReply(senderId = null) {
  return getConversations({ status: 'NEEDS_REPLY', senderId });
}

// Register a webhook endpoint in HeyReach
async function registerWebhook({ url, events }) {
  // events: array of event types e.g. ['MESSAGE_REPLY_RECEIVED', 'CONNECTION_REQUEST_ACCEPTED']
  const res = await axios.post(`${BASE_URL}/webhooks/Create`, {
    url,
    events
  }, { headers: headers() });
  return res.data;
}

// List all registered webhooks
async function listWebhooks() {
  const res = await axios.get(`${BASE_URL}/webhooks/GetAll`, { headers: headers() });
  return res.data;
}

module.exports = {
  checkApiKey,
  getLinkedInAccounts,
  getCampaigns,
  getConversations,
  getConversationById,
  getLeadDetails,
  sendMessage,
  addLeadToCampaign,
  addLeadToList,
  updateLeadTags,
  getOverallStats,
  getConversationsNeedingReply,
  registerWebhook,
  listWebhooks
};
