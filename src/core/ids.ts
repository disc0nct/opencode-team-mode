const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export interface Clock {
  now(): number
}

export interface IdSource {
  ulid(): string
  teamId(): string
  envelopeId(): string
  memberId(role: string, index: number): string
  taskId(n: number): string
  deliveryId(): string
}

function encodeTime(time: number, length: number): string {
  let out = ""
  let value = time
  for (let i = 0; i < length; i++) {
    out = ENCODING[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function randomChars(length: number, random: () => number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += ENCODING[Math.floor(random() * 32)]
  return out
}

export function makeIds(clock: Clock, random: () => number = Math.random): IdSource {
  let lastTime = -1
  let lastRandom = ""

  const ulid = (): string => {
    const time = clock.now()
    const stamp = encodeTime(time, 10)
    if (time === lastTime && lastRandom) {
      // Increment the random part so IDs stay sortable inside one millisecond.
      const chars = lastRandom.split("")
      for (let i = chars.length - 1; i >= 0; i--) {
        const at = ENCODING.indexOf(chars[i] ?? "0")
        if (at >= 0 && at < 31) {
          chars[i] = ENCODING[at + 1] ?? "0"
          lastRandom = chars.join("")
          return stamp + lastRandom
        }
        chars[i] = "0"
      }
      lastRandom = randomChars(16, random)
      lastTime = time
      return stamp + lastRandom
    }
    lastTime = time
    lastRandom = randomChars(16, random)
    return stamp + lastRandom
  }

  let delivery = 0
  return {
    ulid,
    teamId: () => `tm_${ulid().slice(10).toLowerCase()}`,
    envelopeId: () => `env_${ulid().toLowerCase()}`,
    memberId: (role, index) => `${slug(role)}-${index}`,
    taskId: (n) => `t_${n}`,
    deliveryId: () => `dlv_${(++delivery).toString(36)}_${ulid().slice(10).toLowerCase()}`,
  }
}

export function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || "member"
}
