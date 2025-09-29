window.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const state = { playing:false, auto:false, speed:1.0, view:'catcher', follow:false };
  $('#btnPlayPause').addEventListener('click', () => {
    state.playing = !state.playing; $('#btnPlayPause').textContent = state.playing ? 'Pause' : 'Play';
  });
  $('#btnStart').addEventListener('click', () => console.log('Start clicked'));
  $('#btnPrev').addEventListener('click', () => console.log('Prev clicked'));
  $('#btnNext').addEventListener('click', () => console.log('Next clicked'));
  $('#chkAuto').addEventListener('change', (e) => (state.auto = e.target.checked));
  $('#selSpeed').addEventListener('change', (e) => (state.speed = parseFloat(e.target.value)));
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => { state.view = btn.dataset.view; console.log('view ->', state.view); });
  });
  $('#chkFollow').addEventListener('change', (e) => (state.follow = e.target.checked));

  const canvas = document.getElementById('glcanvas');
  const resize = () => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; };
  window.addEventListener('resize', resize); resize();
});