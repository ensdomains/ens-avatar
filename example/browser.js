const { ethers } = require('ethers');
const { AvatarResolver } = require('../dist/index');
const { fromEthers } = require('../dist/chain/ethers');

const provider = new ethers.JsonRpcProvider(
  'https://ethereum-rpc.publicnode.com',
  'mainnet',
  { staticNetwork: true }
);
const avt = new AvatarResolver(fromEthers(provider), {
  ipfs: 'https://ipfs.io',
});

const floaterNames = [
  'achal.eth',
  'alisha.eth',
  'jefflau.eth',
  'leontalbert.eth',
  'matoken.eth',
  'nick.eth',
  'ricmoo.eth',
  'tanrikulu.eth',
  'taytems.eth',
  'validator.eth',
  'brantly.eth',
  'coinbase.eth',
  'she256.eth',
  'cory.eth',
  'avsa.eth',
  'lefteris.eth',
  'rainbowwallet.eth',
  'fireeyesdao.eth',
  'griff.eth',
  'vitalik.eth',
];

const floaters = [];
const FLOATER_SIZE = 64;
const FLOATER_RADIUS = FLOATER_SIZE / 2;
const COLLISION_DIST_SQ = FLOATER_SIZE * FLOATER_SIZE;

let logicalW = window.innerWidth;
let logicalH = window.innerHeight;
window.addEventListener('resize', () => {
  logicalW = window.innerWidth;
  logicalH = window.innerHeight;
});

function initFloaters() {
  const container = document.getElementById('floaters');

  floaterNames.forEach((name, i) => {
    const speed = 0.3 + Math.random() * 0.4;
    const angle = Math.random() * Math.PI * 2;

    const el = document.createElement('img');
    el.className = 'floater';
    el.alt = '';
    el.decoding = 'async';
    container.appendChild(el);

    const floater = {
      x: Math.random() * (logicalW - FLOATER_SIZE),
      y: Math.random() * (logicalH - FLOATER_SIZE),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      el,
    };
    floaters.push(floater);

    setTimeout(() => {
      avt
        .getAvatar(name)
        .then((avatar) => {
          if (!avatar) return;
          el.src = avatar;
          el.onload = () => el.classList.add('visible');
        })
        .catch(() => {});
    }, i * 150);
  });

  requestAnimationFrame(animateFloaters);
}

const TARGET_DT = 1000 / 60;
let lastTime = 0;

function animateFloaters(now) {
  const rawDt = now - lastTime;
  lastTime = now;
  const dt = rawDt > 0 && rawDt < 100 ? rawDt / TARGET_DT : 1;

  const w = logicalW;
  const h = logicalH;
  const len = floaters.length;

  for (let i = 0; i < len; i++) {
    const f = floaters[i];
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    if (f.x <= 0) { f.x = 0; f.vx *= -1; }
    if (f.y <= 0) { f.y = 0; f.vy *= -1; }
    if (f.x + FLOATER_SIZE >= w) { f.x = w - FLOATER_SIZE; f.vx *= -1; }
    if (f.y + FLOATER_SIZE >= h) { f.y = h - FLOATER_SIZE; f.vy *= -1; }
  }

  for (let i = 0; i < len; i++) {
    const a = floaters[i];
    const ax = a.x + FLOATER_RADIUS;
    const ay = a.y + FLOATER_RADIUS;
    for (let j = i + 1; j < len; j++) {
      const b = floaters[j];
      const dx = (b.x + FLOATER_RADIUS) - ax;
      const dy = (b.y + FLOATER_RADIUS) - ay;
      const distSq = dx * dx + dy * dy;

      if (distSq < COLLISION_DIST_SQ && distSq > 0) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const ny = dy / dist;

        const dot = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (dot > 0) {
          a.vx -= dot * nx;
          a.vy -= dot * ny;
          b.vx += dot * nx;
          b.vy += dot * ny;
        }

        const overlap = (FLOATER_SIZE - dist) / 2;
        a.x -= overlap * nx;
        a.y -= overlap * ny;
        b.x += overlap * nx;
        b.y += overlap * ny;
      }
    }
  }

  for (let i = 0; i < len; i++) {
    const f = floaters[i];
    f.el.style.transform = `translate3d(${f.x}px,${f.y}px,0)`;
  }

  requestAnimationFrame(animateFloaters);
}

const front = document.querySelector('.avatar-front');
const back = document.querySelector('.avatar-back');
const loading = document.querySelector('.avatar-loading');
const ensNameEl = document.querySelector('.ens-name');
const status = document.getElementById('status');
const input = document.getElementById('searchInput');

const profile = document.getElementById('profile');
const bannerContainer = document.getElementById('bannerContainer');
const bannerFront = document.querySelector('.banner-front');
const bannerBack = document.querySelector('.banner-back');

let activeSide = 'front';
let bannerActiveSide = 'front';

function setStatus(text, isError) {
  status.textContent = text;
  status.classList.toggle('error', !!isError);
}

function showLoading() {
  loading.classList.add('visible');
  setStatus('Resolving...');
}

function hideLoading() {
  loading.classList.remove('visible');
}

function crossfade(src, name) {
  return new Promise((resolve) => {
    const incoming = activeSide === 'front' ? back : front;
    const outgoing = activeSide === 'front' ? front : back;

    incoming.onload = () => {
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      activeSide = activeSide === 'front' ? 'back' : 'front';
      ensNameEl.textContent = name;
      ensNameEl.classList.add('visible');
      resolve();
    };

    incoming.onerror = () => {
      resolve();
    };

    incoming.src = src;
  });
}

function crossfadeBanner(src) {
  return new Promise((resolve) => {
    const incoming = bannerActiveSide === 'front' ? bannerBack : bannerFront;
    const outgoing = bannerActiveSide === 'front' ? bannerFront : bannerBack;

    incoming.onload = () => {
      bannerContainer.classList.add('visible');
      profile.classList.add('has-banner');
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      bannerActiveSide = bannerActiveSide === 'front' ? 'back' : 'front';
      resolve();
    };

    incoming.onerror = () => {
      resolve();
    };

    incoming.src = src;
  });
}

function hideBanner() {
  profile.classList.remove('has-banner');
  bannerContainer.classList.remove('visible');
  bannerFront.classList.remove('active');
  bannerBack.classList.remove('active');
}

async function resolveAvatar(name) {
  showLoading();
  try {
    const [avatar, header] = await Promise.all([
      avt.getAvatar(name),
      avt.getHeader(name).catch(() => null),
    ]);
    hideLoading();

    if (!avatar) {
      setStatus('No avatar found', true);
      return;
    }

    if (header) {
      crossfadeBanner(header);
    } else {
      hideBanner();
    }

    await crossfade(avatar, name);
    setStatus('');
  } catch (err) {
    hideLoading();
    console.warn(err);
    setStatus(`Could not resolve avatar for ${name}`, true);
  }
}

input.addEventListener('change', (event) => {
  const name = event.target.value.toLowerCase().trim();
  if (!name) return;
  resolveAvatar(name);
});

const defaultName = floaterNames[Math.floor(Math.random() * floaterNames.length)];
resolveAvatar(defaultName);
initFloaters();
