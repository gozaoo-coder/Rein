/** 麦克风占用仲裁：录音系统（recorderRuntime）与语音会话（voiceRuntime）互斥，谁先谁占。 */

export type MicOwner = 'recorder' | 'voice' | null

let owner: MicOwner = null

/** 申请占用；已被其他方占用时返回 false */
export function claimMic(who: Exclude<MicOwner, null>): boolean {
  if (owner && owner !== who) return false
  owner = who
  return true
}

export function releaseMic(who: Exclude<MicOwner, null>): void {
  if (owner === who) owner = null
}

export function micOwner(): MicOwner {
  return owner
}
