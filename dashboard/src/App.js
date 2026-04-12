// dashboard/src/App.js
// Full LinkedIn Nurture dashboard — wired to the real backend API

import React, { useState, useEffect, useCallback } from 'react';
import { api } from './services/api';

// ---- COLOUR & STAGE HELPERS ----
const STAGE_COLORS = {
  cold:    { bg: '#F1EFE8', text: '#5F5E5A', border: '#D3D1C7' },
  warm:    { bg: '#FAEEDA', text: '#854F0B', border: '#FAC775' },
  hot:     { bg: '#FDF0EB', text: '#E8734A', border: '#F5A882' },
  close:   { bg: '#EAF3DE', text: '#3B6D11', border: '#C0DD97' },
  nurture: { bg: '#EEEDFE', text: '#534AB7', border: '#CECBF6' },
};

const ROUTE_COLORS = {
  send_job_list:        { bg: '#EAF3DE', text: '#3B6D11' },
  book_call:            { bg: '#FDF0EB', text: '#E8734A' },
  send_landing_page:    { bg: '#EEEDFE', text: '#534AB7' },
  send_payment_link:    { bg: '#FAEEDA', text: '#854F0B' },
  send_onboarding_link: { bg: '#E1F5EE', text: '#085041' },
  human_takeover:       { bg: '#FCEBEB', text: '#A32D2D' },
};

const ROUTE_LABELS = {
  send_job_list:        'Send job list',
  book_call:            'Book call',
  send_landing_page:    'Send landing page',
  send_payment_link:    'Send payment link',
  send_onboarding_link: 'Send onboarding',
  human_takeover:       'Human takeover',
};

function Badge({ label, colors, size = 'sm' }) {
  const s = STAGE_COLORS[label] || colors || { bg: '#F1EFE8', text: '#5F5E5A' };
  const fs = size === 'sm' ? 11 : 12;
  return (
    <span style={{
      background: s.bg, color: s.text,
      border: `0.5px solid ${s.border || s.bg}`,
      fontSize: fs, fontWeight: 500,
      padding: '2px 8px', borderRadius: 10,
      whiteSpace: 'nowrap'
    }}>{label}</span>
  );
}

function Avatar({ name, colors = ['#B5D4F4', '#0C447C'] }) {
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{
      width: 34, height: 34, borderRadius: '50%',
      background: colors[0], color: colors[1],
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 500, flexShrink: 0
    }}>{initials}</div>
  );
}

