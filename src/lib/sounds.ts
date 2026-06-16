'use client'

export type SoundName = 'card_deal' | 'raise' | 'call' | 'check' | 'fold' | 'all_in' | 'timer_warning'

class SoundManager {
  private ctx: AudioContext | null = null
  private lastTimerWarning = 0

  private ctx_(): AudioContext | null {
    if (typeof window === 'undefined') return null
    try {
      if (!this.ctx) this.ctx = new AudioContext()
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return this.ctx.state === 'closed' ? null : this.ctx
    } catch {
      return null
    }
  }

  // Call on first user gesture to warm-up the AudioContext.
  unlock(): void { this.ctx_() }

  play(name: SoundName): void {
    if (name === 'timer_warning') {
      const now = Date.now()
      if (now - this.lastTimerWarning < 900) return  // throttle: max once per 900 ms
      this.lastTimerWarning = now
    }
    const ctx = this.ctx_()
    if (!ctx) return
    const t = ctx.currentTime
    switch (name) {
      case 'card_deal':     this.cardDeal(ctx, t); break
      case 'raise':         this.raise(ctx, t); break
      case 'call':          this.callSound(ctx, t); break
      case 'check':         this.checkSound(ctx, t); break
      case 'fold':          this.foldSound(ctx, t); break
      case 'all_in':        this.allIn(ctx, t); break
      case 'timer_warning': this.timerWarn(ctx, t); break
    }
  }

  private osc(ctx: AudioContext, type: OscillatorType, freq: number, gain: number, t: number, dur: number): void {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.value = freq
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.start(t); o.stop(t + dur + 0.01)
  }

  private cardDeal(ctx: AudioContext, t: number): void {
    // Tonal sweep (card sliding)
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(900, t)
    o.frequency.exponentialRampToValueAtTime(260, t + 0.09)
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.11, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    o.start(t); o.stop(t + 0.11)

    // Noise layer (tactile "snap")
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.065), ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.1
    const n = ctx.createBufferSource()
    const ng = ctx.createGain()
    n.buffer = buf
    n.connect(ng); ng.connect(ctx.destination)
    ng.gain.setValueAtTime(0.07, t)
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.065)
    n.start(t); n.stop(t + 0.07)
  }

  private raise(ctx: AudioContext, t: number): void {
    // Ascending two-note cue
    this.osc(ctx, 'sine', 440, 0.15, t, 0.17)
    this.osc(ctx, 'sine', 660, 0.13, t + 0.1, 0.2)
  }

  private callSound(ctx: AudioContext, t: number): void {
    this.osc(ctx, 'sine', 520, 0.12, t, 0.18)
  }

  private checkSound(ctx: AudioContext, t: number): void {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(500, t)
    o.frequency.exponentialRampToValueAtTime(340, t + 0.09)
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.08, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    o.start(t); o.stop(t + 0.11)
  }

  private foldSound(ctx: AudioContext, t: number): void {
    // Descending tone
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(420, t)
    o.frequency.exponentialRampToValueAtTime(180, t + 0.22)
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.10, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
    o.start(t); o.stop(t + 0.25)
  }

  private allIn(ctx: AudioContext, t: number): void {
    // Rising chord
    ;[330, 415, 523, 659].forEach((f, i) => {
      this.osc(ctx, 'sine', f, 0.10, t + i * 0.065, 0.38)
    })
  }

  private timerWarn(ctx: AudioContext, t: number): void {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'square'
    o.frequency.value = 880
    o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.055, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    o.start(t); o.stop(t + 0.08)
  }
}

export const soundManager = new SoundManager()
