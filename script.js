/* HHL Check-in Timer
 * Vanilla JS / Web Audio API / 外部依存なし
 *
 * 設計メモ:
 *  - 表示更新は requestAnimationFrame + performance.now() で時間ズレを補正
 *  - 音は AudioContext.currentTime に対して「フェーズ開始時に全イベントを事前スケジュール」
 *    することで、rAFの揺らぎや初回出力の遅延の影響を受けず、ベル・チクタクが
 *    オーディオスレッド上で正確に発火する（5→4の間隔ブレ対策）
 *  - 音は Start ボタン押下時に AudioContext を生成（iOS Safari の autoplay 制約対応）
 *  - finished 到達時は rAF 停止 + AudioContext.close() で完全に静止状態に落とし、
 *    タブを開きっぱなしでも電力・通信を消費しない
 *  - 外部リソース読み込みなし（GitHub Pages 公開後も初回ロード以降の通信ゼロ）
 */

(() => {
  'use strict';

  // ===== 状態 =====
  const state = {
    participants: 18,
    speakingTime: 50,
    intervalTime: 10,
    currentIndex: 0,
    phase: 'waiting',         // waiting | speaking | interval | paused | finished
    prevPhase: null,
    phaseEndAt: 0,            // performance.now() 基準
    pausedRemainingMs: null,
    isRunning: false,
    muted: false,
    rafId: null,
  };

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const els = {
    participants:  $('participants'),
    totalDuration: $('totalDuration'),
    remaining:     $('remaining'),
    status:        $('status'),
    progress:      $('progress'),
    totalRem:      $('totalRemaining'),
    btnStart:      $('btnStart'),
    btnPause:      $('btnPause'),
    btnResume:     $('btnResume'),
    btnReset:      $('btnReset'),
    btnMute:       $('btnMute'),
    settings:      $('settings'),
  };

  // ===== Web Audio =====
  let audioCtx = null;
  let masterGain = null;
  let scheduledOscs = []; // 事前スケジュールしたオシレータ（pause時にcancel）

  function ensureAudio() {
    // ユーザー操作の同期コールバック内で呼ぶこと（iOS制約）
    if (audioCtx && audioCtx.state !== 'closed') {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = state.muted ? 0 : 1;
      masterGain.connect(audioCtx.destination);
    } catch (_) {
      audioCtx = null;
      masterGain = null;
    }
  }

  function closeAudio() {
    cancelScheduledAudio();
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch (_) {}
    }
    audioCtx = null;
    masterGain = null;
  }

  // 単音を at（audioCtx基準秒）で発火するようスケジュール
  function scheduleTone({ at, freq, duration, type, gain, attack = 0.005, release = 0.12 }) {
    if (!audioCtx || !masterGain) return;
    try {
      const startAt = Math.max(at, audioCtx.currentTime + 0.001);
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startAt);
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(gain, startAt + attack);
      g.gain.linearRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(g).connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + release);
      scheduledOscs.push(osc);
      osc.onended = () => {
        const i = scheduledOscs.indexOf(osc);
        if (i !== -1) scheduledOscs.splice(i, 1);
      };
    } catch (_) { /* 音は失敗してもタイマーは継続 */ }
  }

  // 鐘の音：長めに余韻を残して指数減衰（「チーン」と響く）
  function scheduleBellInternal(at, harmonics, totalDur) {
    if (!audioCtx || !masterGain) return;
    const startAt = Math.max(at, audioCtx.currentTime + 0.001);
    try {
      for (const h of harmonics) {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(h.freq, startAt);
        g.gain.setValueAtTime(0.0001, startAt);
        g.gain.linearRampToValueAtTime(h.gain, startAt + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, startAt + totalDur);
        osc.connect(g).connect(masterGain);
        osc.start(startAt);
        osc.stop(startAt + totalDur + 0.05);
        scheduledOscs.push(osc);
        osc.onended = () => {
          const i = scheduledOscs.indexOf(osc);
          if (i !== -1) scheduledOscs.splice(i, 1);
        };
      }
    } catch (_) {}
  }

  function scheduleBell(at) {
    scheduleBellInternal(at, [
      { freq: 880,  gain: 0.22 },
      { freq: 1320, gain: 0.10 },
      { freq: 1760, gain: 0.05 },
    ], 1.6);
  }

  function scheduleFinishBell(at) {
    scheduleBellInternal(at, [
      { freq: 660,  gain: 0.22 },
      { freq: 990,  gain: 0.12 },
      { freq: 1320, gain: 0.07 },
    ], 2.6);
  }

  function scheduleTick(at) {
    scheduleTone({ at, freq: 1500, duration: 0.04, type: 'square', gain: 0.06, attack: 0.001, release: 0.02 });
  }

  function cancelScheduledAudio() {
    for (const osc of scheduledOscs) {
      try { osc.stop(); } catch (_) {}
    }
    scheduledOscs = [];
  }

  // 出力デバイスの遅延（Bluetoothスピーカ等で 100〜500ms 出ることがある）
  function getOutputLatencySec() {
    if (!audioCtx) return 0;
    const lat = audioCtx.outputLatency;
    return (typeof lat === 'number' && isFinite(lat) && lat > 0) ? lat : 0;
  }

  // フェーズの音を一括スケジュール
  // remainSec: このフェーズの残り時間（秒、フレッシュ開始時はフルの長さ、resume時は残り）
  // includeStartBell: フレッシュ開始時のみ true（speakingでベル）
  // isLastSpeaker: 最終発表者なら true（speaking終了時にfinishベル）
  // 視覚（rAF）と音声（AudioContext）の出力遅延を補正：音は outputLatency 分だけ早めにスケジュールし、
  // 実際にスピーカから鳴る瞬間を「視覚上の offset」に合わせる
  function schedulePhaseAudio(phase, remainSec, includeStartBell, isLastSpeaker) {
    if (!audioCtx) return;
    const lat = getOutputLatencySec();
    const safety = 0.005;
    const anchor = audioCtx.currentTime; // この瞬間を視覚上のフェーズ開始時刻と同期させる
    const heardAt = (offset) => Math.max(anchor + offset - lat, audioCtx.currentTime + safety);

    if (phase === 'speaking') {
      if (includeStartBell) scheduleBell(heardAt(0));
      // 残り 5,4,3,2,1 秒のチクタク（数字が「6→5」に切り替わった瞬間に1個目）
      for (let r = 5; r >= 1; r--) {
        const offset = remainSec - r;
        if (offset >= -0.001) scheduleTick(heardAt(offset));
      }
      // 終了ベル（最終発表者なら finish ベル）
      if (isLastSpeaker) {
        scheduleFinishBell(heardAt(remainSec));
      } else {
        scheduleBell(heardAt(remainSec));
      }
    } else if (phase === 'interval') {
      // インターバル開始（offset=0）から毎秒チクタク：5s設定なら 4,3,2,1 で4回
      const startR = Math.floor(remainSec + 0.001);
      for (let r = startR; r >= 1; r--) {
        const offset = remainSec - r;
        if (offset >= -0.001) scheduleTick(heardAt(offset));
      }
      // インターバル終了時のベルは「次の speaking の開始ベル」が担う
    }
  }

  // ===== 入力読み取り =====
  function readSpeaking()  { const r = document.querySelector('input[name="speaking"]:checked');  return r ? +r.value : 50; }
  function readInterval()  { const r = document.querySelector('input[name="interval"]:checked');  return r ? +r.value : 10; }
  function readParticipants() {
    const v = els.participants.value.trim();
    if (v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  }

  function isValidInput() {
    return readParticipants() !== null;
  }

  // ===== 整形 =====
  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function formatDuration(sec) {
    // メインカウントダウンが Math.ceil(ms/1000) で表示しているので、Total: 表示も ceil で同期
    sec = Math.max(0, Math.ceil(sec));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  // 実効インターバル：UIで「5s」と表示していても実際の待ち時間は 4s（5,4,3,2,1ではなく4,3,2,1で鳴る仕様）
  function effectiveInterval(iv) {
    return Math.max(0, iv - 1);
  }

  function calcTotalSec(p, sp, iv) {
    if (!p || p < 1) return 0;
    return p * sp + Math.max(0, p - 1) * effectiveInterval(iv);
  }

  // ===== 表示更新 =====
  function updateTotalDurationDisplay() {
    const p = readParticipants();
    const sp = readSpeaking();
    const iv = readInterval();
    if (p === null) {
      els.totalDuration.textContent = '--';
    } else {
      els.totalDuration.textContent = formatDuration(calcTotalSec(p, sp, iv));
    }
    els.btnStart.disabled = !isValidInput() || state.isRunning || state.phase === 'paused';
  }

  function setPhase(phase) {
    state.phase = phase;
    document.body.dataset.phase = phase;
    els.status.textContent = phase;
  }

  function updateProgress() {
    const p = state.participants || 0;
    const i = state.phase === 'waiting' ? 0 : Math.min(state.currentIndex + 1, p);
    els.progress.textContent = `${i} / ${p}`;
  }

  function updateRemainingDisplay(ms) {
    els.remaining.textContent = formatTime(ms);
  }

  function calcTotalRemainingMs(now) {
    if (state.phase === 'waiting') {
      return calcTotalSec(state.participants, state.speakingTime, state.intervalTime) * 1000;
    }
    if (state.phase === 'finished') return 0;

    const phaseRemain = state.phase === 'paused'
      ? (state.pausedRemainingMs ?? 0)
      : Math.max(0, state.phaseEndAt - now);

    const inSpeaking = (state.phase === 'speaking') || (state.phase === 'paused' && state.prevPhase === 'speaking');
    const idx = state.currentIndex;

    let future = 0;
    const effIv = effectiveInterval(state.intervalTime);
    if (inSpeaking) {
      const remainingSpeakersAfter = state.participants - idx - 1;
      if (remainingSpeakersAfter > 0) {
        future += effIv * 1000;
        future += (remainingSpeakersAfter - 1) * (state.speakingTime + effIv) * 1000;
        future += state.speakingTime * 1000;
      }
    } else {
      const remainingSpeakersAfter = state.participants - idx - 1;
      if (remainingSpeakersAfter > 0) {
        future += state.speakingTime * 1000;
        future += (remainingSpeakersAfter - 1) * (effIv + state.speakingTime) * 1000;
      }
    }
    return phaseRemain + future;
  }

  function updateTotalRemainingDisplay(now) {
    const ms = calcTotalRemainingMs(now);
    els.totalRem.textContent = `Total: ${formatDuration(ms / 1000)}`;
  }

  // ===== 表示用 rAF ループ（音のスケジュールは含まない） =====
  function tickFrame() {
    state.rafId = null;
    const now = performance.now();
    const remain = state.phaseEndAt - now;

    updateRemainingDisplay(remain);
    updateTotalRemainingDisplay(now);

    if (remain <= 0) {
      handlePhaseEnd();
      return;
    }
    scheduleFrame();
  }

  function scheduleFrame() {
    if (document.hidden) return; // 非表示中は止めて省電力
    if (state.rafId !== null) return;
    state.rafId = requestAnimationFrame(tickFrame);
  }

  function cancelFrame() {
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  // ===== フェーズ遷移 =====
  function startSpeaking(index) {
    state.currentIndex = index;
    setPhase('speaking');
    state.phaseEndAt = performance.now() + state.speakingTime * 1000;
    updateProgress();
    const isLast = index >= state.participants - 1;
    schedulePhaseAudio('speaking', state.speakingTime, true, isLast);
    scheduleFrame();
  }

  function startInterval() {
    // 「Interval 5s」設定でも実際の待ち時間は 4s（カウントダウン 4,3,2,1 で次のbell）
    const effIv = effectiveInterval(state.intervalTime);
    if (effIv <= 0) {
      // 念のための保険：実効インターバル 0 ならインターバルをスキップ
      startSpeaking(state.currentIndex + 1);
      return;
    }
    setPhase('interval');
    state.phaseEndAt = performance.now() + effIv * 1000;
    schedulePhaseAudio('interval', effIv, false, false);
    scheduleFrame();
  }

  function handlePhaseEnd() {
    if (state.phase === 'speaking') {
      const isLast = state.currentIndex >= state.participants - 1;
      if (isLast) {
        finishAll();
      } else {
        startInterval();
      }
    } else if (state.phase === 'interval') {
      startSpeaking(state.currentIndex + 1);
    }
  }

  function finishAll() {
    cancelFrame();
    setPhase('finished');
    updateRemainingDisplay(0);
    els.totalRem.textContent = 'Total: done';
    state.isRunning = false;
    // finish ベルは speaking フェーズの最後にスケジュール済み（2.6s 余韻）。鳴り終わってから AudioContext を解放
    setTimeout(() => { closeAudio(); }, 3000);
    document.removeEventListener('visibilitychange', onVisibilityChange);

    els.btnPause.disabled = true;
    els.btnResume.disabled = true;
    els.btnReset.disabled = false;
    els.btnStart.disabled = true;
  }

  // ===== ボタン =====
  function onStart() {
    if (!isValidInput()) return;

    state.participants = readParticipants();
    state.speakingTime = readSpeaking();
    state.intervalTime = readInterval();
    state.currentIndex = 0;
    state.isRunning = true;
    state.pausedRemainingMs = null;
    state.prevPhase = null;

    els.settings.classList.add('is-locked');
    els.btnStart.disabled = true;
    els.btnPause.disabled = false;
    els.btnResume.disabled = true;
    els.btnReset.disabled = false;

    ensureAudio();
    document.addEventListener('visibilitychange', onVisibilityChange);

    startSpeaking(0);
  }

  function onPause() {
    if (state.phase !== 'speaking' && state.phase !== 'interval') return;
    cancelFrame();
    cancelScheduledAudio(); // 事前スケジュールした以後の音を中断
    state.pausedRemainingMs = Math.max(0, state.phaseEndAt - performance.now());
    state.prevPhase = state.phase;
    setPhase('paused');
    updateRemainingDisplay(state.pausedRemainingMs);

    els.btnPause.disabled = true;
    els.btnResume.disabled = false;
  }

  function onResume() {
    if (state.phase !== 'paused' || state.pausedRemainingMs === null) return;
    ensureAudio();
    state.phaseEndAt = performance.now() + state.pausedRemainingMs;
    const resumePhase = state.prevPhase || 'speaking';
    setPhase(resumePhase);
    // 残り時間に応じて音を再スケジュール（開始ベルは鳴らさない）
    const remainSec = state.pausedRemainingMs / 1000;
    const isLast = state.currentIndex >= state.participants - 1;
    schedulePhaseAudio(resumePhase, remainSec, false, isLast);
    state.pausedRemainingMs = null;
    state.prevPhase = null;

    els.btnPause.disabled = false;
    els.btnResume.disabled = true;
    scheduleFrame();
  }

  function onReset() {
    cancelFrame();
    cancelScheduledAudio();
    closeAudio();
    document.removeEventListener('visibilitychange', onVisibilityChange);

    state.currentIndex = 0;
    state.phase = 'waiting';
    state.prevPhase = null;
    state.pausedRemainingMs = null;
    state.isRunning = false;

    setPhase('waiting');
    els.settings.classList.remove('is-locked');
    els.remaining.textContent = '--:--';
    updateProgress();
    updateTotalDurationDisplay();
    els.totalRem.textContent = `Total: ${formatDuration(calcTotalSec(readParticipants() || 0, readSpeaking(), readInterval()))}`;

    els.btnStart.disabled = !isValidInput();
    els.btnPause.disabled = true;
    els.btnResume.disabled = true;
    els.btnReset.disabled = true;
  }

  function onMuteToggle() {
    state.muted = !state.muted;
    els.btnMute.textContent = state.muted ? 'Sound: Off' : 'Sound: On';
    els.btnMute.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    // master gain をリアルタイムに切替（事前スケジュールされた音にも即時反映）
    if (masterGain && audioCtx) {
      const t = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setValueAtTime(state.muted ? 0 : 1, t);
    }
  }

  // スペースキーで Start / Pause / Resume を切替
  // 入力欄にフォーカスがあるときは無視（人数入力中の誤発火を防ぐ）
  function onKeyDown(e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.repeat) { e.preventDefault(); return; }
    e.preventDefault();
    if (state.phase === 'waiting') {
      if (isValidInput()) onStart();
    } else if (state.phase === 'speaking' || state.phase === 'interval') {
      onPause();
    } else if (state.phase === 'paused') {
      onResume();
    }
    // finished のときは何もしない
  }

  // タブ非表示時は rAF を止める（実時間進行は維持。音は事前スケジュール済みなので影響なし）
  function onVisibilityChange() {
    if (document.hidden) {
      cancelFrame();
    } else {
      if (state.phase === 'speaking' || state.phase === 'interval') {
        scheduleFrame();
      }
    }
  }

  // ===== 初期化 =====
  function init() {
    els.participants.addEventListener('input', updateTotalDurationDisplay);
    document.querySelectorAll('input[name="speaking"]').forEach(r =>
      r.addEventListener('change', updateTotalDurationDisplay));
    document.querySelectorAll('input[name="interval"]').forEach(r =>
      r.addEventListener('change', updateTotalDurationDisplay));

    els.btnStart.addEventListener('click', onStart);
    els.btnPause.addEventListener('click', onPause);
    els.btnResume.addEventListener('click', onResume);
    els.btnReset.addEventListener('click', onReset);
    els.btnMute.addEventListener('click', onMuteToggle);

    // スペースキーで Start / Pause / Resume
    document.addEventListener('keydown', onKeyDown);

    setPhase('waiting');
    state.participants = readParticipants() || 18;
    state.speakingTime = readSpeaking();
    state.intervalTime = readInterval();
    updateProgress();
    updateTotalDurationDisplay();
    els.totalRem.textContent = `Total: ${formatDuration(calcTotalSec(state.participants, state.speakingTime, state.intervalTime))}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
