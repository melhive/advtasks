/* templates.js — board templates. Each template defines starter columns and
   the custom_fields schema that appears on the card detail view. Both are
   CLONED onto the board when it's created — after that the board owns its
   own copy and the user can rename/add/delete/reorder freely without
   touching the template.
   Field types: text, textarea, number, select, date, url, tags */

const LABEL_PALETTE = [
  { name: 'green', color: '#4ade80' },
  { name: 'amber', color: '#f2b545' },
  { name: 'red', color: '#f0605a' },
  { name: 'blue', color: '#5eb3f0' },
  { name: 'purple', color: '#c98ef0' },
  { name: 'pink', color: '#e879f9' },
  { name: 'cyan', color: '#38bdf8' },
  { name: 'gray', color: '#93a89b' },
];

function cloneColumnsForBoard(names) {
  return names.map((name) => ({ id: uid('col'), name, wip_limit: null }));
}

function cloneFieldsForBoard(fields) {
  return fields.map((f) => ({ id: uid('fld'), ...f }));
}

function defaultLabelsForBoard() {
  // Give every new board 4 starter labels the user can rename/recolor/delete.
  return [
    { id: uid('lbl'), name: 'urgent', color: LABEL_PALETTE[2].color },
    { id: uid('lbl'), name: 'blocked', color: LABEL_PALETTE[1].color },
    { id: uid('lbl'), name: 'quick win', color: LABEL_PALETTE[0].color },
    { id: uid('lbl'), name: 'needs review', color: LABEL_PALETTE[3].color },
  ];
}

const BOARD_TEMPLATES = {
  bug_bounty: {
    label: 'Bug bounty',
    icon: 'ti-bug',
    accent: 'bb',
    columns: ['Recon', 'Filter / Triage', 'Targeted testing', 'Chaining', 'Reporting'],
    fields: [
      { key: 'target', label: 'Target / subdomain', type: 'text' },
      { key: 'program', label: 'Program', type: 'text' },
      { key: 'tier', label: 'Tier', type: 'select', options: ['Tier 1 — Financial', 'Tier 2 — Auth', 'Tier 3 — Data', 'Tier 4 — Input', 'Tier 5 — Infra'] },
      { key: 'vuln_class', label: 'Vuln class', type: 'text' },
      { key: 'cvss', label: 'CVSS estimate', type: 'number' },
      { key: 'bounty_status', label: 'Bounty status', type: 'select', options: ['Not submitted', 'Triaging', 'Accepted', 'Duplicate', 'Not applicable', 'Paid'] },
      { key: 'poc_link', label: 'PoC link', type: 'url' },
      { key: 'bounty_amount', label: 'Bounty amount', type: 'number' },
    ],
    cardTemplates: [
      {
        name: 'New finding',
        defaults: { tier: 'Tier 1 — Financial', bounty_status: 'Not submitted' },
        list: 'Filter / Triage',
      },
    ],
  },

  trading: {
    label: 'Trading',
    icon: 'ti-chart-candle',
    accent: 'tr',
    columns: ['Watchlist', 'Analyzing', 'Position open', 'Closed'],
    fields: [
      { key: 'ticker', label: 'Ticker', type: 'text' },
      { key: 'direction', label: 'Direction', type: 'select', options: ['Long', 'Short'] },
      { key: 'entry_price', label: 'Entry price', type: 'number' },
      { key: 'exit_price', label: 'Exit price', type: 'number' },
      { key: 'position_size', label: 'Position size', type: 'number' },
      { key: 'stop_loss', label: 'Stop loss', type: 'number' },
      { key: 'take_profit', label: 'Take profit', type: 'number' },
      { key: 'thesis', label: 'Thesis', type: 'textarea' },
      { key: 'r_multiple', label: 'R multiple', type: 'number' },
    ],
    cardTemplates: [
      { name: 'New setup', defaults: { direction: 'Long' }, list: 'Watchlist' },
    ],
  },

  youtube: {
    label: 'YouTube automation',
    icon: 'ti-brand-youtube',
    accent: 'yt',
    columns: ['Ideas', 'Scripting', 'Recording / editing', 'Scheduled', 'Published'],
    fields: [
      { key: 'video_title', label: 'Video title', type: 'text' },
      { key: 'target_keywords', label: 'Target keywords', type: 'tags' },
      { key: 'thumbnail_status', label: 'Thumbnail status', type: 'select', options: ['Not started', 'Draft', 'Final'] },
      { key: 'publish_date', label: 'Publish date', type: 'date' },
      { key: 'views', label: 'Views', type: 'number' },
      { key: 'ctr', label: 'CTR %', type: 'number' },
    ],
    cardTemplates: [
      { name: 'New video idea', defaults: { thumbnail_status: 'Not started' }, list: 'Ideas' },
    ],
  },

  affiliate: {
    label: 'Affiliate marketing',
    icon: 'ti-link',
    accent: 'af',
    columns: ['Ideas', 'Scripting', 'Scheduled', 'Completed'],
    fields: [
      { key: 'platform', label: 'Platform', type: 'text' },
      { key: 'affiliate_link', label: 'Affiliate link', type: 'url' },
      { key: 'commission_rate', label: 'Commission rate %', type: 'number' },
      { key: 'clicks', label: 'Clicks', type: 'number' },
      { key: 'conversions', label: 'Conversions', type: 'number' },
      { key: 'revenue', label: 'Revenue', type: 'number' },
    ],
    cardTemplates: [
      { name: 'New campaign', defaults: {}, list: 'Prospecting' },
    ],
  },

  workout: {
    label: 'Workout',
    icon: 'ti-barbell',
    accent: 'wo',
    columns: ['Planned', 'Executed', 'Completed'],
    fields: [
      { key: 'exercise', label: 'Exercise', type: 'text' },
      { key: 'sets', label: 'Sets', type: 'number' },
      { key: 'reps', label: 'Reps', type: 'number' },
      { key: 'weight', label: 'Weight', type: 'number' },
      { key: 'muscle_group', label: 'Muscle group', type: 'select', options: ['Push', 'Pull', 'Legs', 'Core', 'Cardio', 'Full body'] },
    ],
    cardTemplates: [
      { name: 'New session', defaults: { muscle_group: 'Full body' }, list: 'Planned' },
    ],
  },

  blank: {
    label: 'Custom board',
    icon: 'ti-layout-kanban',
    accent: 'bl',
    columns: ['To do', 'In progress', 'Done'],
    fields: [
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    cardTemplates: [],
  },
};

const TEMPLATE_ORDER = ['bug_bounty', 'trading', 'youtube', 'affiliate', 'workout', 'blank'];
