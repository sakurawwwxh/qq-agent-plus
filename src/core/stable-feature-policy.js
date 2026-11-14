export const STABLE_FEATURE_POLICY = Object.freeze({
  identityPilot: true,
  incomingFriendRequest: true,
  friendProposal: true,
  friendRequestDispatch: true,
  incidentPilot: true,
  slangPilot: false
});

const RETIRED_SLANG_KEYS = new Set(['enabled', 'graduated']);

function objectSection(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function normalizedAdminUin(value) {
  const uin = String(value || '').trim();
  return /^\d{5,15}$/.test(uin) ? uin : '';
}

function legacyAdminCandidates(config = {}) {
  return [
    config?.identityPilot?.friendProposal?.ownerUin,
    config?.incidentPilot?.ownerUin,
    config?.autoUpdate?.ownerUin,
    // One-time migration only. The retired slang worker no longer keeps an
    // administrator setting after this policy is applied.
    config?.slangPilot?.ownerUin
  ];
}

/** Return the one global administrator QQ used by every subsystem. */
export function globalAdminUin(config = {}) {
  return normalizedAdminUin(config?.admin?.ownerUin);
}

function adminAccessState(config = {}, ownerUin = '') {
  const privateAllow = Array.isArray(config?.allow?.private)
    ? config.allow.private.map(String)
    : [];
  const privateDeny = Array.isArray(config?.deny?.private)
    ? config.deny.private.map(String)
    : [];
  return {
    allowed: !ownerUin || config.allowAllWhenEmpty === true || privateAllow.includes(ownerUin),
    denied: Boolean(ownerUin && privateDeny.includes(ownerUin))
  };
}

function retiredSlangKeys(config = {}) {
  const slang = config?.slangPilot;
  if (!slang || typeof slang !== 'object' || Array.isArray(slang)) return [];
  return Object.keys(slang).filter((key) => !RETIRED_SLANG_KEYS.has(key)).sort();
}

export function stableFeatureFingerprint(config = {}) {
  const ownerUin = normalizedAdminUin(config?.admin?.ownerUin);
  const access = adminAccessState(config, ownerUin);
  return JSON.stringify({
    adminPresent: Boolean(
      config?.admin
      && typeof config.admin === 'object'
      && !Array.isArray(config.admin)
    ),
    adminOwnerUin: ownerUin,
    adminAllowed: access.allowed,
    adminDenied: access.denied,
    identityOwnerUin: normalizedAdminUin(config?.identityPilot?.friendProposal?.ownerUin),
    incidentOwnerUin: normalizedAdminUin(config?.incidentPilot?.ownerUin),
    updateOwnerUin: normalizedAdminUin(config?.autoUpdate?.ownerUin),
    identity: config?.identityPilot?.enabled === true,
    identityGraduated: config?.identityPilot?.graduated === true,
    incomingFriend: config?.identityPilot?.incomingFriendRequest?.enabled === true,
    friendProposal: config?.identityPilot?.friendProposal?.enabled === true,
    friendGraduated: config?.identityPilot?.friendProposal?.graduated === true,
    friendDispatch: config?.identityPilot?.friendProposal?.activeDispatchEnabled === true,
    slang: config?.slangPilot?.enabled === true,
    slangGraduated: config?.slangPilot?.graduated === true,
    retiredSlangKeys: retiredSlangKeys(config),
    incident: config?.incidentPilot?.enabled === true,
    incidentGraduated: config?.incidentPilot?.graduated === true
  });
}

/**
 * Apply production invariants in-place while preserving operational tuning.
 *
 * Administrator migration:
 * - once config.admin exists it is the sole source of truth, including an
 *   intentionally empty ownerUin;
 * - old installs without config.admin migrate the first valid historical owner
 *   in this order: Identity/Friends -> Incident -> Auto Update -> retired Slang;
 * - Identity/Incident/Auto Update keep temporary ownerUin mirrors only because
 *   legacy runtime code still reads those paths; the retired slang worker does not;
 * - a configured administrator is automatically allowed to private-message the
 *   bot and removed from the private deny list, so QQ approval commands work.
 */
export function applyStableFeaturePolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

  const hadAdminSection = Boolean(
    config.admin
    && typeof config.admin === 'object'
    && !Array.isArray(config.admin)
  );
  const admin = objectSection(config, 'admin');
  let ownerUin = normalizedAdminUin(admin.ownerUin);
  if (!hadAdminSection) {
    ownerUin = legacyAdminCandidates(config)
      .map(normalizedAdminUin)
      .find(Boolean) || '';
  }
  admin.ownerUin = ownerUin;
  // 群内 owner 只读命令：默认关闭，且默认作用于所有允许的群；可在控制台限定群。
  admin.groupCommands = {
    enabled: admin.groupCommands?.enabled === true,
    chats: Array.isArray(admin.groupCommands?.chats) ? admin.groupCommands.chats.map(String) : []
  };

  if (ownerUin) {
    const allow = objectSection(config, 'allow');
    const privateAllow = Array.isArray(allow.private) ? allow.private.map(String) : [];
    allow.private = [...new Set([...privateAllow, ownerUin])];

    const deny = objectSection(config, 'deny');
    const privateDeny = Array.isArray(deny.private) ? deny.private.map(String) : [];
    deny.private = privateDeny.filter((uin) => uin !== ownerUin);
  }

  const identity = objectSection(config, 'identityPilot');
  identity.enabled = true;
  identity.graduated = true;

  const incoming = objectSection(identity, 'incomingFriendRequest');
  incoming.enabled = true;

  // Active friend-adding is retired, not merely disabled (Issue #10): the
  // hand-built friendlist.addFriend packet is uniformly rejected by the
  // server (business code 1 regardless of fields or targets), SnowLuma
  // upstream declined to expose the kernel capability (#480, not_planned),
  // and the experiment burst triggered QQ account risk control. Keep the
  // section shape so stale clients can see it cannot be reactivated.
  const friend = objectSection(identity, 'friendProposal');
  friend.enabled = false;
  friend.graduated = false;
  friend.activeDispatchEnabled = false;
  friend.ownerUin = ownerUin;

  // Automated slang research is retired, not merely disabled. Keep only the
  // two tombstone flags so stale clients can see that it cannot be reactivated;
  // all worker tuning/owner configuration is removed from the canonical config.
  const slang = objectSection(config, 'slangPilot');
  for (const key of Object.keys(slang)) {
    if (!RETIRED_SLANG_KEYS.has(key)) delete slang[key];
  }
  slang.enabled = false;
  slang.graduated = false;

  const incident = objectSection(config, 'incidentPilot');
  incident.enabled = true;
  incident.graduated = true;
  incident.ownerUin = ownerUin;

  // Auto update is not forced on, but its administrator is global as well.
  const autoUpdate = objectSection(config, 'autoUpdate');
  autoUpdate.ownerUin = ownerUin;

  return config;
}

/**
 * The legacy validator tied "enabled" to experimental owner requirements.
 * Stable infrastructure must be able to start before an optional notification
 * owner is configured, so validation runs with only those obsolete gates down.
 * The public facade reapplies the production invariants immediately afterwards.
 */
export function suspendLegacyExperimentalGates(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

  const identity = objectSection(config, 'identityPilot');
  identity.enabled = false;
  identity.graduated = false;
  objectSection(identity, 'incomingFriendRequest').enabled = false;
  const friend = objectSection(identity, 'friendProposal');
  friend.enabled = false;
  friend.graduated = false;
  friend.activeDispatchEnabled = false;

  const slang = objectSection(config, 'slangPilot');
  slang.enabled = false;
  slang.graduated = false;

  const incident = objectSection(config, 'incidentPilot');
  incident.enabled = false;
  incident.graduated = false;

  return config;
}
