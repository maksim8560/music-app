/* ==========================================================================
   audio/engine.js — Web Audio graph, voices, crossfade, EQ, analysis
   ----------------------------------------------------------------------------
   busSum → EQ(low/mid/high) → compressor → analyser → master → destination
   voices ─┬─ per-voice reverb send  → convolver (generated IR) → revReturn ─┘
           └─ per-voice delay send   → ping-pong delay ──────────────────────┘
   ========================================================================== */

import { Composer, instruments } from './synth.js';
import { addTask } from '../core/raf.js';
import { clamp } from '../core/dom.js';

const LOOKAHEAD = 0.6; // seconds of bars scheduled in advance
const TICK_MS = 25;

export const EQ_PRESETS = {
  flat: { low: 0, mid: 0, high: 0 },
  warm: { low: 3.4, mid: -1.6, high: -4.2 },
  bright: { low: -1.8, mid: 1.6, high: 3.2 },
  air: { low: -1.2, mid: -0.4, high: 5 },
};

function makeImpulse(ctx, seconds = 2.6, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // slightly diffuse early part, smooth exponential tail
      const env = (1 - t) ** decay;
      data[i] = (Math.random() * 2 - 1) * env * (ch === 0 ? 1 : 0.96);
    }
  }
  return buf;
}

/* ==========================================================================
   Voice — one playing thing (synth track or decoded file)
   ========================================================================== */
class Voice {
  constructor(engine, track) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.track = track;
    this.kind = track.buffer ? 'file' : 'synth';
    this.id = `${track.id}#${Math.random().toString(36).slice(2, 7)}`;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(engine.busSum);

    this.revSend = ctx.createGain();
    /* Synth notes carry their own per-note send, so the voice-level send stays
       shut for them — otherwise the reverb would be counted twice now that the
       dry signal passes through this gain. Decoded files have no per-note
       sends, so theirs does the work. */
    this.revSend.gain.value = this.kind === 'file'
      ? (track.mood?.reverb != null ? clamp(track.mood.reverb * 0.55, 0, 0.7) : 0.2)
      : 0;
    this.revSend.connect(engine.revIn);
    this.gain.connect(this.revSend);

    this.delSend = ctx.createGain();
    this.delSend.gain.value = this.kind === 'file'
      ? (track.mood?.pluck != null ? clamp(track.mood.pluck * 0.4, 0, 0.45) : 0.15)
      : 0;
    this.delSend.connect(engine.delayIn);
    this.gain.connect(this.delSend);

