import { fail } from "../errors.ts"
import type { PermissionRule, RolePreset, TeamConfig } from "../types.ts"

export function rolePreset(config: TeamConfig, role: string): RolePreset {
  const preset = config.roles[role]
  if (!preset) {
    const roles = Object.keys(config.roles).sort().join(", ")
    fail(
      `role "${role}" is not configured.`,
      `Use one of the configured roles (${roles}) or ask the lead to add roles.${role} in the plugin options.`,
      "unknown_role",
    )
  }
  return preset
}

export function roleAgent(config: TeamConfig, preset: RolePreset): string {
  return preset.agent?.trim() || config.defaultAgent
}

/**
 * Session permission rules are additive here and always deny-only: a role can
 * restrict an agent further, never grant back a permission the project denied.
 */
export function permissionRules(preset: RolePreset): PermissionRule[] {
  const actions = [...new Set(preset.deny.map((action) => action.trim()).filter(Boolean))]
  return actions.map((action) => ({ action, resource: "*", effect: "deny" as const }))
}

export function roleNames(config: TeamConfig): string[] {
  return Object.keys(config.roles).sort()
}
