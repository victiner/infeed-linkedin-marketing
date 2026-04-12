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
async function sendMessage({ senderId, linkedInProfileUrl, message }) {
  const res = await axios.post(`${BASE_URL}/inbox/SendMessage`, {
    linkedInAccountId: senderId,
    linkedInProfileUrl,
    message
  }, { headers: headers() });
  return res.data;
}

// Add a lead to a campaign
async function addLeadToCampaign({ campaignId, linkedInProfileUrl, customFields = {} }) {
  const res = await axios.post(`${BASE_URL}/campaign/AddLeads`, {
    campaignId,
    leads: [{
      linkedInProfileUrl,
      customFields
    }]
  }, { headers: headers() });
  return res.data;
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
  updateLeadTags,
  getOverallStats,
  getConversationsNeedingReply,
  registerWebhook,
  listWebhooks
};
