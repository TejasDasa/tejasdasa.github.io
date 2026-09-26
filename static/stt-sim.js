// STT simulator: drives the server-rendered markup from the WASM build of
// crates/emulator. Everything the page shows comes from the emulator.
import init, { Sim } from "/static/wasm/stt_sim.js";

const PX_PER_CYCLE = 18;
const WINDOW = 96; // cycles shown in the waveform

for (const fig of document.querySelectorAll("figure.sim")) start(fig);

async function start(fig) {
  try {
    await init("/static/wasm/stt_sim_bg.wasm");
  } catch (e) {
    fig.querySelector(".sim-last").textContent = `simulator failed to load: ${e}`;
    return;
  }
  const form = fig.querySelector(".sim-controls");
  const f = form.elements;
  const tbody = fig.querySelector(".sim-program tbody");
  const state = fig.querySelector(".sim-state");
  const last = fig.querySelector(".sim-last");
  const wave = fig.querySelector(".sim-wave");
  const runBtn = form.querySelector('[data-act="run"]');
  let sim = null;
  let running = false;
  let frame = 0;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function build() {
    stop();
    const preset = f.preset.value;
    fig.dataset.preset = preset;
    try {
      sim = new Sim(preset, Number(f.period.value) || 4, f.tx.value, f.replies.value, f.target.checked);
    } catch (e) {
      last.textContent = String(e.message || e);
      sim = null;
      return;
    }
    const rows = JSON.parse(sim.program_json());
    tbody.innerHTML = rows
      .map((r) => `<tr><td>${r.i}</td><td>${esc(r.name)}</td><td><code>${r.word}</code></td><td>${r.test}</td><td>${r.mode}</td><td>${esc(r.exits)}</td><td>${esc(r.actions)}</td><td>${esc(r.pin)}</td></tr>`)
      .join("");
    draw();
  }

  function draw() {
    if (!sim) return;
    const row = sim.row();
    tbody.querySelectorAll("tr").forEach((tr, i) => tr.classList.toggle("sim-cur", i === row));
    const s = JSON.parse(sim.state_json());
    state.innerHTML = s.state.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v) || "·"}</dd>`).join("");
    last.textContent = s.last;
    try {
      sim.render(WINDOW, PX_PER_CYCLE);
    } catch (e) {
      last.textContent = String(e.message || e);
      return;
    }
    const scroll = wave.querySelector(".wv-scroll");
    wave.querySelector(".wv-labels")?.remove();
    const labels = sim.labels();
    if (labels) wave.insertAdjacentHTML("afterbegin", labels);
    scroll.innerHTML = sim.waves();
    scroll.scrollLeft = scroll.scrollWidth;
  }

  function step(n) {
    if (!sim) build();
    if (!sim) return;
    sim.step(n);
    draw();
  }

  function loop() {
    if (!running) return;
    step(Number(f.speed.value));
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    runBtn.setAttribute("aria-pressed", "false");
    runBtn.textContent = "run";
  }

  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "reset") build();
    else if (act === "step") { stop(); step(1); }
    else if (act === "step10") { stop(); step(10); }
    else if (act === "run") {
      if (running) stop();
      else {
        running = true;
        runBtn.setAttribute("aria-pressed", "true");
        runBtn.textContent = "pause";
        loop();
      }
    }
  });
  // Changing the program or its configuration rebuilds from reset.
  for (const name of ["preset", "period", "tx", "replies", "target"]) {
    f[name].addEventListener("change", build);
  }

  form.querySelector("fieldset").disabled = false;
  build();
  // Match the server snapshot, so enabling JS doesn't change what is shown.
  step(Number(fig.dataset.snapshot) || 0);
}
