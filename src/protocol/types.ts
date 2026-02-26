export interface UserState {
  gid?: number
  name?: string
  level?: number
  exp?: number
  expPercent?: number
  expCurrent?: number
  expNeeded?: number
  gold?: number
  uin?: string | number
}

export interface OperationLimit {
  id: number
  dayTimes: number
  dayTimesLimit: number
  dayExpTimes: number
  dayExpTimesLimit: number
}