    this.startedAt = 0;
    this.offset = 0;
    this.duration = track.duration || 0;
    this.finished = false;
    this.timer = 0;
    this.source = null;
    this.composer = null;
  }

  get time() {
    if (!this.startedAt) return this.offset;
    return this.offset + (this.engine.ctx.currentTime - this.startedAt);
  }

  /* --------------------------- synth voices --------------------------- */
  startSynth(when, offset) {
    const { ctx } = this.engine;
    const composer = new Composer(this.track);
    this.composer = composer;
    this.duration = this.track.duration;

    /* Notes must land on this voice's own gain, not straight on the master bus.
       Going direct looked fine until a track change: `voice.fade()` had nothing
       to fade, the scheduler stopped but every note already handed to the graph
       kept ringing into the mix, and the outgoing track played on top of the
       incoming one. The reverb/delay sends stay per-note, where the envelope
       can shape them. */
    const out = this.gain;
    const buses = { revSend: this.revSend, delSend: this.delSend, mood: composer.mood };
    const barDur = composer.barDur;

    const firstBar = Math.floor(offset / barDur);
    const phase = offset - firstBar * barDur;
    /* starting at a bar boundary: play that bar right away, otherwise skip the
       remainder of the current one (resume-from-position behaviour) */
    const atBarStart = phase < 0.08;
    let nextBar = atBarStart ? firstBar : firstBar + 1;
    let nextBarTime = atBarStart ? when : when + (barDur - phase);

    this.startedAt = when - phase;
    this.offset = offset;

    const schedule = () => {
      const now = ctx.currentTime;
      while (nextBarTime < now + LOOKAHEAD) {
        if (nextBarTime >= when + (this.duration - offset)) {
          // past the end of the track: stop scheduling, let it ring out
          this.stopScheduler();
          return;
        }
        const events = composer.render(nextBar);
        for (const ev of events) {
          const fn = instruments[ev.kind];
          if (fn) fn(ctx, out, nextBarTime + ev.t, ev, buses);
        }
        nextBar++;
        nextBarTime += barDur;
      }
    };

    this.schedule = schedule;
    this.stopScheduler = () => {
      clearInterval(this.timer);
      this.timer = 0;
    };
    this.timer = setInterval(schedule, TICK_MS);
    schedule();
  }

  /* ---------------------------- file voices --------------------------- */
  startBuffer(when, offset) {
    const { ctx } = this.engine;
    const src = ctx.createBufferSource();
    src.buffer = this.track.buffer;
    this.duration = this.track.buffer.duration;
    src.connect(this.gain);
    this.startedAt = when;
    this.offset = offset;
    src.onended = () => {
      src.disconnect();
      if (!this.finished) this.engine.onVoiceEnded(this);
    };
    src.start(when, Math.min(offset, Math.max(0, this.duration - 0.01)));
    this.source = src;
  }

  start(when, offset) {
    if (this.kind === 'file') this.startBuffer(when, offset);
    else this.startSynth(when, offset);
  }

  /* ------------------------------ teardown ---------------------------- */
  fade(to, seconds) {
    const { ctx } = this.engine;
    const g = this.gain.gain;
    const now = ctx.currentTime;
    try {
      g.cancelAndHoldAtTime(now);
    } catch {
      g.cancelScheduledValues(now);
    }
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + Math.max(0.005, seconds));
  }

  kill(after = 0.06) {
    this.finished = true;
    this.stopScheduler?.();
    clearInterval(this.timer);
    try {
      this.source?.stop();
    } catch { /* already stopped */ }
    const g = this.gain;
    setTimeout(() => {
      try {
        this.revSend.disconnect();
        this.delSend.disconnect();
        g.disconnect();
      } catch { /* noop */ }
    }, after * 1000 + 120);
  }
}

/* ==========================================================================
   Engine
   ========================================================================== */

/** A track is a live stream when the admin said so — radio has no end. */
const isStream = (track) => !!track && track.source === 'stream';

/**
 * An `http://` stream on an `https://` page is mixed content and the browser
 * refuses it outright. Most radios answer on 443 as well, so try the secure
 * spelling first; if that host has no TLS the attempt fails and the caller
 * reports it in plain words rather than leaving silence.
 */