const AVATAR_COLORS = [
  ['#B5D4F4', '#0C447C'], ['#9FE1CB', '#085041'],
  ['#CECBF6', '#3C3489'], ['#F5C4B3', '#712B13'],
  ['#C0DD97', '#27500A'], ['#FAC775', '#633806'],
];
function avatarColors(name) {
  const idx = (name || '').charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

// ---- INBOX PANEL ----
function InboxPanel({ onStats }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [editingDraft, setEditingDraft] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [error, setError] = useState(null);
  const [manualText, setManualText] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getConversations();
      const convos = data.conversations || [];
      setConversations(convos);
      if (convos.length && !selected) setSelected(convos[0]);
      if (onStats) onStats({ needsReply: convos.filter(c => c.pendingDraft).length });
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [selected, onStats]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const selectConvo = async (c) => {
    setSelected(c);
    setEditingDraft(null);
  };

  const handleSend = async (convoId, draftId, text) => {
    setSending(true);
    try {
      if (text !== undefined) {
        await api.overrideRoute(convoId, selected?.pendingDraft?.routingDecision?.routing_decision || 'send_job_list', text);
      }
      await api.sendDraft(convoId, draftId);
      setEditingDraft(null);
      await load();
    } catch (e) { setError(e.message); }
    setSending(false);
  };

  const handleTakeover = async (convoId) => {
    try { await api.takeover(convoId, 'manual'); await load(); }
    catch (e) { setError(e.message); }
  };

  const handleManualSend = async (convoId) => {
    if (!manualText.trim()) return;
    setSending(true);
    try {
      await api.overrideRoute(convoId, 'human_takeover', manualText);
      const updated = await api.getConversation(convoId);
      const draft = updated.conversation?.drafts?.find(d => d.status === 'pending');
      if (draft) await api.sendDraft(convoId, draft.id);
      setManualText('');
      await load();
    } catch (e) { setError(e.message); }
    setSending(false);
  };

  const handleReprocess = async (convoId) => {
    setSending(true);
    try { await api.processConversation(convoId); await load(); }
    catch (e) { setError(e.message); }
    setSending(false);
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--color-text-secondary)', fontSize: 14 }}>Loading conversations...</div>;
  if (error) return <div style={{ padding: 40, color: '#A32D2D', fontSize: 14 }}>Error: {error}</div>;

  const sel = selected ? conversations.find(c => c.id === selected.id) || selected : null;
  const pendingDraft = sel?.pendingDraft;
  const lead = sel?.lead;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Thread list */}
      <div style={{ width: 280, borderRight: '1px solid rgba(0,0,0,0.06)', overflowY: 'auto', flexShrink: 0, background: '#FFFFFF' }}>
        {conversations.length === 0 && (
          <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-secondary)' }}>
            No conversations yet. Messages will appear here when HeyReach fires a webhook.
          </div>
        )}
        {conversations.map(c => {
          const l = c.lead;
          const lastMsg = c.messages?.[c.messages.length - 1];
          const hasDraft = !!c.pendingDraft;
          const isSelected = sel?.id === c.id;
          return (
            <div key={c.id} onClick={() => selectConvo(c)}
              style={{
                padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.04)',
                cursor: 'pointer', background: isSelected ? '#FDF0EB' : 'transparent',
                borderLeft: isSelected ? '3px solid #E8734A' : '3px solid transparent',
                transition: 'all 0.12s ease'
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {hasDraft && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#E8734A', flexShrink: 0 }} />}
                {!hasDraft && <div style={{ width: 7, flexShrink: 0 }} />}
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l?.name || 'Unknown'}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 5, paddingLeft: 15 }}>
                {lastMsg?.text?.substring(0, 60) || '...'}
              </div>
              <div style={{ paddingLeft: 15, display: 'flex', gap: 5 }}>
                {l?.stage && <Badge label={l.stage} />}
                {c.pendingDraft?.routingDecision?.routing_decision && (
                  <Badge label={ROUTE_LABELS[c.pendingDraft.routingDecision.routing_decision] || c.pendingDraft.routingDecision.routing_decision}
                    colors={ROUTE_COLORS[c.pendingDraft.routingDecision.routing_decision]} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!sel ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 14 }}>
            Select a conversation
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#FFFFFF' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar name={lead?.name} colors={avatarColors(lead?.name)} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{lead?.name || 'Unknown'}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{lead?.role}{lead?.company ? ` · ${lead.company}` : ''}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {lead?.stage && <Badge label={lead.stage} />}
                <button onClick={() => handleReprocess(sel.id)} disabled={sending}
                  style={{ fontSize: 12, padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E6F1FB', color: '#E8734A', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                  Re-process
                </button>
                <button onClick={() => handleTakeover(sel.id)}
                  style={{ fontSize: 12, padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#FAEEDA', color: '#854F0B', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                  Take over
                </button>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 4, background: '#FAFAF8' }}>
              {(sel.messages || []).map((m, i) => {
                const isUs = m.sender === 'us';
                const prevMsg = sel.messages[i - 1];
                const sameSender = prevMsg?.sender === m.sender;
                return (
                  <div key={i} style={{ maxWidth: '70%', alignSelf: isUs ? 'flex-end' : 'flex-start', marginTop: sameSender ? 1 : 10 }}>
                    <div style={{
                      padding: '9px 14px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      background: isUs ? 'linear-gradient(135deg, #E8734A, #D4623D)' : '#FFFFFF',
                      color: isUs ? '#fff' : '#1A1A1A',
                      borderRadius: isUs ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                      boxShadow: isUs ? '0 1px 3px rgba(232,115,74,0.25)' : '0 1px 3px rgba(0,0,0,0.06)',
                      border: isUs ? 'none' : '0.5px solid rgba(0,0,0,0.06)'
                    }}>{m.text}</div>
                    <div style={{ fontSize: 10, color: '#9E9E9E', marginTop: 3, padding: '0 8px', textAlign: isUs ? 'right' : 'left' }}>
                      {m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* AI Draft */}
            {pendingDraft && (
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', padding: '14px 20px', background: '#FFFFFF' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI draft</span>
                    {pendingDraft.routingDecision?.routing_decision && (
                      <Badge label={ROUTE_LABELS[pendingDraft.routingDecision.routing_decision]}
                        colors={ROUTE_COLORS[pendingDraft.routingDecision.routing_decision]} />
                    )}
                    {pendingDraft.routingDecision?.confidence && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        {Math.round(pendingDraft.routingDecision.confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setEditingDraft(pendingDraft.id); setDraftText(pendingDraft.text); }}
                      style={{ fontSize: 12, padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#EEEDFE', color: '#534AB7', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                      Edit
                    </button>
                    <button onClick={() => handleSend(sel.id, pendingDraft.id)} disabled={sending}
                      style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', border: 'none', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: sending ? 0.6 : 1 }}>
                      {sending ? 'Sending...' : 'Send ↗'}
                    </button>
                  </div>
                </div>
                {editingDraft === pendingDraft.id ? (
                  <div>
                    <textarea value={draftText} onChange={e => setDraftText(e.target.value)}
                      style={{ width: '100%', fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical', minHeight: 80, fontFamily: 'var(--font-sans)' }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => setEditingDraft(null)}
                        style={{ fontSize: 12, padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#F1EFE8', color: '#5F5E5A', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                        Cancel
                      </button>
                      <button onClick={() => handleSend(sel.id, pendingDraft.id, draftText)} disabled={sending}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', border: 'none', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                        Send edited ↗
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, lineHeight: 1.6, background: 'var(--color-background-secondary)', padding: '10px 12px', borderRadius: 6, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-primary)' }}>
                    {pendingDraft.text}
                    {pendingDraft.asset && (
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        Asset: {pendingDraft.asset.name} — <a href={pendingDraft.asset.url} target="_blank" rel="noreferrer" style={{ color: '#E8734A' }}>{pendingDraft.asset.url}</a>
                      </div>
                    )}
                  </div>
                )}
                {pendingDraft.routingDecision?.routing_reason && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    Routing reason: {pendingDraft.routingDecision.routing_reason}
                  </div>
                )}
              </div>
            )}

            {!pendingDraft && (
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', padding: '14px 20px', background: '#FFFFFF' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <button onClick={() => handleReprocess(sel.id)} disabled={sending}
                    style={{ fontSize: 12, padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E6F1FB', color: '#E8734A', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: sending ? 0.6 : 1 }}>
                    {sending ? 'Processing...' : 'Generate AI draft'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <textarea value={manualText} onChange={e => setManualText(e.target.value)}
                    placeholder="Type a manual reply..."
                    style={{ flex: 1, fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical', minHeight: 50, fontFamily: 'var(--font-sans)' }} />
                  <button onClick={() => handleManualSend(sel.id)} disabled={sending || !manualText.trim()}
                    style={{ fontSize: 12, padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: (sending || !manualText.trim()) ? 0.5 : 1, alignSelf: 'flex-end' }}>
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- ANALYTICS PANEL ----
function AnalyticsPanel() {
  const [stats, setStats]       = useState(null);
  const [hrStats, setHrStats]   = useState(null);
  const [actions, setActions]   = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.getAnalytics(),
      api.getHeyReachStats(),
      api.getActions(30),
    ]).then(([s, hr, act]) => {
      if (s.status   === 'fulfilled') setStats(s.value);
      if (hr.status  === 'fulfilled') setHrStats(hr.value);
      if (act.status === 'fulfilled') setActions(act.value.actions || []);
      setLoading(false);
    });
  }, []);

  const MetricCard = ({ label, value, sub, color, small }) => (
    <div style={{ background: 'var(--color-background-secondary)', borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: small ? 18 : 22, fontWeight: 500, color: color || 'var(--color-text-primary)' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>{sub}</div>}
    </div>
  );

  const HBar = ({ label, pct, n, color, labelWidth = 130 }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: labelWidth, fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'right', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 20, background: 'var(--color-background-secondary)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(pct, pct > 0 ? 4 : 0)}%`, height: '100%', background: color, display: 'flex', alignItems: 'center', paddingLeft: 7, borderRadius: 4, transition: 'width 0.3s' }}>
          {pct >= 8 && <span style={{ fontSize: 10, fontWeight: 500, color: '#fff' }}>{pct}%</span>}
        </div>
      </div>
      <div style={{ width: 34, fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'right', flexShrink: 0 }}>{n}</div>
    </div>
  );

  const SectionTitle = ({ children }) => (
    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 14 }}>{children}</div>
  );

  const Card = ({ children, style }) => (
    <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16, ...style }}>
      {children}
    </div>
  );

  const ROUTE_LABELS = {
    send_job_list: 'Job lists', book_call: 'Book call',
    send_landing_page: 'Landing page', send_payment_link: 'Payment link',
    send_onboarding_link: 'Onboarding', human_takeover: 'Human takeover',
  };
  const STAGE_COLORS_BAR = { cold: '#888780', warm: '#BA7517', hot: '#E8734A', close: '#3B6D11', nurture: '#534AB7' };
  const FUNNEL_COLORS_BAR = {
    cold_opener: '#888780', natural_response: '#BA7517', value_pitch: '#E8734A', close: '#3B6D11', follow_up: '#534AB7',
  };

  if (loading) return <div style={{ padding: 40, fontSize: 14, color: 'var(--color-text-secondary)' }}>Loading analytics...</div>;

  const total = stats?.totalLeads || 0;

  // ---- HeyReach overall field mapping (handles snake_case & camelCase variants) ----
  const hr = hrStats?.overall || {};
  const hrCampaigns = hrStats?.campaigns?.items || hrStats?.campaigns || [];
  const hrLeads      = hr.totalLeads       ?? hr.total_leads       ?? '—';
  const hrReplies    = hr.messagesReplied  ?? hr.messages_replied  ?? hr.replies ?? '—';
  const hrConnSent   = hr.connectionRequestsSent     ?? hr.connection_requests_sent     ?? '—';
  const hrConnAcc    = hr.connectionRequestsAccepted ?? hr.connection_requests_accepted ?? '—';
  const hrReplyRate  = hr.replyRate        ?? hr.reply_rate        ?? (hrReplies !== '—' && hrLeads !== '—' && hrLeads > 0 ? Math.round((hrReplies / hrLeads) * 100) : '—');
  const hrConnRate   = hr.connectionRate   ?? hr.connection_rate   ?? (hrConnAcc !== '—' && hrConnSent !== '—' && hrConnSent > 0 ? Math.round((hrConnAcc / hrConnSent) * 100) : '—');

  // Conversion funnel data
  const convRoutes = stats?.conversionByRoute    || {};
  const totalByRoute = stats?.totalLeadsByRoute  || {};
  const convFunnel = stats?.conversionByFunnelStage || {};
  const allRouteKeys = [...new Set([...Object.keys(totalByRoute), ...Object.keys(convRoutes)])];

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Row 1: top-level KPIs ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <MetricCard label="Total leads" value={stats?.totalLeads} />
        <MetricCard label="Conversations" value={stats?.totalConversations} />
        <MetricCard label="Calls booked" value={stats?.callsBooked} color="#E8734A" />
        <MetricCard label="Converted" value={stats?.conversions} color="#3B6D11" />
        <MetricCard label="Human takeovers" value={stats?.humanTakeovers} color="#A32D2D" />
      </div>

      {/* ── Row 2: HeyReach stats ── */}
      <Card>
        <SectionTitle>HeyReach outreach {hrStats?.overallError && <span style={{ fontSize: 11, fontWeight: 400, color: '#A32D2D', marginLeft: 8 }}>({hrStats.overallError})</span>}</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: hrCampaigns.length ? 16 : 0 }}>
          <MetricCard label="Leads in HeyReach" value={hrLeads} small />
          <MetricCard label="Replies received" value={hrReplies} small />
          <MetricCard label="Connections accepted" value={hrConnAcc} small />
          <MetricCard label="Reply rate" value={hrReplyRate !== '—' ? `${hrReplyRate}%` : '—'} color="#E8734A" small />
        </div>
        {hrCampaigns.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Campaigns</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--color-text-tertiary)', textAlign: 'left' }}>
                    {['Campaign', 'Status', 'Leads', 'Connections', 'Replies'].map(h => (
                      <th key={h} style={{ padding: '4px 8px', fontWeight: 500, borderBottom: '0.5px solid var(--color-border-tertiary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hrCampaigns.slice(0, 10).map((c, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '6px 8px', fontWeight: 500 }}>{c.name || c.campaignName || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <Badge label={(c.status || '—').toLowerCase()}
                          colors={c.status === 'ACTIVE' ? { bg: '#EAF3DE', text: '#3B6D11', border: '#C0DD97' } : { bg: '#F1EFE8', text: '#5F5E5A', border: '#D3D1C7' }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>{c.totalLeads ?? c.leadsCount ?? '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{c.connectionRequestsAccepted ?? c.connectionsAccepted ?? '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{c.messagesReplied ?? c.replies ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* ── Row 3: Lead stages + Funnel stages side by side ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card>
          <SectionTitle>Lead stages</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['cold', 'warm', 'hot', 'close', 'nurture'].map(stage => {
              const n = stats?.stageBreakdown?.[stage] || 0;
              const pct = total ? Math.round((n / total) * 100) : 0;
              return <HBar key={stage} label={stage.charAt(0).toUpperCase() + stage.slice(1)} pct={pct} n={n} color={STAGE_COLORS_BAR[stage]} labelWidth={70} />;
            })}
          </div>
        </Card>
        <Card>
          <SectionTitle>Funnel stages</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['cold_opener', 'natural_response', 'value_pitch', 'close', 'follow_up'].map(fs => {
              const n = stats?.funnelStageBreakdown?.[fs] || 0;
              const pct = total ? Math.round((n / total) * 100) : 0;
              const label = fs.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              return <HBar key={fs} label={label} pct={pct} n={n} color={FUNNEL_COLORS_BAR[fs] || '#888780'} labelWidth={110} />;
            })}
          </div>
        </Card>
      </div>

      {/* ── Row 4: Conversion funnel ── */}
      <Card>
        <SectionTitle>Conversion by message strategy</SectionTitle>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Which routing actions preceded a lead converting to paid.
        </div>
        {allRouteKeys.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No sent messages logged yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--color-text-tertiary)', textAlign: 'left' }}>
                {['Strategy', 'Leads reached', 'Converted', 'Conversion rate'].map(h => (
                  <th key={h} style={{ padding: '4px 10px', fontWeight: 500, borderBottom: '0.5px solid var(--color-border-tertiary)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRouteKeys.map((route, i) => {
                const reached   = totalByRoute[route] || 0;
                const converted = convRoutes[route]   || 0;
                const rate      = reached > 0 ? Math.round((converted / reached) * 100) : 0;
                const routeColors = ROUTE_COLORS[route] || { bg: '#F1EFE8', text: '#5F5E5A' };
                return (
                  <tr key={route} style={{ borderBottom: i < allRouteKeys.length - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none' }}>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ background: routeColors.bg, color: routeColors.text, fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10 }}>
                        {ROUTE_LABELS[route] || route}
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px' }}>{reached}</td>
                    <td style={{ padding: '7px 10px', color: converted > 0 ? '#3B6D11' : 'var(--color-text-tertiary)', fontWeight: converted > 0 ? 500 : 400 }}>{converted}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 6, background: 'var(--color-background-secondary)', borderRadius: 3, overflow: 'hidden', maxWidth: 80 }}>
                          <div style={{ width: `${rate}%`, height: '100%', background: rate >= 20 ? '#3B6D11' : rate >= 10 ? '#BA7517' : '#888780', borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{rate}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Conversion by funnel stage */}
        {Object.keys(convFunnel).length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '0.5px solid var(--color-border-tertiary)' }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 10 }}>Converted leads — funnel stage at conversion</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(convFunnel).map(([fs, n]) => (
                <div key={fs} style={{ background: 'var(--color-background-secondary)', borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 500 }}>{n}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{fs.replace(/_/g, ' ')}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ── Row 5: Internal metrics ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <MetricCard label="Trial starts" value={stats?.trialStarts} sub="Leads who entered trial" />
        <MetricCard label="Credits used (total)" value={stats?.totalCreditsUsed} />
        <MetricCard label="Actions today" value={stats?.actionsToday} />
        <MetricCard label="Conn. rate" value={hrConnRate !== '—' ? `${hrConnRate}%` : '—'} sub="HeyReach connections" color="#534AB7" />
      </div>

      {/* ── Row 6: Recent activity ── */}
      <Card>
        <SectionTitle>Recent activity</SectionTitle>
        {actions.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No actions yet</div>}
        {actions.slice(0, 15).map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < Math.min(actions.length, 15) - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none' }}>
            <Badge label={a.type.replace(/_/g, ' ')} colors={{ bg: '#F1EFE8', text: '#5F5E5A', border: '#D3D1C7' }} />
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1 }}>
              {a.data?.routing && `→ ${ROUTE_LABELS[a.data.routing] || a.data.routing}`}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---- ASSET STATS ----
function AssetStats({ stats }) {
  if (!stats) return null;
  return (
    <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '12px 14px', background: 'var(--color-background-secondary)' }}>
      <div style={{ display: 'flex', gap: 24, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 2 }}>Times sent</div>
          <div style={{ fontSize: 20, fontWeight: 500 }}>{stats.totalDeliveries}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 2 }}>Drafts created</div>
          <div style={{ fontSize: 20, fontWeight: 500 }}>{stats.totalDrafts}</div>
        </div>
      </div>
      {stats.deliveries.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Not sent to anyone yet.</div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Sent to</div>
          {stats.deliveries.slice(0, 10).map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: i < Math.min(stats.deliveries.length, 10) - 1 ? '0.5px solid var(--color-border-tertiary)' : 'none' }}>
              <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>{d.leadName}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{d.leadCompany}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{new Date(d.sentAt).toLocaleDateString()}</span>
              {d.autoSent && <span style={{ fontSize: 10, background: '#EAF3DE', color: '#3B6D11', borderRadius: 4, padding: '1px 6px' }}>auto</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---- ASSETS PANEL ----
const ASSET_CATEGORIES = [
  { key: 'job_lists',        label: 'Job lists' },
  { key: 'trial_links',      label: 'Trial links' },
  { key: 'landing_pages',    label: 'Landing pages' },
  { key: 'payment_links',    label: 'Payment links' },
  { key: 'onboarding_links', label: 'Onboarding links' },
  { key: 'booking_links',    label: 'Booking links' },
];

const SEGMENTS = [
  'general', 'investment-banking-students', 'strategy-consulting',
  'vc-aspiring', 'employer-branding', 'premium-access'
];

const INPUT = { width: '100%', fontSize: 13, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' };

function AssetsPanel() {
  const [assets, setAssets]               = useState(null);
  const [showForm, setShowForm]           = useState(false);
  const [expandedStats, setExpandedStats] = useState(null);
  const [statsData, setStatsData]         = useState({});
  const [form, setForm] = useState({ name: '', category: 'job_lists', url: '', description: '', segment: 'general', tags: '' });
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = () => api.getAssets().then(setAssets).catch(console.error);
  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    setSaving(true); setSaveError(null);
    try {
      const tags = form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      await api.createAsset(form.category, { name: form.name, url: form.url, description: form.description, segment: form.segment, tags, active: true });
      setShowForm(false);
      setForm({ name: '', category: 'job_lists', url: '', description: '', segment: 'general', tags: '' });
      load();
    } catch (e) { setSaveError(e.message); }
    setSaving(false);
  };

  const toggleStats = async (assetId) => {
    if (expandedStats === assetId) { setExpandedStats(null); return; }
    if (!statsData[assetId]) {
      const s = await api.getAssetStats(assetId).catch(() => null);
      if (s) setStatsData(prev => ({ ...prev, [assetId]: s }));
    }
    setExpandedStats(assetId);
  };

  if (!assets) return <div style={{ padding: 40, fontSize: 14, color: 'var(--color-text-secondary)' }}>Loading assets...</div>;

  return (
    <div style={{ padding: 20, overflowY: 'auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button onClick={() => setShowForm(!showForm)}
          style={{ fontSize: 12, padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', background: showForm ? '#F1EFE8' : '#E8734A', color: showForm ? '#5F5E5A' : '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
          {showForm ? 'Cancel' : '+ New asset'}
        </button>
      </div>

      {/* Upload form */}
      {showForm && (
        <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 14 }}>New asset</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Name</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. IB & PE Roles Q3 2025" style={INPUT} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Category</div>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={INPUT}>
                {ASSET_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>URL</div>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." style={INPUT} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Target segment</div>
              <select value={form.segment} onChange={e => setForm(f => ({ ...f, segment: e.target.value }))} style={INPUT}>
                {SEGMENTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Description</div>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this asset and when should it be used?" style={INPUT} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Tags <span style={{ color: 'var(--color-text-tertiary)' }}>(comma-separated, optional)</span></div>
            <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="e.g. analyst, london, pe" style={INPUT} />
          </div>
          {saveError && <div style={{ fontSize: 12, color: '#A32D2D', marginBottom: 10 }}>{saveError}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={handleSave} disabled={saving || !form.name || !form.url}
              style={{ fontSize: 12, padding: '6px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: (!form.name || !form.url) ? 0.5 : 1 }}>
              {saving ? 'Saving...' : 'Save asset'}
            </button>
          </div>
        </div>
      )}

      {/* Asset sections */}
      {ASSET_CATEGORIES.map(cat => {
        const items = assets[cat.key] || [];
        if (items.length === 0) return null;
        return (
          <div key={cat.key} style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>{cat.label}</div>
            {items.map(a => (
              <div key={a.id} style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 3 }}>{a.description}</div>
                    <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#E8734A', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.url}</a>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', flexShrink: 0 }}>
                    <Badge label={a.active ? 'Active' : 'Draft'} colors={a.active ? { bg: '#EAF3DE', text: '#3B6D11' } : { bg: '#F1EFE8', text: '#5F5E5A' }} />
                    {(a.segment || a.offer) && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{a.segment || a.offer}</span>}
                    <button onClick={() => toggleStats(a.id)}
                      style={{ fontSize: 11, padding: '3px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', background: expandedStats === a.id ? '#E8734A' : '#E6F1FB', color: expandedStats === a.id ? '#fff' : '#E8734A', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                      {expandedStats === a.id ? 'Hide stats' : 'Stats'}
                    </button>
                  </div>
                </div>
                {expandedStats === a.id && <AssetStats stats={statsData[a.id]} />}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---- LEADS PANEL ----
const STAGE_ORDER = ['cold', 'warm', 'hot', 'close', 'nurture'];

function LeadsPanel() {
  const [leads, setLeads]       = useState(null);
  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');
  const [sortBy, setSortBy]     = useState('updatedAt');
  const [sortDir, setSortDir]   = useState('desc');
  const [showImport, setShowImport] = useState(false);
  const [importForm, setImportForm] = useState({ linkedInUrl: '', name: '', role: '', company: '', sendColdOpener: true });
  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState(null);

  const load = () => api.getLeads().then(d => setLeads(d.leads || [])).catch(console.error);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const handleImport = async () => {
    if (!importForm.linkedInUrl || !importForm.name) return;
    setImporting(true); setImportResult(null);
    try {
      const result = await api.importLead(importForm);
      setImportResult(result);
      setImportForm({ linkedInUrl: '', name: '', role: '', company: '', sendColdOpener: true });
      load();
      if (result.sent) setTimeout(() => { setShowImport(false); setImportResult(null); }, 3000);
    } catch (e) { setImportResult({ error: e.message }); }
    setImporting(false);
  };

  if (!leads) return <div style={{ padding: 40, fontSize: 14, color: 'var(--color-text-secondary)' }}>Loading leads...</div>;

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const filtered = leads
    .filter(l => filter === 'all' || l.stage === filter)
    .filter(l => !search || l.name?.toLowerCase().includes(search.toLowerCase()) || l.company?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      let va = a[sortBy] ?? '', vb = b[sortBy] ?? '';
      if (sortBy === 'updatedAt' || sortBy === 'createdAt') {
        va = new Date(va); vb = new Date(vb);
      }
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
    });

  const SortIcon = ({ col }) => sortBy !== col ? null : (
    <span style={{ marginLeft: 4, fontSize: 10 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  );

  const TH = ({ col, label, style = {} }) => (
    <th onClick={() => toggleSort(col)} style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: '0.5px solid var(--color-border-tertiary)', ...style }}>
      {label}<SortIcon col={col} />
    </th>
  );

  const stageCounts = STAGE_ORDER.reduce((acc, s) => {
    acc[s] = leads.filter(l => l.stage === s).length;
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Toolbar */}
      <div style={{ padding: '12px 20px', borderBottom: '0.5px solid var(--color-border-tertiary)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or company..."
          style={{ fontSize: 13, padding: '5px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", width: 220 }} />
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          {['all', ...STAGE_ORDER].map(s => (
            <button key={s} onClick={() => setFilter(s)}
              style={{ fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                background: filter === s ? '#E8734A' : '#FDF0EB',
                color:      filter === s ? '#fff'    : '#E8734A' }}>
              {s === 'all' ? `All (${leads.length})` : `${s} (${stageCounts[s] || 0})`}
            </button>
          ))}
        </div>
        <button onClick={() => { setShowImport(!showImport); setImportResult(null); }}
          style={{ fontSize: 12, padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', background: showImport ? '#F1EFE8' : '#E8734A', color: showImport ? '#5F5E5A' : '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", flexShrink: 0 }}>
          {showImport ? 'Cancel' : '+ Import lead'}
        </button>
      </div>

      {/* Import form */}
      {showImport && (
        <div style={{ padding: '14px 20px', borderBottom: '0.5px solid var(--color-border-tertiary)', background: '#FAF9F7' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: '#6B6B6B', marginBottom: 3 }}>LinkedIn URL <span style={{ color: '#E8734A' }}>*</span></div>
              <input value={importForm.linkedInUrl} onChange={e => setImportForm(f => ({ ...f, linkedInUrl: e.target.value }))}
                placeholder="https://linkedin.com/in/..." style={{ width: '100%', fontSize: 12, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: '#fff', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6B6B6B', marginBottom: 3 }}>Name <span style={{ color: '#E8734A' }}>*</span></div>
              <input value={importForm.name} onChange={e => setImportForm(f => ({ ...f, name: e.target.value }))}
                placeholder="James Mitchell" style={{ width: '100%', fontSize: 12, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: '#fff', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6B6B6B', marginBottom: 3 }}>Role</div>
              <input value={importForm.role} onChange={e => setImportForm(f => ({ ...f, role: e.target.value }))}
                placeholder="Analyst at Goldman Sachs" style={{ width: '100%', fontSize: 12, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: '#fff', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6B6B6B', marginBottom: 3 }}>Company</div>
              <input value={importForm.company} onChange={e => setImportForm(f => ({ ...f, company: e.target.value }))}
                placeholder="Goldman Sachs" style={{ width: '100%', fontSize: 12, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: '#fff', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div onClick={() => setImportForm(f => ({ ...f, sendColdOpener: !f.sendColdOpener }))} style={{
                width: 30, height: 17, borderRadius: 9, cursor: 'pointer', position: 'relative', flexShrink: 0,
                background: importForm.sendColdOpener ? '#E8734A' : '#ddd',
              }}>
                <div style={{ position: 'absolute', top: 2.5, [importForm.sendColdOpener ? 'right' : 'left']: 2.5, width: 12, height: 12, borderRadius: '50%', background: 'white', transition: 'left 0.15s, right 0.15s' }} />
              </div>
              <span style={{ fontSize: 12, color: '#6B6B6B' }}>Send AI cold opener via HeyReach</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {importResult?.error && <span style={{ fontSize: 12, color: '#A32D2D' }}>{importResult.error}</span>}
              {importResult?.sent && <span style={{ fontSize: 12, color: '#3B6D11' }}>Sent cold opener to {importResult.lead?.name}</span>}
              {importResult?.success && !importResult.sent && <span style={{ fontSize: 12, color: '#6B6B6B' }}>Lead added (no message sent)</span>}
              <button onClick={handleImport} disabled={importing || !importForm.linkedInUrl || !importForm.name}
                style={{ fontSize: 12, padding: '6px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: (!importForm.linkedInUrl || !importForm.name) ? 0.5 : 1 }}>
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 40, fontSize: 13, color: 'var(--color-text-secondary)' }}>No leads found.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--color-background-secondary)', position: 'sticky', top: 0, zIndex: 1 }}>
              <tr>
                <TH col="name"        label="Name" />
                <TH col="company"     label="Company" />
                <TH col="role"        label="Role" />
                <TH col="stage"       label="Stage" />
                <TH col="funnelStage" label="Funnel" />
                <TH col="sentiment"   label="Sentiment" />
                <TH col="creditsUsed" label="Credits" />
                <TH col="callBooked"  label="Call" />
                <TH col="converted"   label="Converted" />
                <TH col="updatedAt"   label="Last active" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => (
                <tr key={l.id} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: i % 2 === 0 ? 'transparent' : 'var(--color-background-secondary, #fafaf8)' }}>
                  <td style={{ padding: '9px 12px', fontSize: 13, fontWeight: 500 }}>{l.name || '—'}</td>
                  <td style={{ padding: '9px 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>{l.company || '—'}</td>
                  <td style={{ padding: '9px 12px', fontSize: 12, color: 'var(--color-text-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.role || '—'}</td>
                  <td style={{ padding: '9px 12px' }}><Badge label={l.stage || 'cold'} /></td>
                  <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{(l.funnelStage || '').replace(/_/g, ' ')}</td>
                  <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--color-text-secondary)' }}>{l.sentiment || '—'}</td>
                  <td style={{ padding: '9px 12px', fontSize: 12 }}>{l.creditsUsed ?? 0} / {l.creditsTotal ?? 20}</td>
                  <td style={{ padding: '9px 12px', fontSize: 12 }}>{l.callBooked ? <span style={{ color: '#3B6D11' }}>✓</span> : <span style={{ color: '#ccc' }}>—</span>}</td>
                  <td style={{ padding: '9px 12px', fontSize: 12 }}>{l.converted ? <span style={{ color: '#3B6D11' }}>✓</span> : <span style={{ color: '#ccc' }}>—</span>}</td>
                  <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {l.updatedAt ? new Date(l.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- PLAYBOOK PANEL ----
function PlaybookPanel() {
  const [playbook, setPlaybook] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.getPlaybook().then(setPlaybook).catch(console.error); }, []);

  const save = async () => {
    setSaving(true);
    await api.updatePlaybook(playbook);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const Toggle = ({ value, onChange }) => (
    <div onClick={() => onChange(!value)} style={{
      width: 32, height: 18, borderRadius: 9, cursor: 'pointer', position: 'relative',
      background: value ? '#E8734A' : 'var(--color-background-secondary)',
      border: value ? 'none' : '0.5px solid var(--color-border-secondary)'
    }}>
      <div style={{ position: 'absolute', top: 3, [value ? 'right' : 'left']: 3, width: 12, height: 12, borderRadius: '50%', background: 'white', transition: 'left 0.15s, right 0.15s' }} />
    </div>
  );

  const RuleRow = ({ label, sub, value, onChange }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>{sub}</div>}
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );

  if (!playbook) return <div style={{ padding: 40, fontSize: 14, color: 'var(--color-text-secondary)' }}>Loading playbook...</div>;

  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={save} disabled={saving}
          style={{ fontSize: 12, padding: '6px 16px', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', border: 'none', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
          {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>

      {/* Routing rules */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Routing rules</div>
        <RuleRow label="Lead with job list for warm leads" sub="When stage = warm and no prior CTA sent"
          value={playbook.rules?.leadWithJobListForWarm} onChange={v => setPlaybook(p => ({ ...p, rules: { ...p.rules, leadWithJobListForWarm: v } }))} />
        <RuleRow label="Book call for hot leads" sub="When reply count ≥ 3 or stage = hot"
          value={playbook.rules?.bookCallForHot} onChange={v => setPlaybook(p => ({ ...p, rules: { ...p.rules, bookCallForHot: v } }))} />
        <RuleRow label="Send payment link for close leads" sub="When stage = close and no live step needed"
          value={playbook.rules?.sendPaymentForClose} onChange={v => setPlaybook(p => ({ ...p, rules: { ...p.rules, sendPaymentForClose: v } }))} />
        <RuleRow label="Human takeover on frustration" sub="When sentiment = frustrated or topic = pricing complaint"
          value={playbook.rules?.humanTakeoverOnFrustrated} onChange={v => setPlaybook(p => ({ ...p, rules: { ...p.rules, humanTakeoverOnFrustrated: v } }))} />
      </div>

      {/* Auto-send threshold */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Auto-send threshold</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Send automatically when Claude confidence ≥ this value. Set to 1.0 to always require manual review.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input type="range" min="0.5" max="1.0" step="0.05" value={playbook.autoSendThreshold || 0.85}
            onChange={e => setPlaybook(p => ({ ...p, autoSendThreshold: parseFloat(e.target.value) }))}
            style={{ flex: 1 }} />
          <span style={{ fontSize: 14, fontWeight: 500, minWidth: 40 }}>{Math.round((playbook.autoSendThreshold || 0.85) * 100)}%</span>
        </div>
      </div>

      {/* Stage definitions */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Lead stage definitions</div>
        {Object.entries(playbook.stageDefinitions || {}).map(([stage, def]) => (
          <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
            <Badge label={stage} />
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1 }}>{def}</span>
          </div>
        ))}
      </div>

      {/* Tone */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Message tone</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[['tone', 'Default tone'], ['openingStyle', 'Opening style'], ['jobListFraming', 'Job list framing']].map(([key, label]) => (
            <div key={key}>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
              <input value={playbook[key] || ''} onChange={e => setPlaybook(p => ({ ...p, [key]: e.target.value }))}
                style={{ width: '100%', fontSize: 13, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- CAMPAIGNS PANEL ----
const FUNNEL_STAGES = [
  { key: 'cold_opener',       label: 'Cold opener' },
  { key: 'natural_response',  label: 'Natural response (fast)' },
  { key: 'value_pitch',       label: 'Value + pitch' },
  { key: 'close',             label: 'Close' },
  { key: 'follow_up',         label: 'Follow-up' },
];

const ROUTING_OPTIONS = [
  { key: '',                    label: 'AI decides' },
  { key: 'send_job_list',       label: 'Send job list' },
  { key: 'book_call',           label: 'Book call' },
  { key: 'send_landing_page',   label: 'Send landing page' },
  { key: 'send_payment_link',   label: 'Send payment link' },
  { key: 'send_onboarding_link',label: 'Send onboarding link' },
  { key: 'human_takeover',      label: 'Human takeover' },
];

const ASSET_CAT_OPTIONS = [
  { key: '',                  label: 'None' },
  { key: 'job_lists',         label: 'Job list' },
  { key: 'landing_pages',     label: 'Landing page' },
  { key: 'payment_links',     label: 'Payment link' },
  { key: 'onboarding_links',  label: 'Onboarding link' },
  { key: 'booking_links',     label: 'Booking link' },
];

const CAMPAIGN_SEGMENTS = [
  'general', 'investment-banking-students', 'strategy-consulting',
  'vc-aspiring', 'employer-branding', 'premium-access',
];

const STATUS_COLORS = {
  draft:  { bg: '#F1EFE8', text: '#5F5E5A', border: '#D3D1C7' },
  active: { bg: '#EAF3DE', text: '#3B6D11', border: '#C0DD97' },
  paused: { bg: '#FAEEDA', text: '#854F0B', border: '#FAC775' },
};

function CampaignsPanel() {
  const [campaigns, setCampaigns]       = useState([]);
  const [hrCampaigns, setHrCampaigns]   = useState([]);
  const [view, setView]                 = useState('list'); // 'list' | 'create' | 'edit'
  const [editing, setEditing]           = useState(null);   // campaign object being edited
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState(null);

  // blank campaign template
  const blankCampaign = () => ({
    name: '',
    segment: 'general',
    heyreachCampaignId: '',
    heyreachCampaignName: '',
    steps: FUNNEL_STAGES.map((fs, i) => ({
      id: `new-${i}`,
      stage:         fs.key,
      template:      '',
      routing:       '',
      delayHours:    i * 24,
      useAI:         true,
      assetCategory: '',
    })),
  });

  const load = () => api.getCampaigns().then(d => setCampaigns(d.campaigns || [])).catch(console.error);

  useEffect(() => {
    load();
    api.getHeyReachCampaigns()
      .then(d => setHrCampaigns(d.campaigns || []))
      .catch(() => {});
  }, []);

  const openCreate = () => { setEditing(blankCampaign()); setView('create'); setError(null); };
  const openEdit   = (c)  => { setEditing(JSON.parse(JSON.stringify(c))); setView('edit'); setError(null); };
  const backToList = ()   => { setView('list'); setEditing(null); setError(null); };

  const handleSave = async () => {
    if (!editing.name.trim()) { setError('Campaign name is required.'); return; }
    setSaving(true); setError(null);
    try {
      if (view === 'create') {
        await api.createCampaign(editing);
      } else {
        await api.updateCampaign(editing.id, editing);
      }
      await load();
      backToList();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this campaign?')) return;
    await api.deleteCampaign(id).catch(console.error);
    await load();
  };

  const handleStatus = async (id, status) => {
    await api.updateCampaign(id, { status }).catch(console.error);
    await load();
  };

  const setStep = (idx, field, val) => {
    setEditing(prev => {
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], [field]: val };
      return { ...prev, steps };
    });
  };

  const addStep = () => {
    setEditing(prev => ({
      ...prev,
      steps: [...prev.steps, { id: `new-${Date.now()}`, stage: 'follow_up', template: '', routing: '', delayHours: 0, useAI: true, assetCategory: '' }],
    }));
  };

  const removeStep = (idx) => {
    setEditing(prev => ({ ...prev, steps: prev.steps.filter((_, i) => i !== idx) }));
  };

  const CINPUT = { width: '100%', fontSize: 13, padding: '6px 10px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", boxSizing: 'border-box' };
  const CSELECT = { ...CINPUT, padding: '5px 10px' };

  // ---- LIST VIEW ----
  if (view === 'list') return (
    <div style={{ padding: 20, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button onClick={openCreate}
          style={{ fontSize: 12, padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
          + New campaign
        </button>
      </div>

      {campaigns.length === 0 && (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 14 }}>
          No campaigns yet. Click <strong>+ New campaign</strong> to build your first automated sequence.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {campaigns.map(c => {
          const sc = STATUS_COLORS[c.status] || STATUS_COLORS.draft;
          return (
            <div key={c.id} style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>{c.name}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ background: sc.bg, color: sc.text, border: `0.5px solid ${sc.border}`, fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10 }}>{c.status}</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{c.segment}</span>
                    {c.heyreachCampaignName && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>→ HeyReach: {c.heyreachCampaignName}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 12 }}>
                  {c.status !== 'active' && (
                    <button onClick={() => handleStatus(c.id, 'active')}
                      style={{ fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#EAF3DE', color: '#3B6D11', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                      Activate
                    </button>
                  )}
                  {c.status === 'active' && (
                    <button onClick={() => handleStatus(c.id, 'paused')}
                      style={{ fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#FAEEDA', color: '#854F0B', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                      Pause
                    </button>
                  )}
                  <button onClick={() => openEdit(c)}
                    style={{ fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#E6F1FB', color: '#E8734A', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                    Edit
                  </button>
                  <button onClick={() => handleDelete(c.id)}
                    style={{ fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#FCEBEB', color: '#A32D2D', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
                    Delete
                  </button>
                </div>
              </div>

              {/* Step preview */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {(c.steps || []).map((step, i) => {
                  const routeC = ROUTE_COLORS[step.routing] || { bg: '#F1EFE8', text: '#5F5E5A' };
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {i > 0 && <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>→</span>}
                      <span style={{
                        fontSize: 10, fontWeight: 500, padding: '2px 7px', borderRadius: 8,
                        background: routeC.bg, color: routeC.text,
                      }}>
                        {FUNNEL_STAGES.find(f => f.key === step.stage)?.label || step.stage}
                        {step.delayHours > 0 && <span style={{ opacity: 0.7, fontWeight: 400 }}> +{step.delayHours}h</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ---- CREATE / EDIT FORM ----
  const isNew = view === 'create';
  return (
    <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={backToList}
            style={{ fontSize: 12, padding: '5px 12px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'var(--color-text-secondary)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
            ← Back
          </button>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{isNew ? 'New campaign' : `Edit — ${editing.name}`}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {error && <span style={{ fontSize: 12, color: '#A32D2D' }}>{error}</span>}
          <button onClick={handleSave} disabled={saving}
            style={{ fontSize: 12, padding: '6px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', background: '#E8734A', color: '#fff', fontWeight: 500, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : isNew ? 'Create campaign' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Campaign metadata */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 14 }}>Campaign settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Campaign name <span style={{ color: '#A32D2D' }}>*</span></div>
            <input value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Q3 IB/PE Outreach" style={CINPUT} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Target segment</div>
            <select value={editing.segment} onChange={e => setEditing(p => ({ ...p, segment: e.target.value }))} style={CSELECT}>
              {CAMPAIGN_SEGMENTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              Link to HeyReach campaign <span style={{ color: 'var(--color-text-tertiary)' }}>(optional — for context)</span>
            </div>
            <select
              value={editing.heyreachCampaignId || ''}
              onChange={e => {
                const opt = hrCampaigns.find(c => String(c.id) === e.target.value);
                setEditing(p => ({ ...p, heyreachCampaignId: e.target.value, heyreachCampaignName: opt?.name || opt?.campaignName || '' }));
              }}
              style={CSELECT}>
              <option value="">— Not linked —</option>
              {hrCampaigns.map(c => (
                <option key={c.id} value={String(c.id)}>{c.name || c.campaignName || `Campaign ${c.id}`}</option>
              ))}
            </select>
            {hrCampaigns.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>No HeyReach campaigns found — check your API key.</div>
            )}
          </div>
        </div>
      </div>

      {/* Message sequence */}
      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Message sequence</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              Each step fires at the corresponding funnel stage. Toggle AI to generate dynamically, or write a fixed template.
            </div>
          </div>
          <button onClick={addStep}
            style={{ fontSize: 11, padding: '4px 12px', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'var(--color-text-secondary)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", flexShrink: 0 }}>
            + Add step
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(editing.steps || []).map((step, idx) => (
            <div key={step.id || idx} style={{ border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: 14, background: 'var(--color-background-secondary)' }}>

              {/* Step header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#E8734A', color: '#fff', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {idx + 1}
                </div>
                <select value={step.stage} onChange={e => setStep(idx, 'stage', e.target.value)}
                  style={{ ...CSELECT, flex: 1, fontWeight: 500 }}>
                  {FUNNEL_STAGES.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Delay</span>
                  <input type="number" min="0" value={step.delayHours}
                    onChange={e => setStep(idx, 'delayHours', parseInt(e.target.value) || 0)}
                    style={{ ...CINPUT, width: 60, textAlign: 'center' }} />
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>h</span>
                </div>
                <button onClick={() => removeStep(idx)}
                  style={{ fontSize: 12, padding: '3px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', background: '#FCEBEB', color: '#A32D2D', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", flexShrink: 0 }}>
                  ×
                </button>
              </div>

              {/* Step controls */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Routing action</div>
                  <select value={step.routing || ''} onChange={e => setStep(idx, 'routing', e.target.value)} style={CSELECT}>
                    {ROUTING_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Attach asset</div>
                  <select value={step.assetCategory || ''} onChange={e => setStep(idx, 'assetCategory', e.target.value)} style={CSELECT}>
                    {ASSET_CAT_OPTIONS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                  </select>
                </div>
              </div>

              {/* AI toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div onClick={() => setStep(idx, 'useAI', !step.useAI)} style={{
                  width: 30, height: 17, borderRadius: 9, cursor: 'pointer', position: 'relative', flexShrink: 0,
                  background: step.useAI ? '#E8734A' : 'var(--color-background-primary)',
                  border: step.useAI ? 'none' : '0.5px solid var(--color-border-secondary)',
                }}>
                  <div style={{ position: 'absolute', top: 2.5, [step.useAI ? 'right' : 'left']: 2.5, width: 12, height: 12, borderRadius: '50%', background: 'white', transition: 'left 0.15s, right 0.15s' }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {step.useAI ? 'AI-generated — template is guidance only' : 'Fixed — send template verbatim'}
                </span>
              </div>

              {/* Template */}
              <textarea
                value={step.template}
                onChange={e => setStep(idx, 'template', e.target.value)}
                placeholder={step.useAI
                  ? 'Optional: guide the AI (e.g. "Reference their background in IB, ask about job search timeline")'
                  : 'Write the exact message to send. Use {firstName}, {company}, {role} as placeholders.'}
                rows={3}
                style={{ ...CINPUT, resize: 'vertical', lineHeight: 1.5 }}
              />
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

// ---- ROOT APP ----
export default function App() {
  const [activePanel, setActivePanel] = useState('inbox');
  const [inboxStats, setInboxStats] = useState({});
  const [serverOk, setServerOk] = useState(null);

  useEffect(() => {
    api.health()
      .then(d => setServerOk(d.status === 'ok'))
      .catch(() => setServerOk(false));
  }, []);

  const NAV = [
    { id: 'inbox',     label: 'Conversations', badge: inboxStats.needsReply },
    { id: 'leads',     label: 'Leads' },
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'assets',    label: 'Asset library' },
    { id: 'playbook',  label: 'Playbook' },
  ];

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: '#FAF9F7', overflow: 'hidden' }}>

      {/* Sidebar */}
      <div style={{ width: 220, background: '#FFFFFF', borderRight: '1px solid rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', boxShadow: '1px 0 8px rgba(0,0,0,0.03)' }}>
        <div style={{ padding: '18px 16px 16px', borderBottom: '1px solid var(--if-border, rgba(0,0,0,0.08))' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1A1A1A', letterSpacing: '-0.01em' }}>LinkedIn Distribution</div>
        </div>
        <nav style={{ flex: 1 }}>
          {NAV.map(n => (
            <div key={n.id} onClick={() => setActivePanel(n.id)} style={{
              padding: '10px 16px', fontSize: 13, cursor: 'pointer',
              color: activePanel === n.id ? '#E8734A' : '#6B6B6B',
              borderLeft: activePanel === n.id ? '3px solid #E8734A' : '3px solid transparent',
              background: activePanel === n.id ? '#FDF0EB' : 'transparent',
              fontWeight: activePanel === n.id ? 500 : 400,
              borderRadius: '0 6px 6px 0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              transition: 'all 0.15s'
            }}>
              {n.label}
              {n.badge > 0 && (
                <span style={{ background: '#E8734A', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 600, padding: '2px 7px', minWidth: 18, textAlign: 'center' }}>{n.badge}</span>
              )}
            </div>
          ))}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--if-border, rgba(0,0,0,0.08))' }}>
          <div style={{ fontSize: 11, color: '#9E9E9E', marginBottom: 4 }}>Backend</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: serverOk === null ? '#888' : serverOk ? '#639922' : '#A32D2D' }} />
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)' }}>
              {serverOk === null ? 'Connecting...' : serverOk ? 'Connected' : 'Server offline'}
            </span>
          </div>
          {serverOk === false && (
            <div style={{ fontSize: 11, color: '#A32D2D', marginTop: 4 }}>
              Start with: npm start
            </div>
          )}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#FFFFFF' }}>
        <div style={{ padding: '14px 24px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#FFFFFF' }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: '#1A1A1A', margin: 0, letterSpacing: '-0.01em' }}>{NAV.find(n => n.id === activePanel)?.label}</h1>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {activePanel === 'inbox'     && <InboxPanel onStats={setInboxStats} />}
          {activePanel === 'leads'     && <LeadsPanel />}
          {activePanel === 'campaigns' && <CampaignsPanel />}
          {activePanel === 'analytics' && <AnalyticsPanel />}
          {activePanel === 'assets'    && <AssetsPanel />}
          {activePanel === 'playbook'  && <PlaybookPanel />}
        </div>
      </div>
    </div>
  );
}
