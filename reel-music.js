// Upbeat original reel music, generated live with the Web Audio API (no audio files, no licensing).
// 124 BPM, C–G–Am–F loop. Slides change every 4 beats so pictures and music stay in sync.
(() => {
  const BPM = 124, BEAT = 60 / BPM, STEP = BEAT / 4;
  const M = window.LUMusic = { enabled: true, interval: Math.round(BEAT * 4 * 1000) };
  let ctx, master, noiseBuf, timer = null, nextT = 0, step = 0, recordingDestination = null;
  const hz = n => 440 * Math.pow(2, (n - 69) / 12);
  const ROOT = [60, 55, 57, 53], TRIAD = [[0, 4, 7], [0, 4, 7], [0, 3, 7], [0, 4, 7]];
  function tone(t, n, d, type, v) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = hz(n);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.05);
  }
  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.22);
  }
  function noise(t, d, v, f) {
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; fl.type = "highpass"; fl.frequency.value = f;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    s.connect(fl); fl.connect(g); g.connect(master); s.start(t); s.stop(t + d + 0.02);
  }
  function play(i, t) {
    const bar = Math.floor(i / 16) % 4, s = i % 16, r = ROOT[bar], tri = TRIAD[bar];
    if (s % 4 === 0) kick(t);
    if (s === 4 || s === 12) noise(t, 0.14, 0.45, 1500);
    if (s % 4 === 2) noise(t, 0.05, 0.22, 7000);
    if ([0, 6, 8, 14].includes(s)) tone(t, r - 24, STEP * 3, "triangle", 0.55);
    if (s % 2 === 0) tone(t, r + 12 + tri[[0, 1, 2, 1][(s / 2) % 4]], STEP * 1.8, "square", 0.07);
    if (s === 0) tri.forEach(x => tone(t, r + x, BEAT * 3.6, "sine", 0.1));
  }
  function tick() { while (nextT < ctx.currentTime + 0.15) { play(step++, nextT); nextT += STEP; } }
  M.createRecordingDestination = async () => {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    return ctx.createMediaStreamDestination();
  };
  M.setRecordingDestination = destination => {
    if (recordingDestination && master) master.disconnect(recordingDestination);
    recordingDestination = destination;
    if (recordingDestination && master) master.connect(recordingDestination);
  };
  M.start = async () => {
    if (!M.enabled || timer) return;
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    master = ctx.createGain(); master.gain.setValueAtTime(0.0001, ctx.currentTime); master.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 0.4); master.connect(ctx.destination);
    if (recordingDestination) master.connect(recordingDestination);
    step = 0; nextT = ctx.currentTime + 0.05; timer = setInterval(tick, 25);
  };
  M.stop = () => {
    if (!timer) return; clearInterval(timer); timer = null;
    try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setValueAtTime(master.gain.value, ctx.currentTime); master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3); const m = master; setTimeout(() => { m.disconnect(); if (master === m) master = null; }, 400); } catch (e) {}
  };
})();
