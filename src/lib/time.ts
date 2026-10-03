const HOUR = 3600
const DAY = 86400

export const now = () => Math.floor(Date.now() / 1000)

export const hhmm = (epoch: number) => {
  const d = new Date(epoch * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const weekday = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })

export const startOfHour = (epoch: number) => epoch - (epoch % HOUR)
export const startOfDay = (epoch: number) => {
  const d = new Date(epoch * 1000)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

export const addDays = (epoch: number, n: number) => epoch + n * DAY
export const addHours = (epoch: number, n: number) => epoch + n * HOUR

/** Rounds down to the nearest `minutes` slot. */
export const floorToMinutes = (epoch: number, minutes: number) => {
  const step = minutes * 60
  return epoch - (epoch % step)
}

export { HOUR, DAY }
