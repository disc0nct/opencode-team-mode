export class TeamError extends Error {
  readonly guidance: string
  readonly code: string

  constructor(message: string, guidance: string, code = "team_error") {
    super(message)
    this.name = "TeamError"
    this.guidance = guidance
    this.code = code
  }
}

export function fail(message: string, guidance: string, code?: string): never {
  throw new TeamError(message, guidance, code)
}

export function asTeamError(error: unknown): TeamError {
  if (error instanceof TeamError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new TeamError(message, "Retry the tool once. If it still fails, report the error to the lead with team_send.", "unexpected")
}