const secureUrl = (url) => (location.protocol === 'https:' && url.startsWith('http://')
  ? `https://${url.slice(7)}`
  : url);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.voice = null;      // primary voice
    this.voices = new Set();
    this.eqName = 'warm';
    this.volume = 0.72;
    this.muted = false;
    this.state = 'idle';    // idle | loading | playing | paused
    this._listeners = new Map();
    this._endNotified = false;
  }

  /* ------------------------------ events ------------------------------ */
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this._listeners.get(evt)?.delete(fn);
  }

  emit(evt, payload) {
    this._listeners.get(evt)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[engine] "${evt}" handler failed`, err);
      }
    });
  }

  /* ------------------------------- graph ------------------------------ */
  async ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.state === 'playing') await this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API недоступна в этом браузере');
    const ctx = new Ctor({ latencyHint: 'playback' });
    this.ctx = ctx;

    this.busSum = ctx.createGain();
    this.busSum.gain.value = 1;

    /* --- tone shaping --- */
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 140;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 900;
    this.mid.Q.value = 0.9;

    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 5200;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -17;
    this.comp.knee.value = 26;
    this.comp.ratio.value = 3.4;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.26;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    this.busSum.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.comp);
    this.comp.connect(this.analyser);
    this.analyser.connect(this.master);
    this.master.connect(ctx.destination);

    /* --- reverb --- */
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulse(ctx);
    this.revIn = ctx.createGain();
    this.revIn.gain.value = 1;
    const revTone = ctx.createBiquadFilter();
    revTone.type = 'highpass';
    revTone.frequency.value = 260;
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 0.9;
    this.revIn.connect(this.convolver);
    this.convolver.connect(revTone).connect(this.revReturn).connect(this.busSum);

    /* --- ping-pong delay --- */
    this.delayIn = ctx.createGain();
    const dL = ctx.createDelay(1.5);
    const dR = ctx.createDelay(1.5);
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    const panL = ctx.createStereoPanner();
    const panR = ctx.createStereoPanner();
    panL.pan.value = -0.7;
    panR.pan.value = 0.7;
    const dampen = ctx.createBiquadFilter();
    dampen.type = 'lowpass';
    dampen.frequency.value = 2600;
    fbL.gain.value = 0.34;
    fbR.gain.value = 0.34;
    this.delayIn.connect(dL);
    dL.connect(panL).connect(this.busSum);
    dL.connect(dR);
    dR.connect(panR).connect(this.busSum);
    dR.connect(fbR).connect(dampen).connect(fbL).connect(dL);
    this.delaySet = (time) => {
      dL.delayTime.setTargetAtTime(time, ctx.currentTime, 0.05);
      dR.delayTime.setTargetAtTime(time, ctx.currentTime, 0.05);
    };

    this.setEq(this.eqName);
    this.applyGain();

    /* end-of-track watchdog (paused safely, since it reads ctx.currentTime) */
    addTask(() => this.#watchdog());

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch { /* will resume on the next gesture */ }
    }
    this.unlocked = ctx.state === 'running';
    return ctx;
  }

  /**
   * Autoplay policy can leave the context suspended. Resuming outside a user
   * gesture is rejected, so callers get a truthful answer instead of a silent
   * "playing" state that never advances.
   */
  async #unlock() {
    if (!this.ctx) return false;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch { /* blocked — the next click will get through */ }
    }
    this.unlocked = this.ctx.state === 'running';
    return this.unlocked;
  }

  #watchdog() {
    const v = this.voice;
    if (!v || this.state !== 'playing') return;
    if (v.time >= v.duration - 0.015 && !v.finished) {
      v.finished = true;
      v.stopScheduler?.();
      this.emit('ended', v.track);
    }
  }

  /**
   * A live radio stream has no end, so it can never be decoded up front:
   * `fetch()` + `arrayBuffer()` waits forever for a body that never completes,
   * and the player would sit there loading until the tab closed. A cross-origin
   * <audio> element also cannot be piped through Web Audio without CORS — once
   * connected it outputs silence.
   *
   * So a stream plays through the element itself, straight to the speakers,
   * and the graph is left alone. The trade is honest and visible: no spectrum,
   * no EQ, no seeking — the transport shows «прямой эфир» instead of a length.
   */
  #playStream(track) {
    this.playStream(track).then((ok) => {
      if (ok || this.stream !== track) return;
      /* the element refused it: autoplay policy, a dead host, a codec it does
         not know. Say so instead of sitting on a silent "playing" state. */
      this.state = 'blocked';
      this.emit('state', this.state);
    });
    return null;
  }

  /**
   * Start a URL track as a live stream and report whether the element took it.
   *
   * The state is only committed once the element confirms, because a radio can
   * fail in three different ways — the host refuses, the codec is unknown, or
   * the autoplay policy declines — and only `error` / a rejected `play()` tell
   * us which. Committing up front is what produced "the track is playing" over
   * total silence.
   *
   * @returns {Promise<boolean>}
   */
  async playStream(track) {
    /* A fresh element per attempt, and nothing is torn down until the new one
       has proved itself. Reusing one element meant a dead link silenced
       whatever was already playing: the old src was replaced before we knew the
       replacement worked. */
    const el = new Audio();
    el.preload = 'none';
    el.volume = this.muted ? 0 : this.volume;
    /* No crossOrigin attribute on purpose: it would demand CORS headers the
       radio does not send, and the element would refuse to play at all. */
    el.src = secureUrl(track.url);

    const started = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        el.removeEventListener('playing', ok);
        el.removeEventListener('loadedmetadata', ok);
        el.removeEventListener('error', bad);
        clearTimeout(timer);
        resolve(value);
      };
      const ok = () => done(true);
      const bad = () => done(false);
      el.addEventListener('playing', ok);
      el.addEventListener('loadedmetadata', ok);
      el.addEventListener('error', bad);
      /* a host that accepts the connection but never sends audio would hang
         the promise forever, leaving the transport stuck on "loading" */
      const timer = setTimeout(() => done(el.readyState >= 2), 8000);
      el.play()?.catch(bad);
    });

    if (!started) {
      try {
        el.pause();
        el.removeAttribute('src');
      } catch { /* it never got going */ }
      return false;
    }

    /* it works — now it is safe to retire whatever was sounding */
    const old = this._stream;
    this.#stopGraphVoice();
    if (old && old !== el) {
      try {
        old.pause();
        old.removeAttribute('src');
        old.load();
      } catch { /* already gone */ }
    }
    el.playbackRate = 1;
    el.addEventListener('playing', () => {
      if (this.stream && this.state !== 'playing') {
        this.state = 'playing';
        this.emit('state', this.state);
      }
    });
    this._stream = el;
    this.stream = track;
    this.voice = null;
    this._endNotified = true; /* a stream never "ends" */
    this.state = 'playing';
    this.emit('track', track);
    this.emit('state', this.state);
    return true;
  }

  #stopGraphVoice() {
    const prev = this.voice;
    if (!prev) return;
    prev.fade(0, 0.04);
    this.#forget(prev, 0.05);
  }

  #stopStream() {
    if (!this.stream) return;
    this.stream = null;
    if (!this._stream) return;
    try {
      this._stream.pause();
      this._stream.removeAttribute('src');
      this._stream.load();
    } catch { /* the element is going away anyway */ }
  }

  /** Silence whatever is sounding, graph voice or stream alike. */
  #stopVoice() {
    this.#stopStream();
    this.#stopGraphVoice();
  }

  get isLive() {
    return !!this.stream;
  }

  /* ------------------------------ transport --------------------------- */
  async play(track, { offset = 0, fade = 0.5, fadeOut = 0 } = {}) {
    if (isStream(track)) return this.#playStream(track);
    this.#stopStream();
    await this.ensure();
    const running = await this.#unlock();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const prev = this.voice;

    if (prev && fadeOut > 0) {
      prev.fade(0, fadeOut);
      const dying = prev;
      setTimeout(() => this.#forget(dying), (fadeOut + 0.25) * 1000);
    } else if (prev) {
      prev.fade(0, 0.04);
      this.#forget(prev, 0.05);
    }

    const voice = new Voice(this, track);
    this.voices.add(voice);
    voice.gain.gain.setValueAtTime(0, now);
    voice.gain.gain.linearRampToValueAtTime(1, now + Math.max(0.01, fade));
    voice.start(now, Math.max(0, Math.min(offset, Math.max(0, voice.duration - 0.05))));
    if (voice.composer) this.delaySet?.(voice.composer.beat * 0.75);

    this.voice = voice;
    this._endNotified = false;
    /* 'blocked' = the scheduler is armed but the browser froze the context */
    this.state = running ? 'playing' : 'blocked';
    this.emit('track', track);
    this.emit('state', this.state);
    return voice;
  }

  #forget(voice, fade = 0.04) {
    voice.fade(0, fade);
    voice.kill(fade);
    this.voices.delete(voice);
    if (this.voice === voice) this.voice = null;
  }

  async pause() {
    if (this.stream) {
      if (this.state !== 'playing' && this.state !== 'blocked') return;
      this._stream?.pause();
      this.state = 'paused';
      this.emit('state', this.state);
      return;
    }
    if (!this.ctx) return;
    if (this.state !== 'playing' && this.state !== 'blocked') return;
    await this.ctx.suspend();
    this.state = 'paused';
    this.emit('state', this.state);
  }

  /**
   * Build the graph and start the context on the first user gesture.
   *
   * Without this the very first ▶ pays for `new AudioContext()` plus
   * `resume()`, which is where the audio thread gets spun up — tens to a few
   * hundred ms, and on a cold sound device longer. That wait used to happen
   * *before* the UI knew playback had started, so the button looked dead and
   * people pressed it a second time, which really did pause.
   */
  async warmup() {
    /* Pre-warm only. If a voice is alive we suspended the context ourselves to
       pause, and `ctx.resume()` would hand the already-scheduled notes their
       clock back — the music would jump out of a pause on a click that had
       nothing to do with the transport. */
    if (this.voice || this.state !== 'idle') return;
    try {
      await this.ensure();
      await this.#unlock();
    } catch {
      /* a real play attempt will report whatever is actually wrong */
    }
  }

  /** @returns {Promise<boolean>} true when the context is actually running */
  async resume() {
    if (this.stream) {
      if (!this._stream) return false;
      try {
        await this._stream.play();
      } catch {
        this.state = 'blocked';
        this.emit('state', this.state);
        return false;
      }
      this.state = 'playing';
      this.emit('state', this.state);
      return true;
    }
    if (!this.ctx) return false;
    const running = await this.#unlock();
    if (this.voice) {
      this.state = running ? 'playing' : 'blocked';
      this.emit('state', this.state);
    }
    return running;
  }

  async toggle() {
    if (this.state === 'playing') return this.pause();
    return this.resume();
  }

  stop() {
    if (this.stream) {
      this.#stopStream();
      this.state = 'idle';
      this.emit('state', this.state);
      return;
    }
    if (this.voice) this.#forget(this.voice, 0.08);
    this.state = 'idle';
    this.emit('state', this.state);
  }

  async seek(time) {
    /* A live stream has no timeline to seek in — say so instead of pretending. */
    if (this.stream) return;
    const track = this.voice?.track;
    if (!track) return;
    const wasPlaying = this.state === 'playing';
    await this.play(track, { offset: time, fade: 0.02 });
    if (!wasPlaying) await this.pause();
    this.emit('seek', time);
  }

  onVoiceEnded(voice) {
    this.#forget(voice, 0.1);
    if (this.voice === voice) this.voice = null;
    if (!this.voices.size) {
      this.state = 'idle';
      this.emit('state', this.state);
    }
    if (voice === this.lastPrimary) this.emit('ended', voice.track);
  }

  /* ------------------------------- mixer ------------------------------ */
  applyGain() {
    /* a stream never enters the graph, so the element carries the level itself */
    if (this._stream) this._stream.volume = this.muted ? 0 : this.volume;
    if (!this.master) return;
    const target = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.muted = this.volume === 0 ? this.muted : false;
    this.applyGain();
  }

  setMuted(m) {
    this.muted = m;
    this.applyGain();
  }

  setEq(name) {
    this.eqName = name in EQ_PRESETS ? name : 'flat';
    if (!this.ctx) return;
    const p = EQ_PRESETS[this.eqName];
    const t = this.ctx.currentTime;
    this.low.gain.setTargetAtTime(p.low, t, 0.06);
    this.mid.gain.setTargetAtTime(p.mid, t, 0.06);
    this.high.gain.setTargetAtTime(p.high, t, 0.06);
  }

  /* ---------------------------- analysis ------------------------------ */
  /**
   * Fills and returns the frequency array (0..255 per bin).
   * The read is cached per audio frame: three consumers (hero viz, mini viz,
   * sidebar strip, background level) would otherwise pull the FFT 4x per frame.
   */
  spectrum() {
    /* Nothing is feeding the analyser while a stream plays — report "no data"
       rather than the graph's silence, so the visualizers hold still instead
       of drawing a fake spectrum. */
    if (this.stream) return null;
    if (!this.analyser) return null;
    const t = this.ctx.currentTime;
    if (t === this._fftAt && this.ctx.state === 'running') return this.freq;
    this._fftAt = t;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  /** Smoothed 0..1 energy of the low band — drives the reactive background */
  level() {
    const data = this.spectrum();
    if (!data) return 0;
    let sum = 0;
    const n = Math.min(24, data.length);
    for (let i = 0; i < n; i++) sum += data[i];
    return sum / n / 255;
  }

  async decode(arrayBuffer) {
    await this.ensure();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  /* ------------------------------ getters ----------------------------- */
  get position() {
    if (this.stream) return this._stream?.currentTime || 0;
    const v = this.voice;
    if (!v) return 0;
    return clamp(v.time, 0, v.duration || 0);
  }

  get duration() {
    /* 0 means "unknown", and for a stream it really is: there is no end */
    if (this.stream) return 0;
    return this.voice?.duration || 0;
  }

  get currentTrack() {
    if (this.stream) return this.stream;
    return this.voice?.track || null;
  }
}

export const engine = new AudioEngine();
