import { TEAM_ROLES, minRoleFor, type TeamRole } from "../tenant/permissions.js";
import {
  ALL_SCOPES,
  SCOPES,
  SCOPE_IMPACTS,
  SCOPE_PRESETS,
  SCOPE_PRESET_DESCRIPTIONS,
  SCOPE_RISKS,
  type Scope,
  type ScopeImpact,
  type ScopePreset,
  type ScopeRisk,
} from "../tenant/scopes.js";

/**
 * The scope catalog GET /api-keys/scopes serves: every scope and preset,
 * derived from the registry in tenant/scopes.ts and the role table in
 * tenant/permissions.ts, so it cannot drift from what POST /api-keys and the
 * route guards enforce.
 */

export interface ScopeEntry {
  name: Scope;
  description: string;
  risk: ScopeRisk;
  impact: ScopeImpact;
  /** The least team role whose holder may grant (mint a key with) this scope. */
  minRole: TeamRole;
}

export interface PresetEntry {
  name: ScopePreset;
  description: string;
  /** The concrete scopes a key minted from this preset stores, in registry order. */
  scopes: Scope[];
  /** The least team role that may mint the whole preset. */
  minRole: TeamRole;
}

export interface ScopeCatalog {
  roles: readonly TeamRole[];
  risks: readonly ScopeRisk[];
  impacts: readonly ScopeImpact[];
  scopes: ScopeEntry[];
  presets: PresetEntry[];
}

function scopeMinRole(scope: Scope): TeamRole {
  const role = minRoleFor(SCOPES[scope].rolePermission);
  if (!role) throw new Error(`No team role grants the scope ${scope}`);
  return role;
}

export function buildScopeCatalog(): ScopeCatalog {
  const scopes = ALL_SCOPES.map((name): ScopeEntry => ({
    name,
    description: SCOPES[name].description,
    risk: SCOPES[name].risk,
    impact: SCOPES[name].impact,
    minRole: scopeMinRole(name),
  }));
  const presets = (Object.keys(SCOPE_PRESETS) as ScopePreset[]).map((name): PresetEntry => {
    const members: readonly Scope[] = SCOPE_PRESETS[name];
    const list = ALL_SCOPES.filter((s) => members.includes(s));
    const rank = Math.max(...list.map((s) => TEAM_ROLES.indexOf(scopeMinRole(s))));
    return {
      name,
      description: SCOPE_PRESET_DESCRIPTIONS[name],
      scopes: list,
      minRole: TEAM_ROLES[rank],
    };
  });
  return {
    roles: TEAM_ROLES,
    risks: SCOPE_RISKS,
    impacts: SCOPE_IMPACTS,
    scopes,
    presets,
  };
}
