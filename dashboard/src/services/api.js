// dashboard/src/services/api.js
// All API calls to the Node.js backend

const BASE = process.env.REACT_APP_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Health
  health: () => request('/health'),

  // Workspaces
  getWorkspaces: () => request('/api/workspaces'),
  switchWorkspace: (id) => request('/api/workspace/switch', { method: 'POST', body: { id } }),

  // Senders (per workspace)
  getSenders: (workspaceId) => request(`/api/senders${workspaceId ? `?workspace=${workspaceId}` : ''}`),
  addSender: (senderId, workspaceId) => request('/api/senders', { method: 'POST', body: { senderId, workspaceId } }),
  removeSender: (senderId, workspaceId) => request(`/api/senders/${senderId}${workspaceId ? `?workspace=${workspaceId}` : ''}`, { method: 'DELETE' }),

  // Conversations
  getConversations: () => request('/api/conversations'),
  getConversation: (id) => request(`/api/conversations/${id}`),
  sendDraft: (id, draftId) => request(`/api/conversations/${id}/send`, {
    method: 'POST', body: { draftId }
  }),
  takeover: (id, reason) => request(`/api/conversations/${id}/takeover`, {
    method: 'POST', body: { reason }
  }),
  overrideRoute: (id, routing, draftText) => request(`/api/conversations/${id}/route`, {
    method: 'POST', body: { routing, draftText }
  }),
  processConversation: (id) => request(`/api/conversations/${id}/process`, {
    method: 'POST'
  }),

  // Leads
  getLeads: (stage) => request(`/api/leads${stage ? `?stage=${stage}` : ''}`),
  updateLead: (id, data) => request(`/api/leads/${id}`, {
    method: 'PATCH', body: data
  }),

  importLead: (data) => request('/api/leads/import', { method: 'POST', body: data }),

  // Assets
  getAssets: () => request('/api/assets'),
  selectAsset: (routing, segment) => request(`/api/assets/select?routing=${routing}&segment=${segment || 'general'}`),
  createAsset: (category, data) => request(`/api/assets/${category}`, { method: 'POST', body: data }),
  updateAsset: (category, id, data) => request(`/api/assets/${category}/${id}`, { method: 'PATCH', body: data }),
  toggleAsset: (category, id, active) => request(`/api/assets/${category}/${id}/toggle`, { method: 'POST', body: { active } }),
  deleteAsset: (category, id) => request(`/api/assets/${category}/${id}`, { method: 'DELETE' }),
  getAssetStats: (id) => request(`/api/assets/${id}/stats`),

  // Analytics
  getAnalytics: () => request('/api/analytics/linkedin-funnel'),
  getActions: (limit = 50) => request(`/api/analytics/actions?limit=${limit}`),
  getHeyReachStats: () => request('/api/analytics/heyreach'),

  // Playbook
  getPlaybook: () => request('/api/playbook'),
  updatePlaybook: (data) => request('/api/playbook', { method: 'POST', body: data }),

  // Campaigns
  getCampaigns: () => request('/api/campaigns'),
  getCampaign: (id) => request(`/api/campaigns/${id}`),
  getHeyReachCampaigns: () => request('/api/campaigns/heyreach-list'),
  createCampaign: (data) => request('/api/campaigns', { method: 'POST', body: data }),
  updateCampaign: (id, data) => request(`/api/campaigns/${id}`, { method: 'PATCH', body: data }),
  deleteCampaign: (id) => request(`/api/campaigns/${id}`, { method: 'DELETE' }),

  // Training
  getTrainingScenario: (type) => request(`/api/training/scenario${type ? `?type=${type}` : ''}`),
  recordPreference: (data) => request('/api/training/preference', { method: 'POST', body: data }),
  rateMessage: (data) => request('/api/training/rate', { method: 'POST', body: data }),
  getTrainingStats: () => request('/api/training/stats'),
  getTrainingCoverage: () => request('/api/training/coverage'),
  getPreferences: () => request('/api/training/preferences'),
  clearPreferences: () => request('/api/training/preferences', { method: 'DELETE' }),
  startConversation: () => request('/api/training/conversation/start', { method: 'POST', body: {} }),
  conversationReply: (lead, seniority, thread, chosenReply) => request('/api/training/conversation/reply', { method: 'POST', body: { lead, seniority, thread, chosenReply } }),
  getTrainingFilters: () => request('/api/training/filters'),
  getTargetedScenario: (seniority, stage) => request(`/api/training/targeted?${seniority ? `seniority=${seniority}` : ''}${seniority && stage ? '&' : ''}${stage ? `stage=${stage}` : ''}`),
  saveAnnotation: (data) => request('/api/training/annotate', { method: 'POST', body: data }),
  simulationStart: (seniority, stage) => request('/api/training/simulation/start', { method: 'POST', body: { seniority, stage } }),
  simulationStep: (lead, seniority, thread) => request('/api/training/simulation/step', { method: 'POST', body: { lead, seniority, thread } }),

  // Voice DNA
  getVoiceDna: () => request('/api/voice-dna'),
  getVoiceDnaStatus: () => request('/api/voice-dna/status'),
  regenerateVoiceDna: (force = false) => request('/api/voice-dna/regenerate', { method: 'POST', body: { force } }),
  previewVoiceDnaPrompt: () => request('/api/voice-dna/preview-prompt'),
  getVoiceDnaHistory: (limit = 2) => request(`/api/voice-dna/history?limit=${limit}`),
};
